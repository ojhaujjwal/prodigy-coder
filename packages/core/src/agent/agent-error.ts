import { Schema } from "effect";
import type { AiError } from "effect/unstable/ai";
import type { HumanInteractionError as HumanInteractionErrorType } from "../capabilities/human-interaction.ts";
import { SessionNotFound } from "../capabilities/session-store.ts";
import type { SessionError } from "../capabilities/session-store.ts";

/** Reasons for rejecting a run request before execution starts. */
export type InvalidRunReason = "EmptyPrompt" | "InvalidMaxTurns" | "OutOfBoundsOverride";

/** A run request that fails validation at the agent boundary. */
export class InvalidRunRequest extends Schema.TaggedErrorClass<InvalidRunRequest>()("InvalidRunRequest", {
  reason: Schema.Literals(["EmptyPrompt", "InvalidMaxTurns", "OutOfBoundsOverride"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** Reasons an Agent profile can fail eager binding. */
export type AgentProfileReason = "InvalidMaxTurns";

/** An Agent profile contains invalid configuration. */
export class AgentProfileError extends Schema.TaggedErrorClass<AgentProfileError>()("AgentProfileError", {
  reason: Schema.Literals(["InvalidMaxTurns"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** Reasons a session could not be persisted or loaded. */
export type SessionStorageReason = "Conflict" | "Encode" | "Write" | "Read" | "Decode";

/** A session storage failure projected into the agent error vocabulary. */
export class SessionStorageError extends Schema.TaggedErrorClass<SessionStorageError>()("SessionStorageError", {
  reason: Schema.Literals(["Conflict", "Encode", "Write", "Read", "Decode"]),
  cause: Schema.optional(Schema.Defect())
}) {}

/** The provider-neutral categories used to classify model failures. */
export type ModelReason =
  | "Transport"
  | "Authentication"
  | "RateLimit"
  | "Quota"
  | "InvalidRequest"
  | "ContentPolicy"
  | "InvalidOutput"
  | "Provider";

/** A model failure projected into the agent's public error vocabulary. */
export class ModelError extends Schema.TaggedErrorClass<ModelError>()("ModelError", {
  reason: Schema.Literals([
    "Transport",
    "Authentication",
    "RateLimit",
    "Quota",
    "InvalidRequest",
    "ContentPolicy",
    "InvalidOutput",
    "Provider"
  ]),
  cause: Schema.Defect()
}) {
  /** Whether callers may retry the model operation for this reason. */
  get isRetryable(): boolean {
    return isRetryableModelReason(this.reason);
  }
}

/** The orchestration failures that prevent a tool call from producing a model-visible result. */
export type ToolSystemReason = "UnknownTool" | "ToolkitMisconfiguration" | "Serialization";

/** A tool orchestration failure projected into the agent's public error vocabulary. */
export class ToolSystemError extends Schema.TaggedErrorClass<ToolSystemError>()("ToolSystemError", {
  reason: Schema.Literals(["UnknownTool", "ToolkitMisconfiguration", "Serialization"]),
  cause: Schema.Defect()
}) {}

/** A failure of the human-interaction channel itself, projected into the agent's error vocabulary. */
export class InteractionCapabilityError extends Schema.TaggedErrorClass<InteractionCapabilityError>()(
  "InteractionCapabilityError",
  {
    reason: Schema.Literals(["Timeout", "ChannelClosed", "InvalidResponse"]),
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
  reason === "Transport" || reason === "RateLimit" || reason === "Quota" || reason === "Provider";

const modelReasonFromAiError = (reason: AiError.AiErrorReason): ModelReason => {
  switch (reason._tag) {
    case "NetworkError":
      return reason.reason === "TransportError" ? "Transport" : "Provider";
    case "AuthenticationError":
      return "Authentication";
    case "RateLimitError":
      return "RateLimit";
    case "QuotaExhaustedError":
      return "Quota";
    case "InvalidRequestError":
      return "InvalidRequest";
    case "ContentPolicyError":
      return "ContentPolicy";
    case "InvalidOutputError":
    case "StructuredOutputError":
      return "InvalidOutput";
    default:
      return "Provider";
  }
};
/** Map a provider `AiError` onto the agent's public model error vocabulary. */
export const agentErrorFromModelError = (error: AiError.AiError): ModelError =>
  new ModelError({ reason: modelReasonFromAiError(error.reason), cause: error });

/** Map an Effect AI tool-system failure onto the agent's public error vocabulary. */
export const agentErrorFromToolError = (error: AiError.AiError): ToolSystemError | ModelError => {
  switch (error.reason._tag) {
    case "ToolNotFoundError":
      return new ToolSystemError({ reason: "UnknownTool", cause: error });
    case "ToolConfigurationError":
    case "ToolkitRequiredError":
      return new ToolSystemError({ reason: "ToolkitMisconfiguration", cause: error });
    case "ToolParameterValidationError":
    case "ToolResultEncodingError":
    case "InvalidToolResultError":
    case "InvalidOutputError":
      return new ToolSystemError({ reason: "Serialization", cause: error });
    default:
      return agentErrorFromModelError(error);
  }
};

const sessionStorageReasonFromError = (
  error: Extract<SessionError, { readonly _tag: "SessionPersistenceError" }>["reason"]
): SessionStorageReason => {
  switch (error._tag) {
    case "SessionConflict":
      return "Conflict";
    case "SessionEncodeFailure":
      return "Encode";
    case "SessionWriteFailure":
      return "Write";
    case "SessionReadFailure":
      return "Read";
    case "SessionDecodeFailure":
      return "Decode";
  }
};

/** Project a SessionStore failure into the stable agent error vocabulary. */
export const agentErrorFromSessionError = (error: SessionError): SessionNotFound | SessionStorageError => {
  if (error._tag === "SessionLookupError" && error.reason._tag === "SessionNotFound") {
    return error.reason;
  }

  const reason =
    error._tag === "SessionLookupError"
      ? error.reason._tag === "SessionReadFailure"
        ? "Read"
        : "Decode"
      : sessionStorageReasonFromError(error.reason);
  const cause = error;
  return new SessionStorageError({ reason, cause });
};

/** Map a HumanInteraction channel failure onto the agent's public error vocabulary. */
export const agentErrorFromHumanInteractionError = (error: HumanInteractionErrorType): InteractionCapabilityError =>
  new InteractionCapabilityError({ reason: error.reason, cause: error });
