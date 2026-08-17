import { Crypto, Effect, Schema } from "effect";

/**
 * The `SessionId` brand schema: exactly 8 lowercase-alphanumeric characters.
 *
 * Internal to the store's authority — construction happens only through
 * {@link generateSessionId} (the schema's validating constructor is used
 * inside this module and by the memory adapter). The schema itself is never
 * re-exported from the package root; consumers only name the `SessionId` type.
 */
export const SessionId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9]{8}$/)), Schema.brand("SessionId"));
export type SessionId = Schema.Schema.Type<typeof SessionId>;

/**
 * The `SessionRevision` brand schema: a non-negative integer.
 *
 * Revisions are produced only by the store's compare-and-set, never
 * caller-supplied, and the schema is never re-exported from the package root.
 */
export const SessionRevision = Schema.Int.pipe(
  Schema.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.brand("SessionRevision")
);
export type SessionRevision = Schema.Schema.Type<typeof SessionRevision>;

const TextPart = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String
});
export type TextPart = Schema.Schema.Type<typeof TextPart>;

const ToolCallPart = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Json,
  providerExecuted: Schema.Boolean
});
export type ToolCallPart = Schema.Schema.Type<typeof ToolCallPart>;

const ToolApprovalRequestPart = Schema.Struct({
  type: Schema.Literal("tool-approval-request"),
  approvalId: Schema.String,
  toolCallId: Schema.String
});
export type ToolApprovalRequestPart = Schema.Schema.Type<typeof ToolApprovalRequestPart>;

const ToolResultPart = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  isFailure: Schema.Boolean,
  result: Schema.Json
});
export type ToolResultPart = Schema.Schema.Type<typeof ToolResultPart>;

const ToolApprovalResponsePart = Schema.Struct({
  type: Schema.Literal("tool-approval-response"),
  approvalId: Schema.String,
  approved: Schema.Boolean,
  reason: Schema.optional(Schema.String)
});
export type ToolApprovalResponsePart = Schema.Schema.Type<typeof ToolApprovalResponsePart>;

const SystemMessage = Schema.Struct({
  role: Schema.Literal("system"),
  content: Schema.String
});
export type SystemMessage = Schema.Schema.Type<typeof SystemMessage>;

const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(TextPart)])
});
export type UserMessage = Schema.Schema.Type<typeof UserMessage>;

const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([TextPart, ToolCallPart, ToolApprovalRequestPart]))])
});
export type AssistantMessage = Schema.Schema.Type<typeof AssistantMessage>;

const ToolMessage = Schema.Struct({
  role: Schema.Literal("tool"),
  content: Schema.Array(Schema.Union([ToolResultPart, ToolApprovalResponsePart]))
});
export type ToolMessage = Schema.Schema.Type<typeof ToolMessage>;

const Message = Schema.Union([SystemMessage, UserMessage, AssistantMessage, ToolMessage]);
export type Message = Schema.Schema.Type<typeof Message>;

/** Inputs to `create`; the `SessionId` is always allocated by the store. */
export type SessionInitial = {
  readonly systemPrompt?: string;
};

/** A complete session at a specific revision (transient for `create`). */
export type SessionSnapshot = {
  readonly session: Session;
  readonly revision: SessionRevision;
};

/** A session plus the revision a caller expects the store to currently hold. */
export type SessionCheckpoint = {
  readonly session: Session;
  readonly expectedRevision: SessionRevision;
};

/**
 * Construct a checkpoint that appends messages to a session snapshot.
 * Persistence remains the responsibility of `SessionStore` callers.
 */
export const checkpointWithMessages = (
  snapshot: SessionSnapshot,
  messages: ReadonlyArray<Message>
): SessionCheckpoint => ({
  session: {
    ...snapshot.session,
    messages: [...snapshot.session.messages, ...messages]
  },
  expectedRevision: snapshot.revision
});

/**
 * The canonical session type: a session id, its messages, and timestamps.
 *
 * Persisted via UTC ISO timestamps and the validating message
 * schemas, so decoding a stored record re-validates and re-brands the
 * `SessionId` at the persistence boundary.
 *
 * Internal module export — used by the file adapter (and tests) but never
 * re-exported from the package root.
 */
export const Session = Schema.Struct({
  id: SessionId,
  messages: Schema.Array(Message),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString
});
export type Session = Schema.Schema.Type<typeof Session>;

/**
 * Allocate a fresh `SessionId` from the `Crypto` service.
 *
 * Internal module export — importable by adapters (and tests) but never
 * re-exported from the package root. Produces 8 lowercase-alphanumeric
 * characters from `Crypto.randomBytes`, an exact port of the CLI's
 * `chars[bytes[i] % 36]` algorithm.
 */
export const generateSessionId: Effect.Effect<SessionId, never, Crypto.Crypto> = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.randomBytes(8).pipe(Effect.orDie);
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  let id = "";
  for (let i = 0; i < 8; i++) {
    id += chars[bytes[i] % 36];
  }
  return SessionId.make(id);
});
