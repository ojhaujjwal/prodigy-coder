import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import { LanguageModel } from "effect/unstable/ai";
import { makeProdigyAgentLayer, ProdigyAgent } from "../../src/agent/prodigy-agent.ts";
import type { AgentError } from "../../src/agent/agent-error.ts";
import type { AgentEvent } from "../../src/agent/agent-event.ts";
import { textProfile } from "./agent-helpers.ts";
import { storeLayer } from "./wire-run.ts";

const finishPart: import("effect/unstable/ai").Response.StreamPartEncoded = {
  type: "finish",
  reason: "stop",
  usage: {
    inputTokens: { uncached: 4, total: 4, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2, reasoning: undefined }
  },
  response: undefined
};

/** A model that streams one delta per turn and never emits a finish part. */
const neverFinishModelLayer = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () => Stream.fromIterable([{ type: "text-delta", id: "1", delta: "still going" }])
  })
);

const runLayer = Layer.provideMerge(
  Layer.provideMerge(makeProdigyAgentLayer(textProfile()), storeLayer),
  neverFinishModelLayer
);

describe("ProdigyAgent maxTurns", () => {
  it.effect("run({ maxTurns: 2 }) emits two turns then Stopped with the limit", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(runLayer);
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));

      const events = yield* agent.run({ prompt: "Hello", maxTurns: 2 }).pipe(Stream.runCollect);
      expect(events.filter((e) => e.type === "turn-started")).toHaveLength(2);
      const ended = events[events.length - 1];
      if (ended.type !== "run-ended") throw new Error("expected run-ended");
      expect(ended.result).toMatchObject({ _tag: "Stopped", reason: "max-turns", limit: 2 });
      if (ended.result._tag === "Stopped") {
        expect(ended.result.turns).toBe(2);
        const started = events[0];
        if (started.type !== "run-started") throw new Error("expected run-started");
        expect(ended.result.sessionId).toBe(started.sessionId);
      }
    })
  );

  it.effect("an invalid maxTurns fails with InvalidRunRequest before any run events", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(runLayer);
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));

      const events: Array<AgentEvent> = [];
      const failure: AgentError = yield* agent.run({ prompt: "Hello", maxTurns: 0 }).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            events.push(event);
          })
        ),
        Stream.runCollect,
        Effect.flip
      );

      expect(failure._tag).toBe("InvalidRunRequest");
      if (failure._tag === "InvalidRunRequest") {
        expect(failure.reason).toBe("InvalidMaxTurns");
      }
      expect(events).toHaveLength(0);
    })
  );

  it.effect("run without maxTurns exhausts the profile default and emits Stopped with that limit", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(runLayer);
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));

      const events = yield* agent.run({ prompt: "Hello" }).pipe(Stream.runCollect);
      expect(events.filter((e) => e.type === "turn-started")).toHaveLength(50);
      const ended = events[events.length - 1];
      if (ended.type !== "run-ended") throw new Error("expected run-ended");
      expect(ended.result).toMatchObject({ _tag: "Stopped", reason: "max-turns", limit: 50 });
    })
  );

  it.effect("an override beyond the profile bound fails with OutOfBoundsOverride", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(runLayer);
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));

      const failure: AgentError = yield* agent
        .run({ prompt: "Hello", maxTurns: 51 })
        .pipe(Stream.runCollect, Effect.flip);
      expect(failure._tag).toBe("InvalidRunRequest");
      if (failure._tag === "InvalidRunRequest") {
        expect(failure.reason).toBe("OutOfBoundsOverride");
      }
    })
  );

  it.effect("a non-integer maxTurns fails with InvalidMaxTurns", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(runLayer);
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));

      const failure: AgentError = yield* agent
        .run({ prompt: "Hello", maxTurns: 1.5 })
        .pipe(Stream.runCollect, Effect.flip);
      expect(failure._tag).toBe("InvalidRunRequest");
      if (failure._tag === "InvalidRunRequest") {
        expect(failure.reason).toBe("InvalidMaxTurns");
      }
    })
  );

  it.effect("a model that finishes on the last allowed turn emits Finished, not Stopped", () =>
    Effect.gen(function* () {
      const finishFirstTurnModelLayer = Layer.effect(
        LanguageModel.LanguageModel,
        LanguageModel.make({
          generateText: () => Effect.succeed([]),
          streamText: () => Stream.fromIterable([{ type: "text-delta", id: "1", delta: "done" }, finishPart])
        })
      );
      const context = yield* Layer.build(
        Layer.provideMerge(
          Layer.provideMerge(makeProdigyAgentLayer(textProfile()), storeLayer),
          finishFirstTurnModelLayer
        )
      );
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));

      const events = yield* agent.run({ prompt: "Hello", maxTurns: 1 }).pipe(Stream.runCollect);
      const ended = events[events.length - 1];
      if (ended.type !== "run-ended") throw new Error("expected run-ended");
      expect(ended.result._tag).toBe("Finished");
      if (ended.result._tag === "Finished") {
        expect(ended.result.turns).toBe(1);
        expect(ended.result.finishReason).toBe("stop");
      }
    })
  );
});
