import { Schema } from "effect";
import type { AiError } from "effect/unstable/ai";
import type { SessionError } from "../capabilities/session-store.ts";

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
}) {}

/** The orchestration failures that prevent a tool call from producing a model-visible result. */
export type ToolSystemReason = "unknown-tool" | "toolkit-misconfiguration" | "serialization";

/** A tool orchestration failure projected into the agent's public error vocabulary. */
export class ToolSystemError extends Schema.TaggedErrorClass<ToolSystemError>()("ToolSystemError", {
  reason: Schema.Literals(["unknown-tool", "toolkit-misconfiguration", "serialization"]),
  cause: Schema.Defect()
}) {}

/** The typed failures a run stream can fail with. */
export type AgentError = SessionError | ModelError | ToolSystemError;

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

/** Map a provider `AiError` onto the agent's public error vocabulary. */
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
