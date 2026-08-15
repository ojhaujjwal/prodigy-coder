import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Ref, Stream } from "effect";
import { AiError, LanguageModel } from "effect/unstable/ai";
import { SessionPersistenceError, SessionStore, SessionWriteFailure } from "../../src/capabilities/session-store.ts";
import { layerNoDeps as memoryStoreLayer } from "../../src/capabilities/memory-session-store.ts";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { makeProdigyAgentLayer, ProdigyAgent } from "../../src/agent/prodigy-agent.ts";
import type { AgentEvent } from "../../src/agent/agent-event.ts";
import { textProfile } from "./agent-helpers.ts";
import { finish, storeLayer, buildWireContext } from "./wire-run.ts";

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

const failingStoreRunLayer = Layer.provideMerge(
  Layer.provideMerge(makeProdigyAgentLayer(textProfile()), failingStoreLayer),
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

describe("ProdigyAgent errors", () => {
  it.effect("rejects an empty prompt before execution", () =>
    Effect.gen(function* () {
      const { agent } = yield* buildWireContext(
        [[{ type: "text-delta", delta: "x" }, finish("stop")]],
        Layer.provideMerge(makeProdigyAgentLayer(textProfile()), storeLayer)
      );

      const { events, exit } = yield* runWithEvents(agent, { prompt: "   " });

      expect(Exit.isFailure(exit)).toBe(true);
      expect(events.some((event) => event.type === "run-ended")).toBe(false);
      if (Exit.isFailure(exit)) {
        const failure = failureFromExit(exit);
        expect(failure).toHaveProperty("_tag", "InvalidRunRequest");
        if (failure._tag === "InvalidRunRequest") {
          expect(failure.reason).toBe("EmptyPrompt");
        }
      }
    })
  );

  it.effect("a model rate-limit error maps to a retryable ModelError", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.provideMerge(Layer.provideMerge(makeProdigyAgentLayer(textProfile()), baseLayers), failingModelLayer)
      );
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));

      const { events, exit } = yield* runWithEvents(agent, { prompt: "Hello" });

      expect(Exit.isFailure(exit)).toBe(true);
      expect(events.some((event) => event.type === "run-ended")).toBe(false);
      if (Exit.isFailure(exit)) {
        const failure = failureFromExit(exit);
        expect(failure).toHaveProperty("_tag", "ModelError");
        if (failure._tag === "ModelError") {
          expect(failure.reason).toBe("RateLimit");
          expect(failure.isRetryable).toBe(true);
        }
      }
    })
  );

  it.effect("a checkpoint write failure maps to SessionStorageError", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(failingStoreRunLayer);
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));

      const { events, exit } = yield* runWithEvents(agent, { prompt: "Hello" });

      expect(Exit.isFailure(exit)).toBe(true);
      expect(events.some((event) => event.type === "run-ended")).toBe(false);
      if (Exit.isFailure(exit)) {
        const failure = failureFromExit(exit);
        expect(failure).toHaveProperty("_tag", "SessionStorageError");
        if (failure._tag === "SessionStorageError") {
          expect(failure.reason).toBe("Write");
        }
      }
    })
  );
});
