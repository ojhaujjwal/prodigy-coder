import { Crypto, DateTime, Effect, Layer, Option, PartitionedSemaphore, Schema } from "effect";
import * as FileSystem from "effect/FileSystem";
import {
  SessionConflict,
  SessionDecodeFailure,
  SessionEncodeFailure,
  SessionLookupError,
  SessionNotFound,
  SessionPersistenceError,
  SessionReadFailure,
  SessionStore,
  SessionWriteFailure,
  SessionQueryError
} from "./session-store.ts";
import {
  Session,
  SessionRevision,
  SessionId,
  generateSessionId,
  type Message,
  type SessionCheckpoint,
  type SessionInitial,
  type SessionSnapshot,
  type SessionSummary
} from "./session.ts";

const SESSION_FORMAT_VERSION = 1;

/** The on-disk envelope: the storage format version, the concurrency revision, and the session record. */
const PersistedSession = Schema.Struct({
  formatVersion: Schema.Literal(SESSION_FORMAT_VERSION),
  revision: SessionRevision,
  session: Session
});
type PersistedSession = Schema.Schema.Type<typeof PersistedSession>;

/** Hex-encode bytes without a Node global (used for unique temp-file names). */
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * Read and decode the persisted envelope for `id`, treating a missing file as
 * `Option.none`. A read I/O failure becomes `SessionReadFailure`; a malformed,
 * unsupported-version, or undecodable record becomes `SessionDecodeFailure`.
 */
const readEnvelope = (
  fs: FileSystem.FileSystem,
  id: SessionId,
  path: string
): Effect.Effect<Option.Option<PersistedSession>, SessionReadFailure | SessionDecodeFailure> =>
  Effect.gen(function* () {
    const content = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none())
            : Effect.fail(new SessionReadFailure({ id, cause: error })),
        onSuccess: (value) => Effect.succeed(Option.some(value))
      })
    );
    if (Option.isNone(content)) {
      return Option.none();
    }
    const persisted = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistedSession))(content.value).pipe(
      Effect.mapError((cause) => new SessionDecodeFailure({ id, cause }))
    );
    return Option.some(persisted);
  });

