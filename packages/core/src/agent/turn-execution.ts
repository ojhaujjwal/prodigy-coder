import { Context, Deferred, Effect, Option, Result, Schema, Stream } from "effect";
import { LanguageModel, Prompt, Tool } from "effect/unstable/ai";
import type {
  Message,
  SessionSnapshot,
  ToolApprovalRequestPart,
  ToolApprovalResponsePart,
  ToolCallPart,
  ToolResultPart
} from "../capabilities/session.ts";
import { checkpointWithMessages } from "../capabilities/session.ts";
import {
  approvalDecisionFromInteraction,
  HumanInteraction,
  HumanInteractionError,
  type ToolApprovalRequest
} from "../capabilities/human-interaction.ts";
import { SessionStore } from "../capabilities/session-store.ts";
import {
  agentErrorFromHumanInteractionError,
  agentErrorFromSessionError,
  agentErrorFromToolError,
  type AgentError,
  ToolSystemError
} from "./agent-error.ts";
import { mapAgentFinishReason, type AgentEvent, type AgentFinishReason, type JsonValue } from "./agent-event.ts";
import type { ResolvedAgentProfile } from "./profile-resolution.ts";

/** The completed state of one streamed turn execution. */
export type TurnOutcome =
  | { readonly _tag: "ToolCalls"; readonly snapshot: SessionSnapshot }
  | { readonly _tag: "Finished"; readonly snapshot: SessionSnapshot; readonly finishReason: AgentFinishReason }
  | { readonly _tag: "Incomplete"; readonly snapshot: SessionSnapshot };

/** The stream and completed outcome of one turn. */
export type TurnExecution = {
  readonly stream: Stream.Stream<AgentEvent, AgentError>;
  readonly outcome: Effect.Effect<TurnOutcome, AgentError>;
};

type AssistantPart = { readonly type: "text"; readonly text: string } | ToolCallPart | ToolApprovalRequestPart;

type PendingApproval = {
  readonly request: ToolApprovalRequest;
  readonly approvalId: string;
  readonly toolCallId: string;
};

type TurnState = {
  assistantText: string;
  assistantParts: Array<ToolCallPart | ToolApprovalRequestPart>;
  toolParts: Array<ToolResultPart>;
  approvalParts: Array<ToolApprovalResponsePart>;
  pendingApprovals: Array<PendingApproval>;
  hasToolCalls: boolean;
  hasFinish: boolean;
  finishReason: AgentFinishReason;
};

const emptyTurnState = (): TurnState => ({
  assistantText: "",
  assistantParts: [],
  toolParts: [],
  approvalParts: [],
  pendingApprovals: [],
  hasToolCalls: false,
  hasFinish: false,
  finishReason: "unknown"
});

const decodeJson = (value: unknown): Effect.Effect<JsonValue, ToolSystemError> =>
  Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError((cause) => new ToolSystemError({ reason: "serialization", cause }))
  );

const readHumanInteraction = (context: Context.Context<never>): Option.Option<HumanInteraction["Service"]> =>
  Context.getOption(context, HumanInteraction);

const resolveApproval = (
  interaction: HumanInteraction["Service"],
  request: ToolApprovalRequest,
  approvalId: string
): Effect.Effect<ToolApprovalResponsePart, AgentError> =>
  Effect.gen(function* () {
    const response = yield* interaction.request(request).pipe(Effect.mapError(agentErrorFromHumanInteractionError));
    const decision = approvalDecisionFromInteraction(response);
    switch (decision._tag) {
      case "Approved":
        return { type: "tool-approval-response", approvalId, approved: true };
      case "Denied":
        return {
          type: "tool-approval-response",
          approvalId,
          approved: false,
          ...(decision.reason === undefined ? {} : { reason: decision.reason })
        };
      case "invalid-response":
        return yield* agentErrorFromHumanInteractionError(new HumanInteractionError({ reason: "invalid-response" }));
    }
  });

const appendTurnCheckpoint = (
  store: SessionStore["Service"],
  snapshot: SessionSnapshot,
  state: TurnState
): Effect.Effect<SessionSnapshot, AgentError> =>
  Effect.gen(function* () {
    const messages: Array<Message> = [];
    if (state.assistantParts.length > 0 || state.assistantText.length > 0) {
      const content: string | ReadonlyArray<AssistantPart> =
        state.assistantParts.length > 0
          ? [
              ...(state.assistantText.length > 0
                ? [{ type: "text", text: state.assistantText } satisfies AssistantPart]
                : []),
              ...state.assistantParts
            ]
          : state.assistantText;
      messages.push({ role: "assistant", content });
    }
    if (state.toolParts.length > 0 || state.approvalParts.length > 0) {
      messages.push({
        role: "tool",
        content: [...state.toolParts, ...state.approvalParts]
      });
    }
    if (messages.length === 0) return snapshot;
    return yield* store
      .save(checkpointWithMessages(snapshot, messages))
      .pipe(Effect.mapError(agentErrorFromSessionError));
  });

/**
 * Execute one model/tool exchange and resolve its committed outcome.
 *
 * Model parts remain streaming. The outcome is completed only after approval
 * responses and the entire assistant/tool exchange have been checkpointed.
 */
