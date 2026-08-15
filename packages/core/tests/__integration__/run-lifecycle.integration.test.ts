import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Stream } from "effect";
import { makeProdigyAgentLayer } from "../../src/agent/prodigy-agent.ts";
import type { AgentError } from "../../src/agent/agent-error.ts";
import type { AgentEvent } from "../../src/agent/agent-event.ts";
import { createTestSession } from "./helpers.ts";
import { textProfile } from "./agent-helpers.ts";
import { buildWireContext, finish, runWithWireServer, storeLayer } from "./wire-run.ts";

const agentLayer = () => Layer.provideMerge(makeProdigyAgentLayer(textProfile()), storeLayer);

describe("ProdigyAgent run lifecycle (wire-level)", () => {
  it.effect("emits run-started first with RunId + resolved SessionId, then run-ended with Finished", () =>
    Effect.gen(function* () {
      const { events, server } = yield* runWithWireServer(
        [[{ type: "text-delta", delta: "Hello" }, { type: "text-delta", delta: " world" }, finish("stop")]],
        agentLayer(),
        "Hello"
      );

      const started = events[0];
      if (started.type !== "run-started") throw new Error("expected run-started");
      expect(started.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(started.sessionId).toMatch(/^[a-z0-9]{8}$/);

      const last = events[events.length - 1];
      if (last.type !== "run-ended") throw new Error("expected run-ended");
      expect(last.result._tag).toBe("Finished");
      if (last.result._tag === "Finished") {
        expect(last.result.sessionId).toBe(started.sessionId);
        expect(last.result.turns).toBe(1);
        expect(last.result.finishReason).toBe("stop");
      }

      expect(server.calls).toHaveLength(1);
      const requestBody = JSON.stringify(server.calls[0]);
      expect(requestBody).toContain('"role":"user"');
      expect(requestBody).not.toContain('"role":"system"');
    })
  );

  it.effect("streams text deltas in order through the wire mock", () =>
    Effect.gen(function* () {
      const { events } = yield* runWithWireServer(
        [[{ type: "text-delta", delta: "Hello" }, { type: "text-delta", delta: " world" }, finish("stop")]],
        agentLayer(),
        "Hi"
      );

      expect(events.map((e) => e.type)).toEqual([
        "run-started",
        "turn-started",
        "text-delta",
        "text-delta",
        "run-ended"
      ]);
      const deltas = events.filter((e) => e.type === "text-delta").map((e) => (e.type === "text-delta" ? e.delta : ""));
      expect(deltas).toEqual(["Hello", " world"]);
      expect(events.filter((e) => e.type === "run-ended")).toHaveLength(1);
    })
  );

  it.effect("each consumption of the run stream is a fresh run with a fresh RunId", () =>
    Effect.gen(function* () {
      const { agent } = yield* buildWireContext(
        [[{ type: "text-delta", delta: "Hello" }, finish("stop")]],
        agentLayer()
      );

      const stream = agent.run({ prompt: "Hello" });
      const first: ReadonlyArray<AgentEvent> = yield* stream.pipe(Stream.runCollect);
      const second: ReadonlyArray<AgentEvent> = yield* stream.pipe(Stream.runCollect);

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

  it.effect("a missing sessionId fails with SessionNotFound, never a new session", () =>
    Effect.gen(function* () {
      const unknown = createTestSession("00000000");
      const { agent } = yield* buildWireContext(
        [[{ type: "text-delta", delta: "Hello" }, finish("stop")]],
        agentLayer()
      );

      const failure: AgentError = yield* agent
        .run({ prompt: "Hello", sessionId: unknown.id })
        .pipe(Stream.runCollect, Effect.flip);

      expect(failure._tag).toBe("SessionNotFound");
      if (failure._tag !== "SessionNotFound") throw new Error("expected SessionNotFound");
      expect(failure.id).toBe(unknown.id);
    })
  );

  it.effect("early consumer cancellation interrupts without run-ended and without an AgentError", () =>
    Effect.gen(function* () {
      const { agent } = yield* buildWireContext(
        [[{ type: "text-delta", delta: "Hello" }, finish("stop")]],
        agentLayer()
      );

      const exit = yield* agent.run({ prompt: "Hello" }).pipe(Stream.take(1), Stream.runCollect, Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      if (!Exit.isSuccess(exit)) throw new Error("expected success");
      expect(exit.value[0].type).toBe("run-started");
      expect(exit.value.some((e) => e.type === "run-ended")).toBe(false);
    })
  );
});
