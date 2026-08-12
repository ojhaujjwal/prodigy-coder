import { Context, Crypto, Effect, Layer, Option, Result, Schema, Stream } from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type {
  Message,
  SessionCheckpoint,
  SessionSnapshot,
  ToolApprovalRequestPart,
  ToolApprovalResponsePart,
  ToolCallPart,
  ToolResultPart
} from "../capabilities/session.ts";
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
import { decodeRunRequest, generateRunId, validateMaxTurnsOverride, type RunRequest } from "./run-request.ts";
import type { AgentProfile, ProfileAuthorities, ToolkitAuthorities, ToolkitServices } from "./agent-profile.ts";

export class ProdigyAgent extends Context.Service<
  ProdigyAgent,
  {
    readonly run: (request: RunRequest) => Stream.Stream<AgentEvent, AgentError>;
  }
>()("@prodigy/core/agent/prodigy-agent/ProdigyAgent") {}

type AssistantPart = { readonly type: "text"; readonly text: string } | ToolCallPart | ToolApprovalRequestPart;

/** A native approval request booked during a turn, resolved after the parts stream ends. */
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

type TurnPlan = {
  readonly stream: Stream.Stream<AgentEvent, AgentError>;
  readonly state: TurnState;
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

const resolveSession = (
  sessionId: RunRequest["sessionId"],
  store: SessionStore["Service"],
  systemPrompt: string
): Effect.Effect<SessionSnapshot, AgentError> =>
  Effect.gen(function* () {
    if (sessionId === undefined) {
      const snapshot = yield* store
        .create(systemPrompt === "" ? {} : { systemPrompt })
        .pipe(Effect.mapError(agentErrorFromSessionError));
      return {
        ...snapshot,
        session: { ...snapshot.session, messages: [...snapshot.session.messages] }
      };
    }
    const snapshot = yield* store.load(sessionId).pipe(Effect.mapError(agentErrorFromSessionError));
    return {
      ...snapshot,
      session: { ...snapshot.session, messages: [...snapshot.session.messages] }
    };
  });

const appendAndSave = (
  store: SessionStore["Service"],
  snapshot: SessionSnapshot,
  message: Message
): Effect.Effect<SessionSnapshot, AgentError> =>
  Effect.gen(function* () {
    const messages = [...snapshot.session.messages, message];
    const checkpoint: SessionCheckpoint = {
      session: { ...snapshot.session, messages },
      expectedRevision: snapshot.revision
    };
    const saved = yield* store.save(checkpoint).pipe(Effect.mapError(agentErrorFromSessionError));
    return saved;
  });

const decodeJson = (value: unknown): Effect.Effect<JsonValue, ToolSystemError> =>
  Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError((cause) => new ToolSystemError({ reason: "serialization", cause }))
  );

/**
 * Read the `HumanInteraction` service from the toolkit handler context.
 *
 * Effect AI emits `tool-approval-request` parts for any tool whose
 * `needsApproval` option is set, and a provider stream can carry them
 * directly; the type system only requires `HumanInteraction` when a tool's
 * `dependencies` include it. A toolkit that produces approval requests
 * without declaring that dependency is misconfigured, so this read returns
 * `Option.none` and the caller fails the run with a typed `ToolSystemError`
 * rather than throwing at runtime.
 */
const readHumanInteraction = (context: Context.Context<never>): Option.Option<HumanInteraction["Service"]> =>
  Context.getOption(context, HumanInteraction);

