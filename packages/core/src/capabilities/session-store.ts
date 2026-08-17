import { Context, Effect, Schema } from "effect";
import {
  SessionId,
  type SessionCheckpoint,
  type SessionInitial,
  type SessionSnapshot,
  type SessionSummary
} from "./session.ts";

export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  id: SessionId
}) {}

export class SessionReadFailure extends Schema.TaggedErrorClass<SessionReadFailure>()("SessionReadFailure", {
  id: SessionId,
  cause: Schema.Defect()
}) {}

export class SessionDecodeFailure extends Schema.TaggedErrorClass<SessionDecodeFailure>()("SessionDecodeFailure", {
  id: SessionId,
  cause: Schema.Defect()
}) {}

export class SessionConflict extends Schema.TaggedErrorClass<SessionConflict>()("SessionConflict", {
  id: SessionId
}) {}

export class SessionEncodeFailure extends Schema.TaggedErrorClass<SessionEncodeFailure>()("SessionEncodeFailure", {
  id: SessionId,
  cause: Schema.Defect()
}) {}

export class SessionWriteFailure extends Schema.TaggedErrorClass<SessionWriteFailure>()("SessionWriteFailure", {
  id: SessionId,
  cause: Schema.Defect()
}) {}

/** Lookup failures: the session is missing or could not be read/decoded. */
export class SessionLookupError extends Schema.TaggedErrorClass<SessionLookupError>()("SessionLookupError", {
  reason: Schema.Union([SessionNotFound, SessionReadFailure, SessionDecodeFailure])
}) {}

/** Persistence failures: the save conflicted, could not validate the existing record, or could not be encoded/written. */
export class SessionPersistenceError extends Schema.TaggedErrorClass<SessionPersistenceError>()(
  "SessionPersistenceError",
  {
    reason: Schema.Union([
      SessionConflict,
      SessionDecodeFailure,
      SessionEncodeFailure,
      SessionReadFailure,
      SessionWriteFailure
    ])
  }
) {}

export type SessionError = SessionLookupError | SessionPersistenceError;

export class SessionAdministrationError extends Schema.TaggedErrorClass<SessionAdministrationError>()(
  "SessionAdministrationError",
  {
    operation: Schema.Literals(["list", "delete"]),
    id: Schema.optional(SessionId),
    cause: Schema.optional(Schema.Defect())
  }
) {}

/**
 * The runtime `SessionStore` port: create/load/save a `SessionRecord` transcript
 * with optimistic compare-and-set. Callers match the family tag first
 * (`SessionLookupError` / `SessionPersistenceError`), then the precise `reason`.
 */
export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly create: (initial: SessionInitial) => Effect.Effect<SessionSnapshot, SessionPersistenceError>;
    readonly load: (id: SessionId) => Effect.Effect<SessionSnapshot, SessionLookupError>;
    readonly save: (checkpoint: SessionCheckpoint) => Effect.Effect<SessionSnapshot, SessionPersistenceError>;
    readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>, SessionAdministrationError>;
    readonly delete: (id: SessionId) => Effect.Effect<void, SessionAdministrationError>;
  }
>()("@prodigy/core/capabilities/session-store/SessionStore") {}
