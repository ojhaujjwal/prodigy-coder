import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Stream } from "effect";
import { SessionStore } from "../../src/capabilities/session-store.ts";
import { makeProdigyAgentLayer } from "../../src/agent/prodigy-agent.ts";
import type { AgentError } from "../../src/agent/agent-error.ts";
import { echoProfile, scriptedEchoToolkit } from "./agent-helpers.ts";
import { buildWireContext, finish, runWithWireServer, storeLayer } from "./wire-run.ts";

const echoRunLayer = (toolkit: ReturnType<typeof scriptedEchoToolkit>) =>
  Layer.provideMerge(Layer.provideMerge(makeProdigyAgentLayer(echoProfile(toolkit.layer)), storeLayer), toolkit.layer);

describe("ProdigyAgent tools", () => {
  it.effect("executes a tool call and returns the result, then finishes", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const { events } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "call-1", name: "echo", params: { value: "hello" } }, finish("tool-calls")],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        echoRunLayer(toolkit),
        "Use echo"
      );

      expect(events.find((e) => e.type === "tool-call")).toEqual({
        type: "tool-call",
        callId: "call-1",
        toolName: "echo",
        input: { value: "hello" }
      });
      expect(events.find((e) => e.type === "tool-result")).toEqual({
        type: "tool-result",
        callId: "call-1",
        toolName: "echo",
        outcome: { _tag: "Success", output: { value: "echoed" } }
      });
      expect(toolkit.calls).toEqual([{ value: "hello" }]);
      expect(events.at(-1)?.type).toBe("run-ended");
      expect(JSON.parse(JSON.stringify(events))).toEqual(events);
    })
  );

  it.effect("a failing tool emits a Failed result and the run continues", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit({ _tag: "Failure", message: "not available" });
      const { events } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "call-fail", name: "echo", params: { value: "bad" } }, finish("tool-calls")],
          [{ type: "text-delta", delta: "recovered" }, finish("stop")]
        ],
        echoRunLayer(toolkit),
        "Try echo"
      );

      expect(events.find((e) => e.type === "tool-result")).toEqual({
        type: "tool-result",
        callId: "call-fail",
        toolName: "echo",
        outcome: { _tag: "Failed", error: JSON.stringify({ message: "not available" }) }
      });
      expect(events.some((e) => e.type === "text-delta" && e.delta === "recovered")).toBe(true);
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );

  it.effect("a tool-system serialization failure fails the run with ToolSystemError", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const { agent } = yield* buildWireContext(
        [[{ type: "tool-call", id: "call-invalid", name: "echo", params: { value: 42 } }, finish("tool-calls")]],
        echoRunLayer(toolkit)
      );

      const failure: AgentError = yield* agent.run({ prompt: "Use missing" }).pipe(Stream.runCollect, Effect.flip);

      expect(failure._tag).toBe("ToolSystemError");
      if (failure._tag === "ToolSystemError") {
        expect(failure.reason).toBe("Serialization");
      }
    })
  );

  it.effect("executes multiple tool calls in one turn", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const { events } = yield* runWithWireServer(
        [
          [
            { type: "tool-call", id: "call-1", name: "echo", params: { value: "a" } },
            { type: "tool-call", id: "call-2", name: "echo", params: { value: "b" } },
            finish("tool-calls")
          ],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        echoRunLayer(toolkit),
        "Echo twice"
      );

      const toolCalls = events.filter((e) => e.type === "tool-call");
      const toolResults = events.filter((e) => e.type === "tool-result");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls.map((e) => (e.type === "tool-call" ? e.callId : ""))).toEqual(["call-1", "call-2"]);
      expect(toolResults).toHaveLength(2);
      expect(toolkit.calls).toEqual([{ value: "a" }, { value: "b" }]);
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );

  it.effect("executes sequential tool calls across turns", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const { events } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "call-1", name: "echo", params: { value: "first" } }, finish("tool-calls")],
          [{ type: "tool-call", id: "call-2", name: "echo", params: { value: "second" } }, finish("tool-calls")],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        echoRunLayer(toolkit),
        "Echo twice sequentially"
      );

      const toolCalls = events.filter((e) => e.type === "tool-call");
      const toolResults = events.filter((e) => e.type === "tool-result");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls.map((e) => (e.type === "tool-call" ? e.callId : ""))).toEqual(["call-1", "call-2"]);
      expect(toolResults).toHaveLength(2);
      expect(toolkit.calls).toEqual([{ value: "first" }, { value: "second" }]);
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );

  it.effect("continues the loop when a turn has both text and tool-calls", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const { events } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "call-1", name: "echo", params: { value: "x" } }, finish("tool-calls")],
          [
            { type: "text-delta", delta: "interim" },
            { type: "tool-call", id: "call-2", name: "echo", params: { value: "y" } },
            finish("tool-calls")
          ],
          [{ type: "text-delta", delta: "final" }, finish("stop")]
        ],
        echoRunLayer(toolkit),
        "Loop"
      );

      const toolCalls = events.filter((e) => e.type === "tool-call");
      const toolResults = events.filter((e) => e.type === "tool-result");
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
      expect(toolResults.length).toBeGreaterThanOrEqual(2);
      expect(events.some((e) => e.type === "text-delta" && e.delta === "interim")).toBe(true);
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );

  it.effect("persists the full tool transcript to the session store", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const { events, context } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "call-1", name: "echo", params: { value: "hello" } }, finish("tool-calls")],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        echoRunLayer(toolkit),
        "Use echo"
      );

      const started = events[0];
      if (started.type !== "run-started") throw new Error("expected run-started");
      const store = Context.get(context, SessionStore);
      const snapshot = yield* store.load(started.sessionId);
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
