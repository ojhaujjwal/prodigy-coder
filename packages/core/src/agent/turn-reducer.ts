import { Option, Result, Schema } from "effect";
import { Response, Tool } from "effect/unstable/ai";
import type { ToolApprovalRequest } from "../capabilities/human-interaction.ts";
import type { ToolApprovalRequestPart, ToolApprovalResponsePart, ToolResultPart } from "../capabilities/session.ts";
import {
  mapAgentFinishReason,
  type AgentEvent,
  type AgentFinishReason,
  type JsonValue,
  type ToolOutcome
} from "./agent-event.ts";
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

const decodeJson = <Value>(value: Value) =>
  Schema.decodeUnknownResult(Schema.Json)(value).pipe(
    Result.mapError((cause) => new ToolSystemError({ reason: "Serialization", cause }))
  );

/**
 * Fold one model stream part into the turn state and the optional agent event
 * it produces. Pure and synchronous: JSON decoding uses the schema's `Result`
 * variant, and failures are `ToolSystemError`s the caller projects onto the
 * stream's error channel.
 */
export const reducePart = <TTools extends Record<string, Tool.Any>>(
  tools: TTools,
  state: TurnState,
  part: Response.StreamPart<TTools>
): Result.Result<TurnReduction, ToolSystemError> => {
  switch (part.type) {
    case "text-delta": {
      const textEvent: AgentEvent = { type: "text-delta", delta: part.delta };
      return Result.succeed({
        state: { ...state, assistantText: state.assistantText + part.delta },
        event: Option.some(textEvent)
      });
    }
    case "tool-call": {
      if (!Object.hasOwn(tools, part.name)) {
        return Result.fail(
          new ToolSystemError({ reason: "UnknownTool", cause: new Error(`Unknown tool: ${part.name}`) })
        );
      }
      return decodeJson(part.params).pipe(
        Result.map((input) => {
          const event: AgentEvent = { type: "tool-call", callId: part.id, toolName: part.name, input };
          return {
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
            event: Option.some(event)
          };
        })
      );
    }
    case "tool-approval-request": {
      const toolCall = Option.fromUndefinedOr(
        state.assistantParts.find(
          (candidate): candidate is AssistantToolCall =>
            candidate.type === "tool-call" && candidate.id === part.toolCallId
        )
      );
      if (Option.isNone(toolCall)) {
        return Result.fail(
          new ToolSystemError({
            reason: "Serialization",
            cause: new Error(`Approval request ${part.approvalId} has no matching tool call`)
          })
        );
      }
      const request: ToolApprovalRequest = {
        toolName: toolCall.value.name,
        callId: toolCall.value.id,
        input: toolCall.value.params
      };
      const interactionEvent: AgentEvent = { type: "interaction-requested", request };
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
        event: Option.some(interactionEvent)
      });
    }
    case "tool-result": {
      if (part.preliminary) {
        return Result.succeed({ state, event: Option.none() });
      }
      return decodeJson(part.encodedResult).pipe(
        Result.map((output) => {
          const outcome: ToolOutcome = part.isFailure
            ? { _tag: "Failed", error: JSON.stringify(output) ?? "Tool execution failed" }
            : { _tag: "Success", output };
          const event: AgentEvent = {
            type: "tool-result",
            callId: part.id,
            toolName: part.name,
            outcome
          };
          return {
            state: {
              ...state,
              toolParts: [
                ...state.toolParts,
                { type: "tool-result", id: part.id, name: part.name, isFailure: part.isFailure, result: output }
              ]
            },
            event: Option.some(event)
          };
        })
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