export const executeTurn = Effect.fn("TurnExecution.execute")(function* <TTools extends Record<string, Tool.Any>>(
  store: SessionStore["Service"],
  model: LanguageModel.LanguageModel["Service"],
  profile: ResolvedAgentProfile<TTools>,
  snapshot: SessionSnapshot,
  turn: number
) {
  const state = emptyTurnState();
  const outcome = yield* Deferred.make<TurnOutcome, AgentError>();
  const modelPrompt: Prompt.RawInput = snapshot.session.messages;
  const parts = model.streamText({ prompt: modelPrompt, toolkit: profile.toolkit }).pipe(
    Stream.provideContext(profile.toolkitContext),
    Stream.mapError(agentErrorFromToolError),
    Stream.filterMapEffect((part): Effect.Effect<Result.Result<AgentEvent, unknown>, AgentError> => {
      switch (part.type) {
        case "text-delta":
          state.assistantText += part.delta;
          return Effect.succeed(Result.succeed({ type: "text-delta", delta: part.delta } satisfies AgentEvent));
        case "tool-call":
          if (!Object.hasOwn(profile.toolkit.tools, part.name)) {
            return Effect.fail(
              new ToolSystemError({ reason: "unknown-tool", cause: new Error(`Unknown tool: ${part.name}`) })
            );
          }
          return decodeJson(part.params).pipe(
            Effect.tap((input) =>
              Effect.sync(() => {
                state.hasToolCalls = true;
                state.assistantParts.push({
                  type: "tool-call",
                  id: part.id,
                  name: part.name,
                  params: input,
                  providerExecuted: part.providerExecuted
                });
              })
            ),
            Effect.map((input) =>
              Result.succeed({
                type: "tool-call",
                callId: part.id,
                toolName: part.name,
                input
              } satisfies AgentEvent)
            )
          );
        case "tool-approval-request": {
          const toolCall = state.assistantParts.find(
            (candidate): candidate is ToolCallPart => candidate.type === "tool-call" && candidate.id === part.toolCallId
          );
          if (toolCall === undefined) {
            return Effect.fail(
              new ToolSystemError({
                reason: "serialization",
                cause: new Error(`Approval request ${part.approvalId} has no matching tool call`)
              })
            );
          }
          return decodeJson(toolCall.params).pipe(
            Effect.map((input) => {
              const request: ToolApprovalRequest = {
                toolName: toolCall.name,
                callId: toolCall.id,
                input
              };
              state.hasToolCalls = true;
              state.pendingApprovals.push({ request, approvalId: part.approvalId, toolCallId: part.toolCallId });
              state.assistantParts.push({
                type: "tool-approval-request",
                approvalId: part.approvalId,
                toolCallId: part.toolCallId
              });
              return Result.succeed({ type: "interaction-requested", request } satisfies AgentEvent);
            })
          );
        }
        case "tool-result":
          if (part.preliminary) return Effect.succeed(Result.fail(part));
          return decodeJson(part.encodedResult).pipe(
            Effect.tap((output) =>
              Effect.sync(() => {
                state.toolParts.push({
                  type: "tool-result",
                  id: part.id,
                  name: part.name,
                  isFailure: part.isFailure,
                  result: output
                });
              })
            ),
            Effect.map((output) =>
              Result.succeed({
                type: "tool-result",
                callId: part.id,
                toolName: part.name,
                outcome: part.isFailure
                  ? { _tag: "Failed", error: JSON.stringify(output) ?? "Tool execution failed" }
                  : { _tag: "Success", output }
              } satisfies AgentEvent)
            )
          );
        case "finish":
          state.hasFinish = true;
          state.finishReason = mapAgentFinishReason(part.reason);
          return Effect.succeed(Result.fail(part));
        default:
          return Effect.succeed(Result.fail(part));
      }
    })
  );

  const stream = Stream.concat(
    Stream.succeed({ type: "turn-started", turn } satisfies AgentEvent),
    Stream.concat(
      parts,
      Stream.unwrap(
        Effect.gen(function* () {
          if (state.pendingApprovals.length > 0) {
            const interaction = readHumanInteraction(profile.toolkitContext);
            if (Option.isNone(interaction)) {
              return yield* new ToolSystemError({
                reason: "toolkit-misconfiguration",
                cause: new Error(
                  "Toolkit produced tool-approval-request parts, but no HumanInteraction service is provided in the toolkit context"
                )
              });
            }
            const responses: Array<ToolApprovalResponsePart> = [];
            for (const pending of state.pendingApprovals) {
              responses.push(yield* resolveApproval(interaction.value, pending.request, pending.approvalId));
            }
            state.approvalParts.push(...responses);
          }
          const saved = yield* appendTurnCheckpoint(store, snapshot, state);
          const turnOutcome: TurnOutcome = state.hasToolCalls
            ? { _tag: "ToolCalls", snapshot: saved }
            : state.hasFinish
              ? { _tag: "Finished", snapshot: saved, finishReason: state.finishReason }
              : { _tag: "Incomplete", snapshot: saved };
          yield* Deferred.succeed(outcome, turnOutcome);
          return Stream.empty;
        })
      )
    )
  );

  return { stream, outcome: Deferred.await(outcome) };
});
