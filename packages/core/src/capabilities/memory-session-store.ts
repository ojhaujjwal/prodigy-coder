import { Clock, Crypto, Effect, Layer, Ref } from "effect";
import {
  SessionConflict,
  SessionLookupError,
  SessionNotFound,
  SessionPersistenceError,
  SessionStore
} from "./session-store.ts";
import {
  SessionRevision,
  generateSessionId,
  type Message,
  type Session,
  type SessionCheckpoint,
  type SessionId,
  type SessionInitial,
  type SessionSnapshot
} from "./session.ts";

type SessionEntry = {
  readonly session: Session;
  readonly revision: SessionRevision;
};

type SaveOutcome =
  | { readonly _tag: "conflict"; readonly error: SessionPersistenceError }
  | { readonly _tag: "saved"; readonly snapshot: SessionSnapshot };

const make = Effect.gen(function* () {
  const entries = yield* Ref.make<ReadonlyMap<SessionId, SessionEntry>>(new Map());
  const clock = yield* Clock.Clock;
  const crypto = yield* Crypto.Crypto;

  const create = Effect.fn("MemorySessionStore.create")(function* (
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

  const load = Effect.fn("MemorySessionStore.load")(function* (
    id: SessionId
  ): Effect.fn.Return<SessionSnapshot, SessionLookupError> {
    const current = yield* Ref.get(entries);
    const entry = current.get(id);
    if (entry === undefined) {
      return yield* new SessionLookupError({ reason: new SessionNotFound({ id }) });
    }
    return { session: entry.session, revision: entry.revision };
  });

  const save = Effect.fn("MemorySessionStore.save")(function* (
    checkpoint: SessionCheckpoint
  ): Effect.fn.Return<SessionSnapshot, SessionPersistenceError> {
    const { session, expectedRevision } = checkpoint;
    const now = yield* clock.currentTimeMillis;
    const updatedSession: Session = { ...session, updatedAt: new Date(now) };

    const outcome = yield* Ref.modify(entries, (current): [SaveOutcome, ReadonlyMap<SessionId, SessionEntry>] => {
      const currentEntry = current.get(session.id);
      const currentRevision = currentEntry === undefined ? SessionRevision.make(0) : currentEntry.revision;
      if (currentRevision !== expectedRevision) {
        return [
          { _tag: "conflict", error: new SessionPersistenceError({ reason: new SessionConflict({ id: session.id }) }) },
          current
        ];
      }
      const nextRevision = SessionRevision.make(currentRevision + 1);
      const next = new Map(current);
      next.set(session.id, { session: updatedSession, revision: nextRevision });
      return [{ _tag: "saved", snapshot: { session: updatedSession, revision: nextRevision } }, next];
    });

    if (outcome._tag === "conflict") {
      return yield* outcome.error;
    }
    return outcome.snapshot;
  });

  return { create, load, save };
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
