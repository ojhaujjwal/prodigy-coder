import type { Response } from "effect/unstable/ai";
import type { Schema } from "effect";
import type { SessionId } from "../capabilities/session.ts";
import type { RunId } from "./run-request.ts";

/** JSON-safe data exposed at the agent boundary. */
export type JsonValue = Schema.Json;

/** The model-visible outcome of a completed tool execution. */
export type ToolOutcome =
  | { readonly _tag: "Success"; readonly output: JsonValue }
  | { readonly _tag: "Failed"; readonly error: string };

/**
 * The reason a run finished, projected by Prodigy from the provider's finish
 * value into recovery-relevant semantics.
 */
export type AgentFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "tool-calls"
  | "error"
  | "pause"
  | "other"
  | "unknown";

/** Map a provider `Response.FinishReason` onto the Prodigy-owned vocabulary. */
export const mapAgentFinishReason = (reason: Response.FinishReason): AgentFinishReason => reason;

/** The terminal result of a successful run. */
export type AgentResult = {
  readonly _tag: "Finished";
  readonly sessionId: SessionId;
  readonly turns: number;
  readonly finishReason: AgentFinishReason;
};

/** The semantic event vocabulary of a run, in causal order. */
export type AgentEvent =
  | { readonly type: "run-started"; readonly runId: RunId; readonly sessionId: SessionId }
  | { readonly type: "turn-started"; readonly turn: number }
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "tool-call"; readonly callId: string; readonly toolName: string; readonly input: JsonValue }
  | { readonly type: "tool-result"; readonly callId: string; readonly toolName: string; readonly outcome: ToolOutcome }
  | { readonly type: "run-ended"; readonly result: AgentResult };
