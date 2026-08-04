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

/** The typed failures a run stream can fail with. */
export type AgentError = SessionError | ModelError;

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

/** Map a provider `AiError` onto the agent's public error channel. */
export const agentErrorFromModelError = (error: AiError.AiError): ModelError =>
  new ModelError({ reason: modelReasonFromAiError(error.reason), cause: error });