const make = (sessionDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const saveLocks = yield* PartitionedSemaphore.make<SessionId>({ permits: 1 });

    const sessionPath = (id: SessionId): string => `${sessionDir}/${id}.json`;

    const create = Effect.fn("FileSessionStore.create")(function* (
      initial: SessionInitial
    ): Effect.fn.Return<SessionSnapshot, SessionPersistenceError> {
      const id = yield* generateSessionId.pipe(Effect.provideService(Crypto.Crypto, crypto));
      const timestamp = yield* DateTime.now;
      const messages: Message[] =
        initial.systemPrompt === undefined ? [] : [{ role: "system", content: initial.systemPrompt }];
      const session: Session = { id, messages, createdAt: timestamp, updatedAt: timestamp };
      return { session, revision: SessionRevision.make(0) };
    });

    const load = Effect.fn("FileSessionStore.load")(function* (
      id: SessionId
    ): Effect.fn.Return<SessionSnapshot, SessionLookupError> {
      const current = yield* readEnvelope(fs, id, sessionPath(id)).pipe(
        Effect.mapError((reason) => new SessionLookupError({ reason }))
      );
      if (Option.isNone(current)) {
        return yield* new SessionLookupError({ reason: new SessionNotFound({ id }) });
      }
      const record = current.value.session;
      if (record.id !== id) {
        return yield* new SessionLookupError({
          reason: new SessionDecodeFailure({
            id,
            cause: new Error(`Stored session id ${record.id} does not match the requested id ${id}`)
          })
        });
      }
      return { session: record, revision: current.value.revision };
    });

    const saveUnlocked = Effect.fn("FileSessionStore.save")(function* (
      checkpoint: SessionCheckpoint
    ): Effect.fn.Return<SessionSnapshot, SessionPersistenceError> {
      const { session, expectedRevision } = checkpoint;
      const id = session.id;

      yield* fs
        .makeDirectory(sessionDir, { recursive: true })
        .pipe(
          Effect.mapError((cause) => new SessionPersistenceError({ reason: new SessionWriteFailure({ id, cause }) }))
        );

      const current = yield* readEnvelope(fs, id, sessionPath(id)).pipe(
        Effect.mapError((reason) => new SessionPersistenceError({ reason }))
      );
      const currentRevision = current.pipe(
        Option.map((record) => record.revision),
        Option.getOrElse(() => SessionRevision.make(0))
      );
      if (currentRevision !== expectedRevision) {
        return yield* new SessionPersistenceError({ reason: new SessionConflict({ id }) });
      }

      const updatedSession: Session = { ...session, updatedAt: yield* DateTime.now };
      const nextRevision = SessionRevision.make(currentRevision + 1);
      const persisted: PersistedSession = {
        formatVersion: SESSION_FORMAT_VERSION,
        revision: nextRevision,
        session: updatedSession
      };

      const json = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(PersistedSession))(persisted).pipe(
        Effect.mapError((cause) => new SessionPersistenceError({ reason: new SessionEncodeFailure({ id, cause }) }))
      );

      const suffix = yield* crypto.randomBytes(4).pipe(Effect.orDie);
      const tempPath = `${sessionDir}/.${id}.tmp-${toHex(suffix)}`;

      // Atomic save
      // Step 1: Write to a unique temp file in the same directory
      yield* fs
        .writeFileString(tempPath, json)
        .pipe(
          Effect.mapError((cause) => new SessionPersistenceError({ reason: new SessionWriteFailure({ id, cause }) }))
        );

      // Atomic save
      // Step 2: Rename the temp file to the final session file path
      yield* fs
        .rename(tempPath, sessionPath(id))
        .pipe(
          Effect.mapError((cause) => new SessionPersistenceError({ reason: new SessionWriteFailure({ id, cause }) }))
        );

      return { session: updatedSession, revision: nextRevision };
    });

    const save = (checkpoint: SessionCheckpoint) =>
      saveLocks.withPermit(checkpoint.session.id)(saveUnlocked(checkpoint));

    const list = Effect.fn("FileSessionStore.list")(function* (): Effect.fn.Return<
      ReadonlyArray<SessionSummary>,
      SessionQueryError
    > {
      yield* fs
        .makeDirectory(sessionDir, { recursive: true })
        .pipe(Effect.mapError((cause) => new SessionQueryError({ cause })));
      const entries = yield* fs
        .readDirectory(sessionDir)
        .pipe(Effect.mapError((cause) => new SessionQueryError({ cause })));
      const jsonEntries = entries.filter((value) => value.endsWith(".json"));
      const results = yield* Effect.forEach(
        jsonEntries,
        (entry) =>
          Effect.gen(function* () {
            const id = Schema.decodeUnknownOption(SessionId)(entry.slice(0, -5));
            if (Option.isNone(id)) return Option.none<SessionSummary>();
            const record = yield* readEnvelope(fs, id.value, sessionPath(id.value)).pipe(
              Effect.option,
              Effect.map(Option.flatten)
            );
            if (Option.isNone(record)) return Option.none<SessionSummary>();
            return Option.some({
              id: record.value.session.id,
              createdAt: record.value.session.createdAt,
              updatedAt: record.value.session.updatedAt
            });
          }),
        { concurrency: 8 }
      );
      const summaries = results.filter(Option.isSome).map((option) => option.value);
      return summaries.sort((left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds);
    });

    const deleteSession = Effect.fn("FileSessionStore.delete")(function* (
      id: SessionId
    ): Effect.fn.Return<void, SessionPersistenceError> {
      yield* saveLocks
        .withPermit(id)(fs.remove(sessionPath(id)))
        .pipe(
          Effect.catch((error) => (error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error))),
          Effect.mapError((cause) => new SessionPersistenceError({ reason: new SessionWriteFailure({ id, cause }) }))
        );
    });

    return { create, load, save, list, delete: deleteSession };
  });

/**
 * The file-backed `SessionStore` layer for the given directory, dependency-
 * preserving: it requires the `FileSystem` service (disk) and the `Crypto`
 * service (fresh `SessionId`s), and uses the `Clock` service (timestamps; a
 * defaulted reference, so it needs no provider).
 *
 * Persists each committed revision as a `PersistedSession` envelope
 * (`formatVersion`, `revision`, `session`) written atomically via a temp file
 * plus rename. Saves are serialized per session within this layer instance so
 * the revision check and replacement form one compare-and-set operation. A
 * session is durable only after its first successful `save`; separate
 * processes must use a single-writer-per-session deployment contract.
 */
export const layer = (sessionDir: string) => Layer.effect(SessionStore, make(sessionDir));
