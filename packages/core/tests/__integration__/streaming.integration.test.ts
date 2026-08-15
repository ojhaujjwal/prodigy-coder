import { describe, expect, layer } from "@effect/vitest";
import { Context, Deferred, Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";
import { SessionStore } from "../../src/capabilities/session-store.ts";
import { makeProdigyAgentLayer, ProdigyAgent } from "../../src/agent/prodigy-agent.ts";
import type { AgentEvent } from "../../src/agent/agent-event.ts";
import { textProfile } from "./agent-helpers.ts";
import { storeLayer } from "./wire-run.ts";

/**
 * A test-only gate service: the `Deferred` that the model double's second part
 * waits on. The test completes it to let the model stream finish.
 */
class StreamGate extends Context.Service<StreamGate, { readonly release: Deferred.Deferred<void> }>()(
  "@prodigy/core/tests/__integration__/streaming.integration.test/StreamGate"
) {}

/**
 * A `LanguageModel` double whose provider stream emits the first `text-delta`
 * immediately and gates the second on the shared `StreamGate`. This proves the
 * agent's run stream emits deltas before the model has finished.
 */
const streamingModelLayer = Layer.effect(
  LanguageModel.LanguageModel,
  Effect.gen(function* () {
    const gate = yield* StreamGate;
    const first: Response.StreamPartEncoded = { type: "text-delta", id: "1", delta: "Hello" };
    const second: Response.StreamPartEncoded = { type: "text-delta", id: "2", delta: " world" };
    const finishPart: Response.StreamPartEncoded = {
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
        ).pipe(Stream.concat(Stream.succeed(finishPart)))
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
  Layer.provideMerge(Layer.provideMerge(makeProdigyAgentLayer(textProfile()), streamingModelLayer), gateLayer),
  storeLayer
);

const runTypes = (events: ReadonlyArray<AgentEvent>) => events.map((e) => e.type);

layer(testLayer)("ProdigyAgent streaming", (it) => {
  describe("deltas stream before the model finishes (S1)", () => {
    it.effect("the first text-delta is emitted before the model stream's second part is released", () =>
      Effect.gen(function* () {
        const gate = yield* StreamGate;
        const agent = yield* ProdigyAgent;

        const firstDelta: ReadonlyArray<AgentEvent> = yield* agent
          .run({ prompt: "Hi" })
          .pipe(Stream.take(3), Stream.runCollect);

        expect(runTypes(firstDelta)).toEqual(["run-started", "turn-started", "text-delta"]);
        expect(firstDelta.some((e) => e.type === "run-ended")).toBe(false);

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
