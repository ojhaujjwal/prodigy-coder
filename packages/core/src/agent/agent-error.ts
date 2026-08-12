import { Schema } from "effect";
import type { AiError } from "effect/unstable/ai";
import type { HumanInteractionError as HumanInteractionErrorType } from "../capabilities/human-interaction.ts";
import type { SessionError } from "../capabilities/session-store.ts";

/** Reasons for rejecting a run request before execution starts. */
export type InvalidRunReason = "empty-prompt" | "invalid-max-turns" | "out-of-bounds-override";

/** A run request that fails validation at the agent boundary. */
export class InvalidRunRequest extends Schema.TaggedErrorClass<InvalidRunRequest>()("InvalidRunRequest", {
  reason: Schema.Literals(["empty-prompt", "invalid-max-turns", "out-of-bounds-override"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** Reasons an Agent profile can fail eager binding. */
export type AgentProfileReason = "invalid-max-turns";

/** An Agent profile contains invalid configuration. */
export class AgentProfileError extends Schema.TaggedErrorClass<AgentProfileError>()("AgentProfileError", {
  reason: Schema.Literals(["invalid-max-turns"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** The requested session could not be found. */
export class SessionNotFound extends Schema.TaggedErrorClass<SessionNotFound>()("SessionNotFound", {
  sessionId: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** Reasons a session could not be persisted or loaded. */
export type SessionStorageReason = "conflict" | "encode" | "write" | "read" | "decode";

/** A session storage failure projected into the agent error vocabulary. */
export class SessionStorageError extends Schema.TaggedErrorClass<SessionStorageError>()("SessionStorageError", {
  reason: Schema.Literals(["conflict", "encode", "write", "read", "decode"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** The provider-neutral categories used to classify model failures. */
export type ModelReason =
  | "transport"
  | "authentication"
  | "rate-limit"
  | "quota"
  | "invalid-request"
  | "content-policy"
  | "invalid-output"
  | "provider";

/** A model failure projected into the agent's public error vocabulary. */
export class ModelError extends Schema.TaggedErrorClass<ModelError>()("ModelError", {
  reason: Schema.Literals([
    "transport",
    "authentication",
    "rate-limit",
    "quota",
    "invalid-request",
    "content-policy",
    "invalid-output",
    "provider"
  ]),
  cause: Schema.Defect()
}) {
  /** Whether callers may retry the model operation for this reason. */
  get isRetryable(): boolean {
    return isRetryableModelReason(this.reason);
  }
}

/** The orchestration failures that prevent a tool call from producing a model-visible result. */
export type ToolSystemReason = "unknown-tool" | "toolkit-misconfiguration" | "serialization";

/** A tool orchestration failure projected into the agent's public error vocabulary. */
export class ToolSystemError extends Schema.TaggedErrorClass<ToolSystemError>()("ToolSystemError", {
  reason: Schema.Literals(["unknown-tool", "toolkit-misconfiguration", "serialization"]),
  cause: Schema.Defect()
}) {}

/** A failure of the human-interaction channel itself, projected into the agent's error vocabulary. */
export class InteractionCapabilityError extends Schema.TaggedErrorClass<InteractionCapabilityError>()(
  "InteractionCapabilityError",
  {
    reason: Schema.Literals(["timeout", "channel-closed", "invalid-response"]),
    cause: Schema.optional(Schema.Defect())
  }
) {}

/** The typed failures exposed by a run stream. */
export type AgentError =
  | InvalidRunRequest
  | SessionNotFound
  | SessionStorageError
  | ModelError
  | ToolSystemError
  | InteractionCapabilityError;

/** Map a neutral model reason to its retryability policy. */
export const isRetryableModelReason = (reason: ModelReason): boolean =>
  reason === "transport" || reason === "rate-limit" || reason === "quota" || reason === "provider";

const modelReasonFromAiError = (reason: AiError.AiErrorReason): ModelReason => {
  switch (reason._tag) {
    case "NetworkError":
      return reason.reason === "TransportError" ? "transport" : "provider";
    case "AuthenticationError":
      return "authentication";
    case "RateLimitError":
      return "rate-limit";
    case "QuotaExhaustedError":
      return "quota";
    case "InvalidRequestError":
      return "invalid-request";
    case "ContentPolicyError":
      return "content-policy";
    case "InvalidOutputError":
    case "StructuredOutputError":
      return "invalid-output";
    default:
      return "provider";
  }
};
/** Map a provider `AiError` onto the agent's public model error vocabulary. */
export const agentErrorFromModelError = (error: AiError.AiError): ModelError =>
  new ModelError({ reason: modelReasonFromAiError(error.reason), cause: error });

/** Map an Effect AI tool-system failure onto the agent's public error vocabulary. */
export const agentErrorFromToolError = (error: AiError.AiError): ToolSystemError | ModelError => {
  switch (error.reason._tag) {
    case "ToolNotFoundError":
      return new ToolSystemError({ reason: "unknown-tool", cause: error });
    case "ToolConfigurationError":
    case "ToolkitRequiredError":
      return new ToolSystemError({ reason: "toolkit-misconfiguration", cause: error });
    case "ToolParameterValidationError":
    case "ToolResultEncodingError":
    case "InvalidToolResultError":
    case "InvalidOutputError":
      return new ToolSystemError({ reason: "serialization", cause: error });
    default:
      return agentErrorFromModelError(error);
  }
};

const sessionStorageReasonFromError = (
  error: Extract<SessionError, { readonly _tag: "SessionPersistenceError" }>["reason"]
): SessionStorageReason => {
  switch (error._tag) {
    case "SessionConflict":
      return "conflict";
    case "SessionEncodeFailure":
      return "encode";
    case "SessionWriteFailure":
      return "write";
    case "SessionReadFailure":
      return "read";
    case "SessionDecodeFailure":
      return "decode";
  }
};

/** Project a SessionStore failure into the stable agent error vocabulary. */
export const agentErrorFromSessionError = (error: SessionError): SessionNotFound | SessionStorageError => {
  if (error._tag === "SessionLookupError" && error.reason._tag === "SessionNotFound") {
    return new SessionNotFound({ sessionId: error.reason.id, cause: error });
  }

  const reason =
    error._tag === "SessionLookupError"
      ? error.reason._tag === "SessionReadFailure"
        ? "read"
        : "decode"
      : sessionStorageReasonFromError(error.reason);
  const cause = error;
  return new SessionStorageError({ reason, cause });
};

/** Map a HumanInteraction channel failure onto the agent's public error vocabulary. */
export const agentErrorFromHumanInteractionError = (error: HumanInteractionErrorType): InteractionCapabilityError =>
  new InteractionCapabilityError({ reason: error.reason, cause: error });
