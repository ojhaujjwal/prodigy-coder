import { Schema } from "effect";
import { SessionId } from "../capabilities/session.ts";

/**
 * A supplied `sessionId` did not resolve. Never a fallback to a new session.
 */
export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  sessionId: SessionId
}) {}

/** A session-store operation failed during a run (read/decode/write/encode/conflict). */
export class SessionStorageError extends Schema.TaggedErrorClass<SessionStorageError>()("SessionStorageError", {
  reason: Schema.Literals(["conflict", "encode", "write", "read", "decode"])
}) {}

/**
 * The typed failures a run stream can fail with. The full union grows in later
 * slices (`InvalidRunRequest`, `ModelError`, `ToolSystemError`, `RemoteError`).
 */
export type AgentError = SessionNotFound | SessionStorageError;