/**
 * Resolve a native approval request through the `HumanInteraction` channel.
 *
 * The native `tool-approval-request` part carries an `approvalId` and the
 * `toolCallId` it refers to; the assistant message already records the
 * `tool-call`. The resolution appends the native `tool-approval-response`
 * part (into `approvalParts`) so the next `streamText` call pre-resolves the
 * approval before calling the model again.
 *
 * `Approved` -> the next turn executes the tool handler.
 * `Denied` -> the next turn injects a model-visible `execution-denied` result.
 * `Answered` -> an ask-style answer to a native approval request is an
 * invalid response from the interaction channel, so it is a capability
 * failure (`invalid-response`), never a silent success.
 */
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
    let current = snapshot;
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
      current = yield* appendAndSave(store, current, { role: "assistant", content });
    }
    if (state.toolParts.length > 0 || state.approvalParts.length > 0) {
      const content: ReadonlyArray<ToolResultPart | ToolApprovalResponsePart> = [
        ...state.toolParts,
        ...state.approvalParts
      ];
      current = yield* appendAndSave(store, current, { role: "tool", content });
    }
    return current;
  });

const runTurn = <TTools extends Record<string, Tool.Any>>(
  store: SessionStore["Service"],
  model: LanguageModel.LanguageModel["Service"],
  toolkit: Toolkit.WithHandler<TTools>,
  toolkitContext: Context.Context<ToolkitServices<TTools>>,
  snapshot: SessionSnapshot,
  onSnapshot: (snapshot: SessionSnapshot) => void,
  turn: number
): TurnPlan => {
  const state = emptyTurnState();
  // The user prompt was persisted before the
  // first turn starts, so the model request is always the session transcript.
  const modelPrompt: Prompt.RawInput = snapshot.session.messages;

  const parts = model.streamText({ prompt: modelPrompt, toolkit }).pipe(
    Stream.provideContext(toolkitContext),
    Stream.mapError(agentErrorFromToolError),
    Stream.filterMapEffect((part): Effect.Effect<Result.Result<AgentEvent, unknown>, AgentError> => {
      switch (part.type) {
        case "text-delta":
          state.assistantText += part.delta;
          return Effect.succeed(Result.succeed({ type: "text-delta", delta: part.delta } satisfies AgentEvent));
        case "tool-call":
          if (!Object.hasOwn(toolkit.tools, part.name)) {
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
            (p): p is ToolCallPart => p.type === "tool-call" && p.id === part.toolCallId
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

  return {
    state,
    stream: Stream.concat(
      Stream.succeed({ type: "turn-started", turn } satisfies AgentEvent),
      Stream.concat(
        parts,
        Stream.unwrap(
          Effect.gen(function* () {
            if (state.pendingApprovals.length > 0) {
              const interaction = readHumanInteraction(toolkitContext);
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
            yield* Effect.sync(() => onSnapshot(saved));
            return Stream.empty;
          })
        )
      )
    )
  };
};

const makeRun =
  <TTools extends Record<string, Tool.Any>>(
    store: SessionStore["Service"],
    model: LanguageModel.LanguageModel["Service"],
    toolkit: Toolkit.WithHandler<TTools>,
    toolkitContext: Context.Context<ToolkitServices<TTools>>,
    crypto: Crypto.Crypto,
    profileMaxTurns: number,
    profileSystemPrompt: string
  ): ((request: RunRequest) => Stream.Stream<AgentEvent, AgentError>) =>
  (request) =>
    Stream.suspend(() =>
      Stream.unwrap(
        Effect.gen(function* () {
          const validatedRequest = yield* decodeRunRequest(request);
          const effectiveMaxTurns =
            validatedRequest.maxTurns === undefined
              ? profileMaxTurns
              : yield* validateMaxTurnsOverride(validatedRequest.maxTurns, profileMaxTurns);
          let snapshot = yield* resolveSession(validatedRequest.sessionId, store, profileSystemPrompt);
          const runId = yield* generateRunId.pipe(Effect.provideService(Crypto.Crypto, crypto));
          const sessionId = snapshot.session.id;
          snapshot = yield* appendAndSave(store, snapshot, { role: "user", content: validatedRequest.prompt });

          const runTurns = (turn: number): Stream.Stream<AgentEvent, AgentError> => {
            if (turn > effectiveMaxTurns) {
              return Stream.succeed({
                type: "run-ended",
                result: {
                  _tag: "Stopped",
                  sessionId,
                  turns: turn - 1,
                  reason: "max-turns",
                  limit: effectiveMaxTurns
                }
              } satisfies AgentEvent);
            }
            return Stream.unwrap(
              Effect.sync(() => {
                const plan = runTurn(
                  store,
                  model,
                  toolkit,
                  toolkitContext,
                  snapshot,
                  (next) => {
                    snapshot = next;
                  },
                  turn
                );
                const exhausted = turn >= effectiveMaxTurns;
                return Stream.concat(
                  plan.stream,
                  Stream.unwrap(
                    Effect.sync(() =>
                      plan.state.hasToolCalls
                        ? runTurns(turn + 1)
                        : plan.state.hasFinish
                          ? Stream.succeed({
                              type: "run-ended",
                              result: {
                                _tag: "Finished",
                                sessionId,
                                turns: turn,
                                finishReason: plan.state.finishReason
                              }
                            } satisfies AgentEvent)
                          : exhausted
                            ? Stream.succeed({
                                type: "run-ended",
                                result: {
                                  _tag: "Stopped",
                                  sessionId,
                                  turns: turn,
                                  reason: "max-turns",
                                  limit: effectiveMaxTurns
                                }
                              } satisfies AgentEvent)
                            : runTurns(turn + 1)
                    )
                  )
                );
              })
            );
          };

          return Stream.concat(
            Stream.succeed({ type: "run-started", runId, sessionId } satisfies AgentEvent),
            runTurns(1)
          );
        })
      )
    );

/**
 * The generic composition factory: binds a caller-selected, compile-time
 * checked toolkit and its handler Layer into a stable `ProdigyAgent` service.
 *
 * The profile's toolkit/handler pairing is checked by the compiler (the
 * handler Layer's services must match the toolkit's tools), and the profile's
 * authority requirements propagate through the returned Layer's `R` channel.
 * The toolkit is closed over at construction and can never be replaced through
 * a run request.
 *
 * The layer fails at composition with `ToolSystemError`/`toolkit-misconfiguration`
 * when the toolkit declares approval-gated tools (`needsApproval`) but no
 * `HumanInteraction` service is provided in the toolkit context — the declared
 * case is type-enforced, but `needsApproval` is not part of the toolkit's
 * service types, so the guard closes the remaining hole at startup.
 */
export const makeLayer = <TTools extends Record<string, Tool.Any>, TAuthorities extends ToolkitAuthorities = never>(
  profile: AgentProfile<TTools, TAuthorities>
): Layer.Layer<
  ProdigyAgent,
  ToolSystemError,
  ProfileAuthorities<TTools, TAuthorities> | SessionStore | LanguageModel.LanguageModel | Crypto.Crypto
> =>
  Layer.effect(
    ProdigyAgent,
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const model = yield* LanguageModel.LanguageModel;
      const crypto = yield* Crypto.Crypto;
      // Read the toolkit handler context from the composition root's provided
      // services (the profile's handler Layer + authorities are part of this
      // layer's R channel). The toolkit Effect is resolved against the same
      // context, then the resolved value is closed over for every run.
      const toolkitContext = yield* Effect.context<ToolkitServices<TTools>>();
      const withHandlers = yield* profile.toolkit.pipe(Effect.provideContext(toolkitContext));
      const approvalGatedTools = Object.values(withHandlers.tools).filter((tool) => tool.needsApproval !== undefined);
      if (approvalGatedTools.length > 0 && Option.isNone(Context.getOption(toolkitContext, HumanInteraction))) {
        return yield* new ToolSystemError({
          reason: "toolkit-misconfiguration",
          cause: new Error(
            `Tools [${approvalGatedTools.map((tool) => tool.name).join(", ")}] require approval, ` +
              "but no HumanInteraction service is provided in the toolkit context"
          )
        });
      }
      return ProdigyAgent.of({
        run: makeRun(store, model, withHandlers, toolkitContext, crypto, profile.maxTurns, profile.systemPrompt)
      });
    })
  );

/** The default-composition alias: selects a profile, so it is the same factory. */
export const layerNoDeps = makeLayer;
export const layer = makeLayer;
