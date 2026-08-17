import { Clock, Crypto, Effect, Layer, Option, Schema } from "effect";
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
  SessionWriteFailure
} from "./session-store.ts";
import {
  Session,
  SessionRevision,
  generateSessionId,
  type Message,
  type SessionCheckpoint,
  type SessionId,
  type SessionInitial,
  type SessionSnapshot
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
    const clock = yield* Clock.Clock;
    const crypto = yield* Crypto.Crypto;

    const sessionPath = (id: SessionId): string => `${sessionDir}/${id}.json`;

    const create = Effect.fn("FileSessionStore.create")(function* (
      initial: SessionInitial
    ): Effect.fn.Return<SessionSnapshot, SessionPersistenceError> {
      const id = yield* generateSessionId.pipe(Effect.provideService(Crypto.Crypto, crypto));
      const now = yield* clock.currentTimeMillis;
      const timestamp = new Date(now);
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

    const save = Effect.fn("FileSessionStore.save")(function* (
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

      const now = yield* clock.currentTimeMillis;
      const updatedSession: Session = { ...session, updatedAt: new Date(now) };
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

    return { create, load, save };
  });

/**
 * The file-backed `SessionStore` layer for the given directory, dependency-
 * preserving: it requires the `FileSystem` service (disk) and the `Crypto`
 * service (fresh `SessionId`s), and uses the `Clock` service (timestamps; a
 * defaulted reference, so it needs no provider).
 *
 * Persists each committed revision as a `PersistedSession` envelope
 * (`formatVersion`, `revision`, `session`) written atomically via a temp file
 * plus rename. A session is durable only after its first successful `save`.
 */
export const layer = (sessionDir: string) => Layer.effect(SessionStore, make(sessionDir));
