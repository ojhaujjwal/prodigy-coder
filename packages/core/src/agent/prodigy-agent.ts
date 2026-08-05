import { Context, Crypto, Effect, Layer, Result, Schema, Stream } from "effect";
import { LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import type {
  Message,
  SessionCheckpoint,
  SessionSnapshot,
  ToolCallPart,
  ToolResultPart
} from "../capabilities/session.ts";
import { SessionStore } from "../capabilities/session-store.ts";
import {
  agentErrorFromSessionError,
  agentErrorFromToolError,
  type AgentError,
  ToolSystemError
} from "./agent-error.ts";
import { mapAgentFinishReason, type AgentEvent, type AgentFinishReason, type JsonValue } from "./agent-event.ts";
import { decodeRunRequest, generateRunId, validateMaxTurnsOverride, type RunRequest } from "./run-request.ts";

export class ProdigyAgent extends Context.Service<
  ProdigyAgent,
  {
    readonly run: (request: RunRequest) => Stream.Stream<AgentEvent, AgentError>;
  }
>()("@prodigy/core/agent/prodigy-agent/ProdigyAgent") {}

type ResolvedSession = {
  snapshot: SessionSnapshot;
  messages: Message[];
};

type AssistantPart = { readonly type: "text"; readonly text: string } | ToolCallPart;

type TurnState = {
  assistantText: string;
  assistantParts: Array<ToolCallPart>;
  toolParts: Array<ToolResultPart>;
  hasToolCalls: boolean;
  hasFinish: boolean;
  finishReason: AgentFinishReason;
};

type ToolkitServices<TTools extends Record<string, Tool.Any>> =
  | Tool.HandlerServices<TTools[keyof TTools]>
  | Tool.ResultDecodingServices<TTools[keyof TTools]>;

type TurnPlan = {
  readonly stream: Stream.Stream<AgentEvent, AgentError>;
  readonly state: TurnState;
};

/**
 * The profile's default turn limit. The typed `AgentProfile.maxTurns` value
 * (ticket 03 / slice 21) will supply this; until then a minimal in-memory
 * default (mirroring the CLI's default of 50) keeps the profile seam testable
 * (ticket 17).
 */
const profileMaxTurns = 50;

const emptyTurnState = (): TurnState => ({
  assistantText: "",
  assistantParts: [],
  toolParts: [],
  hasToolCalls: false,
  hasFinish: false,
  finishReason: "unknown"
});

const resolveSession = (
  sessionId: RunRequest["sessionId"],
  store: SessionStore["Service"]
): Effect.Effect<ResolvedSession, AgentError> =>
  Effect.gen(function* () {
    if (sessionId === undefined) {
      const snapshot = yield* store.create({}).pipe(Effect.mapError(agentErrorFromSessionError));
      return { snapshot, messages: [...snapshot.session.messages] };
    }
    const snapshot = yield* store.load(sessionId).pipe(Effect.mapError(agentErrorFromSessionError));
    return { snapshot, messages: [...snapshot.session.messages] };
  });

const appendAndSave = (
  store: SessionStore["Service"],
  resolved: ResolvedSession,
  message: Message
): Effect.Effect<SessionSnapshot, AgentError> =>
  Effect.gen(function* () {
    const messages = [...resolved.messages, message];
    const checkpoint: SessionCheckpoint = {
      session: { ...resolved.snapshot.session, messages },
      expectedRevision: resolved.snapshot.revision
    };
    const saved = yield* store.save(checkpoint).pipe(Effect.mapError(agentErrorFromSessionError));
    resolved.messages = saved.session.messages;
    resolved.snapshot = saved;
    return saved;
  });

const decodeJson = (value: unknown): Effect.Effect<JsonValue, ToolSystemError> =>
  Schema.decodeUnknownEffect(Schema.Json)(value).pipe(
    Effect.mapError((cause) => new ToolSystemError({ reason: "serialization", cause }))
  );

const appendTurnCheckpoint = (
  store: SessionStore["Service"],
  resolved: ResolvedSession,
  state: TurnState
): Effect.Effect<void, AgentError> =>
  Effect.gen(function* () {
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
      yield* appendAndSave(store, resolved, { role: "assistant", content });
    }
    if (state.toolParts.length > 0) {
      yield* appendAndSave(store, resolved, { role: "tool", content: state.toolParts });
    }
  });

const runTurn = <TTools extends Record<string, Tool.Any>>(
  store: SessionStore["Service"],
  model: LanguageModel.LanguageModel["Service"],
  toolkit: Toolkit.WithHandler<TTools>,
  toolkitContext: Context.Context<ToolkitServices<TTools>>,
  resolved: ResolvedSession,
  turn: number,
  prompt: string
): TurnPlan => {
  const state = emptyTurnState();
  const modelPrompt: Prompt.RawInput =
    turn === 1 ? [...resolved.messages, { role: "user", content: prompt }] : resolved.messages;

  const parts = model.streamText({ prompt: modelPrompt, toolkit }).pipe(
    Stream.provideContext(toolkitContext),
    Stream.mapError(agentErrorFromToolError),
    Stream.filterMapEffect((part): Effect.Effect<Result.Result<AgentEvent, unknown>, ToolSystemError> => {
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
            yield* appendTurnCheckpoint(store, resolved, state);
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
    crypto: Crypto.Crypto
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
          const resolved = yield* resolveSession(validatedRequest.sessionId, store);
          const runId = yield* generateRunId.pipe(Effect.provideService(Crypto.Crypto, crypto));
          const sessionId = resolved.snapshot.session.id;
          yield* appendAndSave(store, resolved, { role: "user", content: validatedRequest.prompt });

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
                const plan = runTurn(store, model, toolkit, toolkitContext, resolved, turn, validatedRequest.prompt);
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

const makeAgentLayer = <TTools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<TTools>,
  toolkitContext: Context.Context<ToolkitServices<TTools>>
) =>
  Layer.effect(
    ProdigyAgent,
    Effect.gen(function* () {
      const store = yield* SessionStore;
      const model = yield* LanguageModel.LanguageModel;
      const crypto = yield* Crypto.Crypto;
      return ProdigyAgent.of({ run: makeRun(store, model, toolkit, toolkitContext, crypto) });
    })
  );

export const layerNoDeps = Layer.unwrap(
  Effect.map(Toolkit.empty, (toolkit) => makeAgentLayer(toolkit, Context.empty()))
);
export const layer = layerNoDeps;

export const makeLayer = <TTools extends Record<string, Tool.Any>>(toolkit: Toolkit.Toolkit<TTools>) =>
  Layer.unwrap(
    Effect.map(toolkit, (withHandlers) =>
      Layer.effect(
        ProdigyAgent,
        Effect.gen(function* () {
          const store = yield* SessionStore;
          const model = yield* LanguageModel.LanguageModel;
          const crypto = yield* Crypto.Crypto;
          const toolkitContext = yield* Effect.context<ToolkitServices<TTools>>();
          return ProdigyAgent.of({ run: makeRun(store, model, withHandlers, toolkitContext, crypto) });
        })
      )
    )
  );
