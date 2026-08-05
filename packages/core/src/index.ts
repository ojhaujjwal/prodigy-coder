/**
 * The runtime-neutral public entrypoint for the Prodigy SDK.
 *
 * The SDK contracts are introduced in later package work. Keeping this
 * entrypoint import-safe establishes the public boundary without coupling
 * core to Bun, Node, the CLI, or process startup.
 */
/** The package name exposed by the scaffold's public entrypoint. */
export const packageName = "@prodigy/core" as const;

/** The temporary public shape used while the SDK contracts are being introduced. */
export type CorePackage = {
  readonly packageName: typeof packageName;
  readonly status: "scaffold";
};

export { ProdigyAgent } from "./agent/prodigy-agent.ts";
export type { RunRequest } from "./agent/run-request.ts";
export type {
  AgentError,
  InvalidRunReason,
  ModelReason,
  SessionStorageReason,
  ToolSystemReason
} from "./agent/agent-error.ts";
export {
  InvalidRunRequest,
  ModelError,
  SessionNotFound,
  SessionStorageError,
  ToolSystemError
} from "./agent/agent-error.ts";
export type { AgentEvent, AgentFinishReason, AgentResult, JsonValue, ToolOutcome } from "./agent/agent-event.ts";
