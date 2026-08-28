import { Crypto, DateTime, Effect, HashMap, Layer, Option, Ref } from "effect";
import {
  SessionConflict,
  SessionLookupError,
  SessionNotFound,
  SessionPersistenceError,
  SessionQueryError,
  SessionStore
} from "./session-store.ts";
import {
  SessionRevision,
  Session,
  generateSessionId,
  type Message,
  type SessionCheckpoint,
  type SessionId,
  type SessionInitial,
  type SessionSnapshot,
  type SessionSummary
} from "./session.ts";

type SessionEntry = {
  readonly session: Session;
  readonly revision: SessionRevision;
};

type SaveOutcome =
  | { readonly _tag: "conflict"; readonly error: SessionPersistenceError }
  | { readonly _tag: "saved"; readonly snapshot: SessionSnapshot };

const copySession = (session: Session): Session => ({ ...session, messages: structuredClone(session.messages) });

const make = Effect.gen(function* () {
  const entries = yield* Ref.make(HashMap.empty<SessionId, SessionEntry>());
  const crypto = yield* Crypto.Crypto;

  const create = Effect.fn("MemorySessionStore.create")(function* (
    initial: SessionInitial
  ): Effect.fn.Return<SessionSnapshot, SessionPersistenceError> {
    const id = yield* generateSessionId.pipe(Effect.provideService(Crypto.Crypto, crypto));
    const timestamp = yield* DateTime.now;
    const messages: Message[] =
      initial.systemPrompt === undefined ? [] : [{ role: "system", content: initial.systemPrompt }];
    const session: Session = { id, messages, createdAt: timestamp, updatedAt: timestamp };
    return { session, revision: SessionRevision.make(0) };
  });

  const load = Effect.fn("MemorySessionStore.load")(function* (
    id: SessionId
  ): Effect.fn.Return<SessionSnapshot, SessionLookupError> {
    const current = yield* Ref.get(entries);
    const entry = HashMap.get(current, id);
    if (Option.isNone(entry)) {
      return yield* new SessionLookupError({ reason: new SessionNotFound({ id }) });
    }
    return { session: copySession(entry.value.session), revision: entry.value.revision };
  });

  const save = Effect.fn("MemorySessionStore.save")(function* (
    checkpoint: SessionCheckpoint
  ): Effect.fn.Return<SessionSnapshot, SessionPersistenceError> {
    const { session, expectedRevision } = checkpoint;
    const updatedSession = copySession({ ...session, updatedAt: yield* DateTime.now });

    const outcome = yield* Ref.modify(entries, (current): [SaveOutcome, HashMap.HashMap<SessionId, SessionEntry>] => {
      const currentEntry = HashMap.get(current, session.id);
      const currentRevision = currentEntry.pipe(
        Option.map((entry) => entry.revision),
        Option.getOrElse(() => SessionRevision.make(0))
      );
      if (currentRevision !== expectedRevision) {
        return [
          {
            _tag: "conflict",
            error: new SessionPersistenceError({ reason: new SessionConflict({ id: session.id }) })
          },
          current
        ];
      }
      const nextRevision = SessionRevision.make(currentRevision + 1);
      const next = HashMap.set(current, session.id, { session: updatedSession, revision: nextRevision });
      return [{ _tag: "saved", snapshot: { session: copySession(updatedSession), revision: nextRevision } }, next];
    });

    if (outcome._tag === "conflict") {
      return yield* outcome.error;
    }
    return outcome.snapshot;
  });

  const list = Effect.fn("MemorySessionStore.list")(function* (): Effect.fn.Return<
    ReadonlyArray<SessionSummary>,
    SessionQueryError
  > {
    const current = yield* Ref.get(entries);
    return Array.from(HashMap.values(current), (entry) => ({
      id: entry.session.id,
      createdAt: entry.session.createdAt,
      updatedAt: entry.session.updatedAt
    })).sort((left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds);
  });

  const deleteSession = Effect.fn("MemorySessionStore.delete")(function* (
    id: SessionId
  ): Effect.fn.Return<void, SessionPersistenceError> {
    yield* Ref.update(entries, (current) => HashMap.remove(current, id));
  });

  return { create, load, save, list, delete: deleteSession };
});

/**
 * The in-memory `SessionStore` layer, dependency-preserving: it requires the
 * `Crypto` service (fresh `SessionId`s) and uses the `Clock` service
 * (timestamps; a defaulted reference, so it needs no provider).
 *
 * There is intentionally no closed layer in core — the platform `Crypto`
 * implementation lives in `@effect/platform-bun` and is installed by the
 * composition root or tests (e.g. `Layer.merge(layerNoDeps, BunCrypto.layer)`).
 */
export const layerNoDeps = Layer.effect(SessionStore, make);

/**
 * Alias of {@link layerNoDeps} for composition roots that install the platform
 * `Crypto` layer themselves. Same dependency-preserving contract.
 */
export const layer = layerNoDeps;
