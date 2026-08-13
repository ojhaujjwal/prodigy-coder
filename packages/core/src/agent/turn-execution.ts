import { Context, Deferred, Effect, Option, Result, Stream } from "effect";
import { LanguageModel, Prompt, Tool } from "effect/unstable/ai";
import type { SessionSnapshot, ToolApprovalResponsePart } from "../capabilities/session.ts";
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
import type { AgentEvent, AgentFinishReason } from "./agent-event.ts";
import type { ResolvedAgentProfile } from "./profile-resolution.ts";
import { assembleMessages } from "./checkpoint-assembler.ts";
import { emptyTurnState, reducePart } from "./turn-reducer.ts";

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

const readHumanInteraction = (context: Context.Context<never>) => Context.getOption(context, HumanInteraction);

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
      case "InvalidResponse":
        return yield* agentErrorFromHumanInteractionError(new HumanInteractionError({ reason: "InvalidResponse" }));
    }
  });

/**
 * Execute one model/tool exchange and resolve its committed outcome.
 *
 * Model parts stream through the pure reducer, which folds each part into the
 * turn state and the agent event it emits. The outcome is completed only after
 * approval responses and the assistant/tool exchange have been checkpointed.
 */
export const executeTurn = Effect.fn("TurnExecution.execute")(function* <TTools extends Record<string, Tool.Any>>(
  store: SessionStore["Service"],
  model: LanguageModel.LanguageModel["Service"],
  profile: ResolvedAgentProfile<TTools>,
  snapshot: SessionSnapshot,
  turn: number
) {
  let state = emptyTurnState();
  const outcome = yield* Deferred.make<TurnOutcome, AgentError>();
  const modelPrompt: Prompt.RawInput = snapshot.session.messages;
  const parts = model.streamText({ prompt: modelPrompt, toolkit: profile.toolkit }).pipe(
    Stream.provideContext(profile.toolkitContext),
    Stream.mapError(agentErrorFromToolError),
    Stream.filterMapEffect((part) =>
      Result.match(reducePart(profile.toolkit.tools, state, part), {
        onSuccess: ({ state: next, event }) => {
          state = next;
          return Effect.succeed(
            Option.match(event, {
              onNone: () => Result.fail(part),
              onSome: (value) => Result.succeed(value)
            })
          );
        },
        onFailure: (error) => Effect.fail(error)
      })
    )
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
                reason: "ToolkitMisconfiguration",
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
          const messages = assembleMessages(state);
          let saved = snapshot;
          if (messages.length > 0) {
            saved = yield* store
              .save(checkpointWithMessages(snapshot, messages))
              .pipe(Effect.mapError(agentErrorFromSessionError));
          }
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
