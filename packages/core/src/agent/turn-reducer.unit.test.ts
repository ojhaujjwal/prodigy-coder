import { describe, expect } from "@effect/vitest";
import { it } from "vitest";
import { Option, Result, Schema } from "effect";
import { Response, Tool } from "effect/unstable/ai";
import { emptyTurnState, reducePart } from "./turn-reducer.ts";

const EchoTool = Tool.make("echo", {
  description: "Echo a value",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
  failureMode: "return"
});
const tools = { echo: EchoTool };

describe("reducePart", () => {
  it("appends text deltas and emits a text-delta event", () => {
    const reduction = Result.getOrThrow(
      reducePart(tools, emptyTurnState(), Response.makePart("text-delta", { id: "t1", delta: "Hel" }))
    );
    expect(reduction.state.assistantText).toBe("Hel");
    expect(Option.getOrThrow(reduction.event)).toEqual({ type: "text-delta", delta: "Hel" });
  });

  it("records a tool call and emits its decoded params", () => {
    const reduction = Result.getOrThrow(
      reducePart(
        tools,
        emptyTurnState(),
        Response.toolCallPart({ id: "c1", name: "echo", params: { value: "hi" }, providerExecuted: false })
      )
    );
    expect(reduction.state.hasToolCalls).toBe(true);
    expect(reduction.state.assistantParts).toEqual([
      { type: "tool-call", id: "c1", name: "echo", params: { value: "hi" }, providerExecuted: false }
    ]);
    expect(Option.getOrThrow(reduction.event)).toEqual({
      type: "tool-call",
      callId: "c1",
      toolName: "echo",
      input: { value: "hi" }
    });
  });

  it("fails with UnknownTool for an unregistered tool name", () => {
    const result = reducePart(
      tools,
      emptyTurnState(),
      Response.toolCallPart({ id: "c1", name: "nope", params: {}, providerExecuted: false })
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("UnknownTool");
    }
  });

  it("resolves an approval request from its matching tool call without re-decoding", () => {
    let state = emptyTurnState();
    state = Result.getOrThrow(
      reducePart(
        tools,
        state,
        Response.toolCallPart({ id: "c1", name: "echo", params: { value: "hi" }, providerExecuted: false })
      )
    ).state;
    const reduction = Result.getOrThrow(
      reducePart(tools, state, Response.toolApprovalRequestPart({ approvalId: "a1", toolCallId: "c1" }))
    );
    expect(reduction.state.pendingApprovals).toEqual([
      {
        request: { toolName: "echo", callId: "c1", input: { value: "hi" } },
        approvalId: "a1",
        toolCallId: "c1"
      }
    ]);
    expect(Option.getOrThrow(reduction.event)).toEqual({
      type: "interaction-requested",
      request: { toolName: "echo", callId: "c1", input: { value: "hi" } }
    });
  });

  it("fails with Serialization when an approval request has no matching tool call", () => {
    const result = reducePart(
      tools,
      emptyTurnState(),
      Response.toolApprovalRequestPart({ approvalId: "a1", toolCallId: "ghost" })
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.reason).toBe("Serialization");
    }
  });

  it("records a tool result and emits a Success outcome", () => {
    const reduction = Result.getOrThrow(
      reducePart(
        tools,
        emptyTurnState(),
        Response.toolResultPart({
          id: "c1",
          name: "echo",
          isFailure: false,
          result: { value: "ok" },
          encodedResult: { value: "ok" },
          providerExecuted: false,
          preliminary: false
        })
      )
    );
    expect(reduction.state.toolParts).toEqual([
      { type: "tool-result", id: "c1", name: "echo", isFailure: false, result: { value: "ok" } }
    ]);
    expect(Option.getOrThrow(reduction.event)).toEqual({
      type: "tool-result",
      callId: "c1",
      toolName: "echo",
      outcome: { _tag: "Success", output: { value: "ok" } }
    });
  });

  it("skips preliminary tool results", () => {
    const state = emptyTurnState();
    const reduction = Result.getOrThrow(
      reducePart(
        tools,
        state,
        Response.toolResultPart({
          id: "c1",
          name: "echo",
          isFailure: false,
          result: {},
          encodedResult: {},
          providerExecuted: false,
          preliminary: true
        })
      )
    );
    expect(Option.isNone(reduction.event)).toBe(true);
    expect(reduction.state).toEqual(state);
  });

  it("marks a finish with the mapped reason and emits no event", () => {
    const reduction = Result.getOrThrow(
      reducePart(
        tools,
        emptyTurnState(),
        Response.makePart("finish", {
          reason: "stop",
          usage: new Response.Usage({
            inputTokens: { uncached: undefined, total: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: undefined, text: undefined, reasoning: undefined }
          }),
          response: undefined
        })
      )
    );
    expect(reduction.state.hasFinish).toBe(true);
    expect(reduction.state.finishReason).toBe("stop");
    expect(Option.isNone(reduction.event)).toBe(true);
  });

  it("ignores parts it does not handle", () => {
    const state = emptyTurnState();
    const reduction = Result.getOrThrow(reducePart(tools, state, Response.makePart("text-end", { id: "e1" })));
    expect(Option.isNone(reduction.event)).toBe(true);
    expect(reduction.state).toEqual(state);
  });
});
