import { describe, expect, layer } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Stream } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { LanguageModel, Response } from "effect/unstable/ai";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { SessionStore } from "../../capabilities/session-store.ts";
import { ProdigyAgent, layerNoDeps as agentLayer } from "../prodigy-agent.ts";
import type { AgentEvent } from "../agent-event.ts";

/**
 * A test-only gate service: the `Deferred` that the model double's second part
 * waits on. The test completes it to let the model stream finish.
 */
class StreamGate extends Context.Service<StreamGate, { readonly release: Deferred.Deferred<void> }>()(
  "@prodigy/core/agent/__integration__/prodigy-agent.streaming.test/StreamGate"
) {}

/**
 * A `LanguageModel` double built with `LanguageModel.make` whose provider
 * stream emits the first `text-delta` immediately and gates the second on the
 * shared `StreamGate`. This proves the agent's run stream emits deltas before
 * the model has finished.
 */
const streamingModelLayer = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const gate = yield* StreamGate;
    const first: Response.StreamPartEncoded = { type: "text-delta", id: "1", delta: "Hello" };
    const second: Response.StreamPartEncoded = { type: "text-delta", id: "2", delta: " world" };
    const finish: Response.StreamPartEncoded = {
      type: "finish",
      reason: "stop",
      usage: {
        inputTokens: { uncached: 4, total: 4, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 2, text: 2, reasoning: undefined }
      },
      response: undefined
    };
    return yield* LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () =>
        Stream.concat(
          Stream.succeed(first),
          Stream.suspend(() =>
            Stream.fromEffect(Deferred.await(gate.release)).pipe(Stream.flatMap(() => Stream.succeed(second)))
          )
        ).pipe(Stream.concat(Stream.succeed(finish)))
    });
  })
);

const gateLayer = Layer.effect(
  StreamGate,
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    return StreamGate.of({ release });
  })
);

const testLayer = Layer.provideMerge(
  Layer.provideMerge(
    // `agentLayer` requires `LanguageModel`; the model layer (which itself
    // consumes `StreamGate`) is provided as the dependency (`that`).
    Layer.provideMerge(agentLayer, Layer.provideMerge(streamingModelLayer, gateLayer)),
    memoryStoreLayer
  ),
  BunCrypto.layer
);

const runTypes = (events: ReadonlyArray<AgentEvent>) => events.map((e) => e.type);

layer(testLayer)("ProdigyAgent streaming", (it) => {
  describe("deltas stream before the model finishes (S1)", () => {
    it.effect("the first text-delta is emitted before the model stream's second part is released", () =>
      Effect.gen(function* () {
        const gate = yield* StreamGate;
        const agent = yield* ProdigyAgent;

        // Consume the run stream up to the first delta. The model double gates
        // its second delta on `release`, so if the run is truly streaming the
        // first delta arrives now, before the model has finished.
        const firstDelta: ReadonlyArray<AgentEvent> = yield* agent
          .run({ prompt: "Hi" })
          .pipe(Stream.take(3), Stream.runCollect);

        expect(runTypes(firstDelta)).toEqual(["run-started", "turn-started", "text-delta"]);

        // The model is still pending; there must be no run-ended yet.
        expect(firstDelta.some((e) => e.type === "run-ended")).toBe(false);

        // Release the model; the run completes and emits the remaining delta + run-ended.
        yield* Deferred.succeed(gate.release, undefined);
        const rest: ReadonlyArray<AgentEvent> = yield* agent
          .run({ prompt: "Hi" })
          .pipe(Stream.drop(3), Stream.runCollect);

        expect(runTypes(rest)).toEqual(["text-delta", "run-ended"]);
      })
    );
  });

  describe("prompt checkpoint before first delta (S3)", () => {
    it.effect("saves the user prompt before the model's first part is pulled", () =>
      Effect.gen(function* () {
        const gate = yield* StreamGate;
        const agent = yield* ProdigyAgent;
        const store = yield* SessionStore;

        // Take only up to turn-started; the model stream has not been pulled yet,
        // so the prompt checkpoint must already be persisted.
        const events = yield* agent.run({ prompt: "Hello" }).pipe(Stream.take(2), Stream.runCollect);
        expect(runTypes(events)).toEqual(["run-started", "turn-started"]);

        const started = events[0];
        if (started.type !== "run-started") throw new Error("expected run-started");
        const snapshot = yield* store.load(started.sessionId);
        expect(snapshot.session.messages.map((m) => m.role)).toEqual(["user"]);
        expect(snapshot.session.messages[0]).toMatchObject({ role: "user", content: "Hello" });

        yield* Deferred.succeed(gate.release, undefined);
      })
    );
  });

  describe("assistant checkpoint before run-ended (S4)", () => {
    it.effect("persists the completed assistant text before run-ended, even while streaming", () =>
      Effect.gen(function* () {
        const gate = yield* StreamGate;
        const agent = yield* ProdigyAgent;
        const store = yield* SessionStore;

        yield* Deferred.succeed(gate.release, undefined);
        const events = yield* agent.run({ prompt: "Hi" }).pipe(Stream.runCollect);

        const started = events[0];
        if (started.type !== "run-started") throw new Error("expected run-started");
        const snapshot = yield* store.load(started.sessionId);
        expect(snapshot.session.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
        expect(snapshot.session.messages[1]).toMatchObject({ role: "assistant", content: "Hello world" });
      })
    );
  });
});
