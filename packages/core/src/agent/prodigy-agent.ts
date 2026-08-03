import { Context, Crypto, Effect, Layer, Stream } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";
import type { Message, SessionCheckpoint, SessionSnapshot } from "../capabilities/session.ts";
import { SessionStore } from "../capabilities/session-store.ts";
import { SessionNotFound, SessionStorageError, type AgentError } from "./agent-error.ts";
import { mapAgentFinishReason, type AgentEvent, type AgentFinishReason, type AgentResult } from "./agent-event.ts";
import { generateRunId, type RunRequest } from "./run-request.ts";

/**
 * The canonical Prodigy agent service: `run` returns a lazy stream of
 * `AgentEvent`s. Calling `run` performs no effects; each consumption of the
 * stream is a fresh run with a fresh `RunId`. Interruption terminates the run
 * without `run-ended` and without an `AgentError`.
 */
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

/** Map a store persistence reason tag onto the agent's neutral vocabulary. */
const storageReason = (tag: string): SessionStorageError["reason"] => {
  switch (tag) {
    case "SessionConflict":
      return "conflict";
    case "SessionEncodeFailure":
      return "encode";
    case "SessionWriteFailure":
      return "write";
    case "SessionReadFailure":
      return "read";
    default:
      return "decode";
  }
};

/** Resolve session identity: load a supplied id, otherwise create a fresh session. */
const resolveSession = (
  sessionId: RunRequest["sessionId"],
  store: SessionStore["Service"]
): Effect.Effect<ResolvedSession, AgentError> =>
  Effect.gen(function* () {
    if (sessionId === undefined) {
      const snapshot = yield* store
        .create({})
        .pipe(Effect.mapError((error) => new SessionStorageError({ reason: storageReason(error.reason._tag) })));
      return { snapshot, messages: [...snapshot.session.messages] };
    }
    const snapshot = yield* store
      .load(sessionId)
      .pipe(
        Effect.mapError((error) =>
          error.reason._tag === "SessionNotFound"
            ? new SessionNotFound({ sessionId })
            : new SessionStorageError({ reason: storageReason(error.reason._tag) })
        )
      );
    return { snapshot, messages: [...snapshot.session.messages] };
  });

/** Append a message to the working transcript and checkpoint the session. */
const appendAndSave = (
  store: SessionStore["Service"],
  resolved: ResolvedSession,
  message: Message
): Effect.Effect<SessionSnapshot, SessionStorageError> =>
  Effect.gen(function* () {
    const messages = [...resolved.messages, message];
    const checkpoint: SessionCheckpoint = {
      session: { ...resolved.snapshot.session, messages },
      expectedRevision: resolved.snapshot.revision
    };
    const saved = yield* store
      .save(checkpoint)
      .pipe(Effect.mapError((error) => new SessionStorageError({ reason: storageReason(error.reason._tag) })));
    resolved.messages = saved.session.messages;
    resolved.snapshot = saved;
    return saved;
  });

/**
 * Run one model turn: stream the model over the transcript plus the user
 * prompt, project parts, and persist the completed assistant exchange.
 * Returns the projected `text-delta` events for the turn.
 */
const runTurn = (
  store: SessionStore["Service"],
  model: LanguageModel.LanguageModel["Service"],
  resolved: ResolvedSession,
  prompt: string
): Effect.Effect<{ readonly finishReason: AgentFinishReason; readonly deltas: string[] }, AgentError> =>
  Effect.gen(function* () {
    const deltas: string[] = [];
    let finishReason: AgentFinishReason | undefined;

    const modelPrompt: Prompt.RawInput = [...resolved.messages, { role: "user", content: prompt }];

    yield* model.streamText({ prompt: modelPrompt }).pipe(
      Stream.runForEach((part) => {
        switch (part.type) {
          case "text-delta":
            deltas.push(part.delta);
            return Effect.void;
          case "finish":
            finishReason = mapAgentFinishReason(part.reason);
            return Effect.void;
          default:
            return Effect.void;
        }
      }),
      Effect.orDie
    );

    const assistantText = deltas.join("");
    if (assistantText.length > 0) {
      yield* appendAndSave(store, resolved, { role: "assistant", content: assistantText });
    }

    return { finishReason: finishReason ?? "unknown", deltas };
  });

/**
 * Build the body of a run: session resolution, the prompt checkpoint, the
 * turn loop, and the terminal `run-ended`. All of it runs inside the returned
 * stream's pull effect, so it is lazy per consumption and interruptible.
 */
const runBody = (
  store: SessionStore["Service"],
  model: LanguageModel.LanguageModel["Service"],
  crypto: Crypto.Crypto,
  request: RunRequest
): Effect.Effect<ReadonlyArray<AgentEvent>, AgentError> =>
  Effect.gen(function* () {
    const resolved = yield* resolveSession(request.sessionId, store);

    const runId = yield* generateRunId.pipe(Effect.provideService(Crypto.Crypto, crypto));
    const sessionId = resolved.snapshot.session.id;
    const events: AgentEvent[] = [{ type: "run-started", runId, sessionId }];

    yield* appendAndSave(store, resolved, { role: "user", content: request.prompt });

    let turn = 1;
    let finishReason: AgentFinishReason;
    while (true) {
      events.push({ type: "turn-started", turn });
      const outcome = yield* runTurn(store, model, resolved, request.prompt);
      for (const delta of outcome.deltas) {
        events.push({ type: "text-delta", delta });
      }
      finishReason = outcome.finishReason;
      break;
    }

    const result: AgentResult = { _tag: "Finished", sessionId, turns: turn, finishReason };
    events.push({ type: "run-ended", result });
    return events;
  });

const make = Effect.gen(function* () {
  const store = yield* SessionStore;
  const model = yield* LanguageModel.LanguageModel;
  const crypto = yield* Crypto.Crypto;

  const run = (request: RunRequest): Stream.Stream<AgentEvent, AgentError> =>
    Stream.suspend(() => Stream.fromIterableEffect(runBody(store, model, crypto, request)));

  return ProdigyAgent.of({ run });
});

/**
 * The dependency-preserving `ProdigyAgent` layer: requires `SessionStore`,
 * `LanguageModel`, and `Crypto`. The module never constructs a concrete
 * toolkit or provider.
 */
export const layerNoDeps = Layer.effect(ProdigyAgent, make);

/** Alias of {@link layerNoDeps} for composition roots that install the platform services themselves. */
export const layer = layerNoDeps;
