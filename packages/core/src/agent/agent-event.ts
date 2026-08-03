import type { Response } from "effect/unstable/ai";
import type { SessionId } from "../capabilities/session.ts";
import type { RunId } from "./run-request.ts";

/**
 * The reason a run finished, projected by Prodigy from the provider's finish
 * value into recovery-relevant semantics. This is the stable, provider-neutral
 * vocabulary that callers (e.g. `HarnessLoop`) use to decide what to do next.
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

/** Map a provider `Response.FinishReason` onto the Prodigy-owned `AgentFinishReason` vocabulary. */
export const mapAgentFinishReason = (reason: Response.FinishReason): AgentFinishReason => reason;

/** The terminal result of a successful run. */
export type AgentResult = {
  readonly _tag: "Finished";
  readonly sessionId: SessionId;
  readonly turns: number;
  readonly finishReason: AgentFinishReason;
};

/**
 * The semantic event vocabulary of a run, in causal order: `run-started` first,
 * nothing follows `run-ended`. Tool and interaction events arrive in later
 * slices.
 */
export type AgentEvent =
  | { readonly type: "run-started"; readonly runId: RunId; readonly sessionId: SessionId }
  | { readonly type: "turn-started"; readonly turn: number }
  | { readonly type: "text-delta"; readonly delta: string }
  | { readonly type: "run-ended"; readonly result: AgentResult };
