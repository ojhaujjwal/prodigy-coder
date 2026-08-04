import { Context, Crypto, Effect, Layer, Ref, Result, Stream } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";
import type { Message, SessionCheckpoint, SessionSnapshot } from "../capabilities/session.ts";
import { SessionStore, type SessionError } from "../capabilities/session-store.ts";
import { agentErrorFromModelError, type AgentError } from "./agent-error.ts";
import { mapAgentFinishReason, type AgentEvent, type AgentFinishReason } from "./agent-event.ts";
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

/** Resolve session identity: load a supplied id, otherwise create a fresh session. */
const resolveSession = (
  sessionId: RunRequest["sessionId"],
  store: SessionStore["Service"]
): Effect.Effect<ResolvedSession, AgentError> =>
  Effect.gen(function* () {
    if (sessionId === undefined) {
      const snapshot = yield* store.create({});
      return { snapshot, messages: [...snapshot.session.messages] };
    }
    const snapshot = yield* store.load(sessionId);

    return { snapshot, messages: [...snapshot.session.messages] };
  });

/** Append a message to the working transcript and checkpoint the session. */
const appendAndSave = (
  store: SessionStore["Service"],
  resolved: ResolvedSession,
  message: Message
): Effect.Effect<SessionSnapshot, SessionError> =>
  Effect.gen(function* () {
    const messages = [...resolved.messages, message];
    const checkpoint: SessionCheckpoint = {
      session: { ...resolved.snapshot.session, messages },
      expectedRevision: resolved.snapshot.revision
    };
    const saved = yield* store.save(checkpoint);
    resolved.messages = saved.session.messages;
    resolved.snapshot = saved;
    return saved;
  });

/**
 * Project one model turn into a stream of `text-delta` events, pulling parts
 * lazily from the model. The completed assistant text (a single string, never
 * a full event buffer) and the finish reason are returned once the model
 * stream ends.
 */
const runTurn = (
  store: SessionStore["Service"],
  model: LanguageModel.LanguageModel["Service"],
  resolved: ResolvedSession,
  prompt: string,
  finishReasonRef: Ref.Ref<AgentFinishReason>
): Stream.Stream<AgentEvent, AgentError> => {
  let assistantText = "";

  const modelPrompt: Prompt.RawInput = [...resolved.messages, { role: "user", content: prompt }];

  return model.streamText({ prompt: modelPrompt }).pipe(
    Stream.filter((part) => part.type === "text-delta" || part.type === "finish"),
    Stream.filterMap((part) => {
      switch (part.type) {
        case "text-delta":
          assistantText += part.delta;
          return Result.succeed({ type: "text-delta", delta: part.delta } satisfies AgentEvent);
        case "finish":
          Effect.runSync(Ref.update(finishReasonRef, () => mapAgentFinishReason(part.reason)));
          return Result.fail(part);
        default:
          return Result.fail(part);
      }
    }),
    Stream.mapError(agentErrorFromModelError),
    Stream.ensuring(
      Effect.gen(function* () {
        if (assistantText.length > 0) {
          yield* appendAndSave(store, resolved, { role: "assistant", content: assistantText });
        }
      }).pipe(Effect.orDie)
    ),
    Stream.orDie
  );
};

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
): Stream.Stream<AgentEvent, AgentError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const resolved = yield* resolveSession(request.sessionId, store);

      const runId = yield* generateRunId.pipe(Effect.provideService(Crypto.Crypto, crypto));
      const sessionId = resolved.snapshot.session.id;

      yield* appendAndSave(store, resolved, { role: "user", content: request.prompt });

      let turn = 1;
      const finishReasonRef = Ref.makeUnsafe<AgentFinishReason>("unknown");

      const turnLoop = Stream.concat(
        Stream.succeed({ type: "turn-started", turn } satisfies AgentEvent),
        runTurn(store, model, resolved, request.prompt, finishReasonRef)
      );

      // Built lazily: `run-ended` must carry the finish reason captured from
      // the model's `finish` part, which is only known once the turn stream
      // has been fully consumed.
      const runEnded = Stream.unwrap(
        Effect.map(Ref.get(finishReasonRef), (reason) =>
          Stream.succeed({
            type: "run-ended",
            result: { _tag: "Finished", sessionId, turns: turn, finishReason: reason }
          } satisfies AgentEvent)
        )
      );

      return Stream.concat(
        Stream.succeed({ type: "run-started", runId, sessionId } satisfies AgentEvent),
        Stream.concat(turnLoop, runEnded)
      );
    })
  );

const make = Effect.gen(function* () {
  const store = yield* SessionStore;
  const model = yield* LanguageModel.LanguageModel;
  const crypto = yield* Crypto.Crypto;

  const run = (request: RunRequest): Stream.Stream<AgentEvent, AgentError> =>
    Stream.suspend(() => runBody(store, model, crypto, request));

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
