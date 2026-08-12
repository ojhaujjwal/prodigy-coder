import { expect, layer } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Ref, Stream } from "effect";
import { SessionPersistenceError, SessionStore, SessionWriteFailure } from "../../capabilities/session-store.ts";
import { AiError, LanguageModel } from "effect/unstable/ai";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { textProfile } from "./helpers.ts";
import { ProdigyAgent, makeProdigyAgentLayer as agentLayer } from "../prodigy-agent.ts";
import type { AgentEvent } from "../agent-event.ts";

const emptyModelLayer = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () => Stream.empty
  })
);

const failingModelLayer = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () =>
      Stream.fail(
        AiError.make({
          module: "test",
          method: "streamText",
          reason: new AiError.RateLimitError({})
        })
      )
  })
);

const baseLayers = Layer.provideMerge(memoryStoreLayer, BunCrypto.layer);
const failingStoreLayer = Layer.effect(
  SessionStore,
  Effect.gen(function* () {
    const store = yield* SessionStore;
    return {
      create: store.create,
      load: store.load,
      save: () =>
        Effect.fail(
          new SessionPersistenceError({
            reason: new SessionWriteFailure({ id: "session", cause: new Error("disk") })
          })
        )
    };
  })
).pipe(Layer.provide(baseLayers));
const validRunLayer = Layer.provideMerge(Layer.provideMerge(agentLayer(textProfile()), baseLayers), emptyModelLayer);
const failingModelRunLayer = Layer.provideMerge(
  Layer.provideMerge(agentLayer(textProfile()), baseLayers),
  failingModelLayer
);
const failingStoreRunLayer = Layer.provideMerge(
  Layer.provideMerge(agentLayer(textProfile()), failingStoreLayer),
  Layer.provideMerge(BunCrypto.layer, emptyModelLayer)
);

const failureFromExit = <E>(exit: Exit.Exit<unknown, E>): E => {
  if (!Exit.isFailure(exit)) throw new Error("expected failure");
  const reason = exit.cause.reasons.find(Cause.isFailReason);
  if (reason === undefined) throw new Error("expected typed failure");
  return reason.error;
};

const runWithEvents = (agent: ProdigyAgent["Service"], request: Parameters<ProdigyAgent["Service"]["run"]>[0]) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<AgentEvent>>([]);
    const exit = yield* agent.run(request).pipe(
      Stream.tap((event) => Ref.update(events, (current) => [...current, event])),
      Stream.runCollect,
      Effect.exit
    );
    return { events: yield* Ref.get(events), exit };
  });

layer(validRunLayer)("ProdigyAgent request errors", (it) => {
  it.effect("rejects an empty prompt before execution", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const result = yield* runWithEvents(agent, { prompt: "   " });

      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.events.some((event) => event.type === "run-ended")).toBe(false);
      if (Exit.isFailure(result.exit)) {
        const failure = failureFromExit(result.exit);
        expect(failure._tag).toBe("InvalidRunRequest");
        if (failure._tag === "InvalidRunRequest") {
          expect(failure.reason).toBe("empty-prompt");
        }
      }
    })
  );
});

layer(failingStoreRunLayer)("ProdigyAgent storage errors", (it) => {
  it.effect("maps a checkpoint write failure to SessionStorageError", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const result = yield* runWithEvents(agent, { prompt: "Hello" });

      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.events.some((event) => event.type === "run-ended")).toBe(false);
      if (Exit.isFailure(result.exit)) {
        const failure = failureFromExit(result.exit);
        expect(failure._tag).toBe("SessionStorageError");
        if (failure._tag === "SessionStorageError") {
          expect(failure.reason).toBe("write");
        }
      }
    })
  );
});

layer(failingModelRunLayer)("ProdigyAgent model errors", (it) => {
  it.effect("maps a failing model to a retryable ModelError", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const result = yield* runWithEvents(agent, { prompt: "Hello" });

      expect(Exit.isFailure(result.exit)).toBe(true);
      expect(result.events.some((event) => event.type === "run-ended")).toBe(false);
      if (Exit.isFailure(result.exit)) {
        const failure = failureFromExit(result.exit);
        expect(failure._tag).toBe("ModelError");
        if (failure._tag === "ModelError") {
          expect(failure.reason).toBe("rate-limit");
          expect(failure.isRetryable).toBe(true);
        }
      }
    })
  );
});
