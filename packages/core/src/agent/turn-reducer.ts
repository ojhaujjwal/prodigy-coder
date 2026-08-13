import { Option, Result, Schema } from "effect";
import { Response, Tool } from "effect/unstable/ai";
import type { ToolApprovalRequest } from "../capabilities/human-interaction.ts";
import type { ToolApprovalRequestPart, ToolApprovalResponsePart, ToolResultPart } from "../capabilities/session.ts";
import { mapAgentFinishReason, type AgentEvent, type AgentFinishReason, type JsonValue } from "./agent-event.ts";
import { ToolSystemError } from "./agent-error.ts";

/** A tool call whose params were decoded to JSON-safe form, recorded in the turn state. */
export type AssistantToolCall = {
  readonly type: "tool-call";
  readonly id: string;
  readonly name: string;
  readonly params: JsonValue;
  readonly providerExecuted: boolean;
};

/** An approval request waiting on the human-interaction channel. */
export type PendingApproval = {
  readonly request: ToolApprovalRequest;
  readonly approvalId: string;
  readonly toolCallId: string;
};

/** The accumulated state of one turn, folded from model stream parts. */
export type TurnState = {
  assistantText: string;
  assistantParts: Array<AssistantToolCall | ToolApprovalRequestPart>;
  toolParts: Array<ToolResultPart>;
  approvalParts: Array<ToolApprovalResponsePart>;
  pendingApprovals: Array<PendingApproval>;
  hasToolCalls: boolean;
  hasFinish: boolean;
  finishReason: AgentFinishReason;
};

export const emptyTurnState = (): TurnState => ({
  assistantText: "",
  assistantParts: [],
  toolParts: [],
  approvalParts: [],
  pendingApprovals: [],
  hasToolCalls: false,
  hasFinish: false,
  finishReason: "unknown"
});

type TurnReduction = {
  readonly state: TurnState;
  readonly event: Option.Option<AgentEvent>;
};

const decodeJson = (value: unknown) =>
  Schema.decodeUnknownResult(Schema.Json)(value).pipe(
    Result.mapError((cause) => new ToolSystemError({ reason: "Serialization", cause }))
  );

/**
 * Fold one model stream part into the turn state and the optional agent event
 * it produces. Pure and synchronous: JSON decoding uses the schema's `Result`
 * variant, and failures are `ToolSystemError`s the caller projects onto the
 * stream's error channel.
 */
export const reducePart = (
  tools: Readonly<Record<string, Tool.Any>>,
  state: TurnState,
  part: Response.StreamPart<Record<string, Tool.Any>>
): Result.Result<TurnReduction, ToolSystemError> => {
  switch (part.type) {
    case "text-delta":
      return Result.succeed({
        state: { ...state, assistantText: state.assistantText + part.delta },
        event: Option.some({ type: "text-delta", delta: part.delta } satisfies AgentEvent)
      });
    case "tool-call": {
      if (!Object.hasOwn(tools, part.name)) {
        return Result.fail(
          new ToolSystemError({ reason: "UnknownTool", cause: new Error(`Unknown tool: ${part.name}`) })
        );
      }
      return decodeJson(part.params).pipe(
        Result.map((input) => ({
          state: {
            ...state,
            hasToolCalls: true,
            assistantParts: [
              ...state.assistantParts,
              {
                type: "tool-call",
                id: part.id,
                name: part.name,
                params: input,
                providerExecuted: part.providerExecuted
              }
            ]
          },
          event: Option.some({ type: "tool-call", callId: part.id, toolName: part.name, input } satisfies AgentEvent)
        }))
      );
    }
    case "tool-approval-request": {
      const toolCall = state.assistantParts.find(
        (candidate): candidate is AssistantToolCall =>
          candidate.type === "tool-call" && candidate.id === part.toolCallId
      );
      if (toolCall === undefined) {
        return Result.fail(
          new ToolSystemError({
            reason: "Serialization",
            cause: new Error(`Approval request ${part.approvalId} has no matching tool call`)
          })
        );
      }
      const request: ToolApprovalRequest = {
        toolName: toolCall.name,
        callId: toolCall.id,
        input: toolCall.params
      };
      return Result.succeed({
        state: {
          ...state,
          hasToolCalls: true,
          pendingApprovals: [
            ...state.pendingApprovals,
            { request, approvalId: part.approvalId, toolCallId: part.toolCallId }
          ],
          assistantParts: [
            ...state.assistantParts,
            { type: "tool-approval-request", approvalId: part.approvalId, toolCallId: part.toolCallId }
          ]
        },
        event: Option.some({ type: "interaction-requested", request } satisfies AgentEvent)
      });
    }
    case "tool-result": {
      if (part.preliminary) {
        return Result.succeed({ state, event: Option.none() });
      }
      return decodeJson(part.encodedResult).pipe(
        Result.map((output) => ({
          state: {
            ...state,
            toolParts: [
              ...state.toolParts,
              { type: "tool-result", id: part.id, name: part.name, isFailure: part.isFailure, result: output }
            ]
          },
          event: Option.some({
            type: "tool-result",
            callId: part.id,
            toolName: part.name,
            outcome: part.isFailure
              ? { _tag: "Failed", error: JSON.stringify(output) ?? "Tool execution failed" }
              : { _tag: "Success", output }
          } satisfies AgentEvent)
        }))
      );
    }
    case "finish":
      return Result.succeed({
        state: { ...state, hasFinish: true, finishReason: mapAgentFinishReason(part.reason) },
        event: Option.none()
      });
    default:
      return Result.succeed({ state, event: Option.none() });
  }
};
