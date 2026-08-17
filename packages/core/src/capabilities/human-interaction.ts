import { Context, Effect, Schema } from "effect";
import type { JsonValue } from "../agent/agent-event.ts";

/** A tool the model requested that requires human approval before execution. */
export type ToolApprovalRequest = {
  readonly toolName: string;
  readonly callId: string;
  readonly input: JsonValue;
};

/** A question the model directed at the human, projected from an ask-style tool. */
export type UserQuestion = {
  readonly question: string;
};

/** A typed request for a human response: an approval or an answer to a question. */
export type InteractionRequest = ToolApprovalRequest | UserQuestion;

/** The possible outcomes of a human interaction. */
export type InteractionResponse =
  | { readonly _tag: "Approved" }
  | { readonly _tag: "Denied"; readonly reason?: string }
  | { readonly _tag: "Answered"; readonly answer: JsonValue };

/** The reasons an interaction channel can fail independently of the interaction's content. */
export const InteractionErrorReasonSchema = Schema.Literals(["Timeout", "ChannelClosed", "InvalidResponse"]);
export type InteractionErrorReason = Schema.Schema.Type<typeof InteractionErrorReasonSchema>;

/**
 * A typed one-shot request/response channel for human interaction, selected at
 * composition time. It is a required dependency whenever the selected toolkit's
 * the selected toolkit's handler requirements include it — never an optional
 * context read.
 */
export class HumanInteraction extends Context.Service<
  HumanInteraction,
  {
    readonly request: (input: InteractionRequest) => Effect.Effect<InteractionResponse, HumanInteractionError>;
  }
>()("@prodigy/core/capabilities/human-interaction/HumanInteraction") {}

/** A failure of the interaction channel itself (timeout, closed channel, invalid response). */
export class HumanInteractionError extends Schema.TaggedErrorClass<HumanInteractionError>()("HumanInteractionError", {
  reason: InteractionErrorReasonSchema
}) {}

/**
 * Project an `InteractionResponse` onto the native approval decision that
 * Effect AI's next `streamText` call consumes.
 *
 * `Approved` and `Denied` map directly (the denial carries an optional reason).
 * `Answered` (an ask-style answer) cannot resolve a native approval request;
 * the projection reports `InvalidResponse` so the run can fail the
 * interaction capability rather than silently mis-resolving.
 */
export const approvalDecisionFromInteraction = (
  response: InteractionResponse
):
  | { readonly _tag: "Approved" }
  | { readonly _tag: "Denied"; readonly reason?: string }
  | { readonly _tag: "InvalidResponse" } => {
  switch (response._tag) {
    case "Approved":
      return { _tag: "Approved" };
    case "Denied":
      if (response.reason === undefined) {
        return { _tag: "Denied" };
      }
      return { _tag: "Denied", reason: response.reason };
    case "Answered":
      return { _tag: "InvalidResponse" };
  }
};
