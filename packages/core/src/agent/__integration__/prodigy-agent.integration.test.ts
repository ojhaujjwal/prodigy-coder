import { describe, expect, layer } from "@effect/vitest";
import { Effect, Exit, Layer, Stream } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { SessionStore } from "../../capabilities/session-store.ts";
import { createTestSession } from "../../__integration__/helpers.ts";
import { recordingLanguageModelLayer, testLanguageModelLayer } from "../test-helpers.ts";
import { textProfile } from "./helpers.ts";
import { PositiveInt } from "../agent-profile.ts";
import { ProdigyAgent, makeProdigyAgentLayer as agentLayer } from "../prodigy-agent.ts";
import type { AgentError } from "../agent-error.ts";
import type { AgentEvent } from "../agent-event.ts";

const textDoubleLayer = testLanguageModelLayer([
  { type: "text-delta", id: "1", delta: "Hello" },
  { type: "text-delta", id: "2", delta: " world" },
  {
    type: "finish",
    reason: "stop",
    usage: {
      inputTokens: { uncached: 4, total: 4, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 2, text: 2, reasoning: undefined }
    },
    response: undefined
  }
]);

const storeLayer = Layer.provideMerge(memoryStoreLayer, BunCrypto.layer);

const runLayer = Layer.provideMerge(agentLayer(textProfile()), storeLayer).pipe(Layer.provideMerge(textDoubleLayer));

const runAndCollect = (request: { prompt: string; sessionId?: import("../../capabilities/session.ts").SessionId }) =>
  Effect.gen(function* () {
    const agent = yield* ProdigyAgent;
    const events = yield* agent.run(request).pipe(Stream.runCollect);
    return Array.from(events);
  });

