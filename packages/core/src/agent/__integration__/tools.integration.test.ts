import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { SessionStore } from "../../capabilities/session-store.ts";
import { echoProfile, scriptedEchoToolkit, scriptedToolModelLayer } from "./helpers.ts";
import { makeLayer as makeAgentLayer, ProdigyAgent } from "../prodigy-agent.ts";
import type { Response } from "effect/unstable/ai";
import type { AgentError } from "../agent-error.ts";
import type { AgentEvent } from "../agent-event.ts";

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  reason,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
});

const makeRunLayer = (
  turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>,
  toolkit: ReturnType<typeof scriptedEchoToolkit>
) =>
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.provideMerge(
        makeAgentLayer(echoProfile(toolkit.layer)),
        Layer.provideMerge(memoryStoreLayer, BunCrypto.layer)
      ),
      scriptedToolModelLayer(turns)
    ),
    toolkit.layer
  );

const successToolkit = scriptedEchoToolkit();

layer(
  makeRunLayer(
    [
      [{ type: "tool-call", id: "call-1", name: "echo", params: { value: "hello" } }, finish("tool-calls")],
      [{ type: "text-delta", id: "text-1", delta: "done" }, finish("stop")]
    ],
    successToolkit
  )
)("ProdigyAgent tools", (it) => {
  it.effect("emits a tool call and matching result, then continues to a finishing turn", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events: ReadonlyArray<AgentEvent> = yield* agent.run({ prompt: "Use echo" }).pipe(Stream.runCollect);

      expect(events.map((event) => event.type)).toEqual([
        "run-started",
        "turn-started",
        "tool-call",
        "tool-result",
        "turn-started",
        "text-delta",
        "run-ended"
      ]);
      expect(events.find((event) => event.type === "tool-call")).toEqual({
        type: "tool-call",
        callId: "call-1",
        toolName: "echo",
        input: { value: "hello" }
      });
      expect(events.find((event) => event.type === "tool-result")).toEqual({
        type: "tool-result",
        callId: "call-1",
        toolName: "echo",
        outcome: { _tag: "Success", output: { value: "echoed" } }
      });
      expect(JSON.parse(JSON.stringify(events))).toEqual(events);
      expect(successToolkit.calls).toEqual([{ value: "hello" }]);

      const ended = events[events.length - 1];
      expect(ended.type).toBe("run-ended");
      if (ended.type === "run-ended") {
        expect(ended.result._tag).toBe("Finished");
        if (ended.result._tag !== "Finished") throw new Error("expected Finished");
        expect(ended.result.turns).toBe(2);
        expect(ended.result.finishReason).toBe("stop");
      }

      const started = events[0];
      if (started.type !== "run-started") throw new Error("expected run-started");
      const snapshot = yield* (yield* SessionStore).load(started.sessionId);
      expect(snapshot.session.messages).toEqual([
        { role: "user", content: "Use echo" },
        {
          role: "assistant",
          content: [
            { type: "tool-call", id: "call-1", name: "echo", params: { value: "hello" }, providerExecuted: false }
          ]
        },
        {
          role: "tool",
          content: [{ type: "tool-result", id: "call-1", name: "echo", isFailure: false, result: { value: "echoed" } }]
        },
        { role: "assistant", content: "done" }
      ]);
    })
  );
});

const failureToolkit = scriptedEchoToolkit({ _tag: "Failure", message: "not available" });

layer(
  makeRunLayer(
    [
      [{ type: "tool-call", id: "call-fail", name: "echo", params: { value: "bad" } }, finish("tool-calls")],
      [{ type: "text-delta", id: "text-2", delta: "recovered" }, finish("stop")]
    ],
    failureToolkit
  )
)("ProdigyAgent recoverable tool failures", (it) => {
  it.effect("emits a failed tool result and continues the run", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events: ReadonlyArray<AgentEvent> = yield* agent.run({ prompt: "Try echo" }).pipe(Stream.runCollect);

      expect(events.find((event) => event.type === "tool-result")).toEqual({
        type: "tool-result",
        callId: "call-fail",
        toolName: "echo",
        outcome: { _tag: "Failed", error: JSON.stringify({ message: "not available" }) }
      });
      expect(events.some((event) => event.type === "text-delta" && event.delta === "recovered")).toBe(true);
      expect(failureToolkit.calls).toEqual([{ value: "bad" }]);
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );
});

layer(
  makeRunLayer(
    [[{ type: "tool-call", id: "call-invalid", name: "echo", params: { value: 42 } }, finish("tool-calls")]],
    scriptedEchoToolkit()
  )
)("ProdigyAgent tool-system failures", (it) => {
  it.effect("fails with ToolSystemError and emits no events after the bad call", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const failure: AgentError = yield* agent.run({ prompt: "Use missing" }).pipe(Stream.runCollect, Effect.flip);

      expect(failure._tag).toBe("ToolSystemError");
      if (failure._tag === "ToolSystemError") {
        expect(failure.reason).toBe("serialization");
      }
    })
  );
});
