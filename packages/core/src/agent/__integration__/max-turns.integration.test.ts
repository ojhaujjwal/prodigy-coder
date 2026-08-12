import { describe, expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer, Stream } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { LanguageModel } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { textProfile } from "./helpers.ts";
import { ProdigyAgent, makeProdigyAgentLayer as agentLayer } from "../prodigy-agent.ts";
import type { AgentError } from "../agent-error.ts";
import type { AgentEvent } from "../agent-event.ts";

const finishPart: Response.StreamPartEncoded = {
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

/** A model that emits a delta and finishes on the first turn. */
const finishFirstTurnModelLayer = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () => Stream.fromIterable([{ type: "text-delta", id: "1", delta: "done" }, finishPart])
  })
);

const storeLayer = Layer.provideMerge(memoryStoreLayer, BunCrypto.layer);

const runLayer = Layer.provideMerge(Layer.provideMerge(agentLayer(textProfile()), storeLayer), neverFinishModelLayer);

const runTypes = (events: ReadonlyArray<AgentEvent>) => events.map((e) => e.type);

layer(runLayer)("ProdigyAgent maxTurns", (it) => {
  describe("override honored (R1)", () => {
    it.effect(
      "run({ maxTurns: 2 }) emits two turn-started then one run-ended with Stopped, and completes normally",
      () =>
        Effect.gen(function* () {
          const agent = yield* ProdigyAgent;
          const exit = yield* agent.run({ prompt: "Hello", maxTurns: 2 }).pipe(Stream.runCollect, Effect.exit);
          expect(Exit.isSuccess(exit)).toBe(true);
          if (!Exit.isSuccess(exit)) throw new Error("expected success");
          const events = Array.from(exit.value);

          const types = runTypes(events);
          expect(types).toEqual([
            "run-started",
            "turn-started",
            "text-delta",
            "turn-started",
            "text-delta",
            "run-ended"
          ]);
          expect(events.filter((e) => e.type === "turn-started")).toHaveLength(2);
          expect(events.filter((e) => e.type === "run-ended")).toHaveLength(1);

          const ended = events[events.length - 1];
          expect(ended.type).toBe("run-ended");
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
  });

  describe("profile default (R2)", () => {
    it.effect("run without maxTurns exhausts the profile default and emits Stopped with that limit", () =>
      Effect.gen(function* () {
        const agent = yield* ProdigyAgent;
        // The minimal in-memory profile default (mirroring the CLI's 50) caps
        // the run; a never-finishing model runs to the limit and stops.
        const events: ReadonlyArray<AgentEvent> = yield* agent.run({ prompt: "Hello" }).pipe(Stream.runCollect);

        expect(events.filter((e) => e.type === "turn-started")).toHaveLength(50);

        const ended = events[events.length - 1];
        if (ended.type !== "run-ended") throw new Error("expected run-ended");
        expect(ended.result).toMatchObject({ _tag: "Stopped", reason: "max-turns", limit: 50 });
      })
    );
  });

  describe("invalid override (R3)", () => {
    it.effect("a non-positive maxTurns fails the stream with InvalidRunRequest before any session work", () =>
      Effect.gen(function* () {
        const agent = yield* ProdigyAgent;

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
          expect(failure.reason).toBe("invalid-max-turns");
        }

        // Validation precedes session resolution: no run events are emitted.
        expect(events).toHaveLength(0);
      })
    );

    it.effect("an override beyond the profile bound fails the stream with out-of-bounds-override", () =>
      Effect.gen(function* () {
        const agent = yield* ProdigyAgent;

        const failure: AgentError = yield* agent
          .run({ prompt: "Hello", maxTurns: 51 })
          .pipe(Stream.runCollect, Effect.flip);

        expect(failure._tag).toBe("InvalidRunRequest");
        if (failure._tag === "InvalidRunRequest") {
          expect(failure.reason).toBe("out-of-bounds-override");
        }
      })
    );

    it.effect("a non-integer maxTurns fails the stream with invalid-max-turns", () =>
      Effect.gen(function* () {
        const agent = yield* ProdigyAgent;

        const failure: AgentError = yield* agent
          .run({ prompt: "Hello", maxTurns: 1.5 })
          .pipe(Stream.runCollect, Effect.flip);

        expect(failure._tag).toBe("InvalidRunRequest");
        if (failure._tag === "InvalidRunRequest") {
          expect(failure.reason).toBe("invalid-max-turns");
        }
      })
    );
  });

  layer(Layer.provideMerge(Layer.provideMerge(agentLayer(textProfile()), storeLayer), finishFirstTurnModelLayer))(
    "ProdigyAgent maxTurns finish-within-limit",
    (it) => {
      it.effect("a model that finishes on the last allowed turn emits Finished, not Stopped", () =>
        Effect.gen(function* () {
          const agent = yield* ProdigyAgent;
          const events: ReadonlyArray<AgentEvent> = yield* agent
            .run({ prompt: "Hello", maxTurns: 1 })
            .pipe(Stream.runCollect);

          const ended = events[events.length - 1];
          if (ended.type !== "run-ended") throw new Error("expected run-ended");
          expect(ended.result._tag).toBe("Finished");
          if (ended.result._tag === "Finished") {
            expect(ended.result.turns).toBe(1);
            expect(ended.result.finishReason).toBe("stop");
          }
        })
      );
    }
  );
});