layer(runLayer)("ProdigyAgent", (it) => {
  describe("run-started + fresh session (R1)", () => {
    it.effect("emits run-started first with a RunId and a resolved SessionId, then run-ended", () =>
      Effect.gen(function* () {
        const events: AgentEvent[] = yield* runAndCollect({ prompt: "Hello" });

        expect(events[0]).toMatchObject({ type: "run-started" });
        const started = events[0];
        if (started.type !== "run-started") throw new Error("expected run-started");
        expect(started.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(started.sessionId).toMatch(/^[a-z0-9]{8}$/);

        const last = events[events.length - 1];
        expect(last).toMatchObject({ type: "run-ended" });
        if (last.type !== "run-ended") throw new Error("expected run-ended");
        expect(last.result._tag).toBe("Finished");
        if (last.result._tag !== "Finished") throw new Error("expected Finished");
        expect(last.result.sessionId).toBe(started.sessionId);
        expect(last.result.turns).toBe(1);
        expect(last.result.finishReason).toBe("stop");
      })
    );
  });

  describe("text streaming + Finished (R2)", () => {
    it.effect("emits turn-started then text-deltas in order, with mapped finishReason", () =>
      Effect.gen(function* () {
        const events: AgentEvent[] = yield* runAndCollect({ prompt: "Hi" });

        const types = events.map((e) => e.type);
        expect(types).toEqual(["run-started", "turn-started", "text-delta", "text-delta", "run-ended"]);

        const deltas = events
          .filter((e) => e.type === "text-delta")
          .map((e) => (e.type === "text-delta" ? e.delta : ""));
        expect(deltas).toEqual(["Hello", " world"]);
      })
    );

    it.effect("a text-only model emits exactly one run-ended and then completes", () =>
      Effect.gen(function* () {
        const events: AgentEvent[] = yield* runAndCollect({ prompt: "Hi" });
        const ended = events.filter((e) => e.type === "run-ended");
        expect(ended).toHaveLength(1);
      })
    );
  });

  describe("laziness + fresh RunId (R3)", () => {
    it.effect("calling run performs no session effects; each consumption is a fresh run", () =>
      Effect.gen(function* () {
        const agent = yield* ProdigyAgent;

        const stream = agent.run({ prompt: "Hello" });
        const first: AgentEvent[] = yield* stream.pipe(Stream.runCollect);
        const second: AgentEvent[] = yield* stream.pipe(Stream.runCollect);

        const firstStarted = first[0];
        const secondStarted = second[0];
        if (firstStarted.type !== "run-started" || secondStarted.type !== "run-started") {
          throw new Error("expected run-started");
        }
        expect(firstStarted.runId).not.toBe(secondStarted.runId);
        expect(firstStarted.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(secondStarted.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      })
    );
  });

  describe("provider prompt contract (R6)", () => {
    const { layer: recordingLayer, prompts } = recordingLanguageModelLayer([
      { type: "text-delta", id: "1", delta: "Hello" },
      {
        type: "finish",
        reason: "stop",
        usage: {
          inputTokens: { uncached: 4, total: 4, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined }
        },
        response: undefined
      }
    ]);

    const recordingRunLayer = Layer.provideMerge(
      Layer.provideMerge(agentLayer(textProfile()), storeLayer),
      recordingLayer
    );

    layer(recordingRunLayer)("provider prompt", (it) => {
      it.effect("the first model request contains exactly one user prompt — no duplication", () =>
        Effect.gen(function* () {
          const agent = yield* ProdigyAgent;
          const events = yield* agent.run({ prompt: "Hello" }).pipe(Stream.runCollect);
          expect(Array.from(events).some((e) => e.type === "run-ended")).toBe(true);

          expect(prompts).toHaveLength(1);
          const prompt = prompts[0];
          const userMessages = prompt.content.filter((m) => m.role === "user");
          expect(userMessages).toHaveLength(1);
          const parts = userMessages[0]?.content ?? [];
          expect(parts).toHaveLength(1);
          const part = parts[0];
          if (part?.type !== "text") throw new Error("expected text part");
          expect(part.text).toBe("Hello");
          expect(prompt.content.filter((m) => m.role === "system")).toHaveLength(0);
        })
      );
    });

    const { layer: promptRecordingLayer, prompts: promptPrompts } = recordingLanguageModelLayer([
      { type: "text-delta", id: "1", delta: "Hello" },
      {
        type: "finish",
        reason: "stop",
        usage: {
          inputTokens: { uncached: 4, total: 4, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined }
        },
        response: undefined
      }
    ]);

    const promptRunLayer = Layer.provideMerge(
      Layer.provideMerge(agentLayer(textProfile(PositiveInt.make(50), "You are a pirate")), storeLayer),
      promptRecordingLayer
    );

    layer(promptRunLayer)("profile systemPrompt", (it) => {
      it.effect("a profile systemPrompt seeds the transcript and reaches the model as a system message", () =>
        Effect.gen(function* () {
          const agent = yield* ProdigyAgent;
          const store = yield* SessionStore;
          const events = yield* agent.run({ prompt: "Ahoy" }).pipe(Stream.runCollect);
          expect(Array.from(events).some((e) => e.type === "run-ended")).toBe(true);

          // The first model request carries the system message before the user prompt.
          expect(promptPrompts).toHaveLength(1);
          const prompt = promptPrompts[0];
          const systemMessages = prompt.content.filter((m) => m.role === "system");
          expect(systemMessages).toHaveLength(1);
          expect(systemMessages[0]?.content).toBe("You are a pirate");

          // The seeded system message is persisted in the session transcript.
          const started = events.find((e) => e.type === "run-started");
          if (started?.type !== "run-started") throw new Error("expected run-started");
          const snapshot = yield* store.load(started.sessionId);
          expect(snapshot.session.messages[0]).toEqual({ role: "system", content: "You are a pirate" });
        })
      );
    });
  });

  describe("SessionNotFound (R4)", () => {
    it.effect("a missing sessionId fails with agent-level SessionNotFound, never a new session", () =>
      Effect.gen(function* () {
        const unknown = createTestSession("00000000");
        const agent = yield* ProdigyAgent;

        const failure: AgentError = yield* agent
          .run({ prompt: "Hello", sessionId: unknown.id })
          .pipe(Stream.runCollect, Effect.flip);

        expect(failure._tag).toBe("SessionNotFound");
        if (failure._tag !== "SessionNotFound") throw new Error("expected SessionNotFound");
        expect(failure.id).toBe(unknown.id);
      })
    );
  });

  describe("interruption (R5)", () => {
    it.effect("early consumer cancellation interrupts without run-ended and without an AgentError", () =>
      Effect.gen(function* () {
        const agent = yield* ProdigyAgent;
        const stream = agent.run({ prompt: "Hello" });

        const exit = yield* stream.pipe(Stream.take(1), Stream.runCollect, Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        if (!Exit.isSuccess(exit)) throw new Error("expected success");
        expect(exit.value[0].type).toBe("run-started");
        expect(exit.value.some((e) => e.type === "run-ended")).toBe(false);
      })
    );
  });
});
