import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { SessionId, type AgentEvent, type RunId } from "@prodigy/core";
import { translateAgentEvent } from "./output-translate.ts";

/** A decoded `SessionId` for use as event fixture data. */
const session = Schema.decodeUnknownSync(SessionId)("abcd1234");

/** A decoded UUIDv7 `RunId` for use as event fixture data. */
const runId: RunId = Schema.decodeUnknownSync(
  Schema.String.pipe(Schema.check(Schema.isUUID(7)), Schema.brand("RunId"))
)("22222222-2222-7222-8222-222222222222");

const runStarted: AgentEvent = { type: "run-started", runId, sessionId: session };
const turnStarted: AgentEvent = { type: "turn-started", turn: 1 };
const textDelta: AgentEvent = { type: "text-delta", delta: "hello" };
const toolCall: AgentEvent = { type: "tool-call", callId: "call-1", toolName: "read", input: "file" };
const toolResultSuccess: AgentEvent = {
  type: "tool-result",
  callId: "call-1",
  toolName: "read",
  outcome: { _tag: "Success", output: "file contents" }
};
const toolResultFailure: AgentEvent = {
  type: "tool-result",
  callId: "call-1",
  toolName: "read",
  outcome: { _tag: "Failed", error: "not found" }
};
const interactionRequested: AgentEvent = {
  type: "interaction-requested",
  request: { question: "What is your name?" }
};
const runFinished: AgentEvent = {
  type: "run-ended",
  result: { _tag: "Finished", sessionId: session, turns: 1, finishReason: "stop" }
};
const runStopped: AgentEvent = {
  type: "run-ended",
  result: { _tag: "Stopped", sessionId: session, turns: 1, reason: "max-turns", limit: 5 }
};

describe("translateAgentEvent", () => {
  it("maps run-started to a session-info event", () => {
    expect(translateAgentEvent(runStarted)).toEqual([{ type: "session-info", sessionId: "abcd1234" }]);
  });

  it("treats turn-started as presentation-internal", () => {
    expect(translateAgentEvent(turnStarted)).toEqual([]);
  });

  it("maps text-delta to a text event", () => {
    expect(translateAgentEvent(textDelta)).toEqual([{ type: "text-delta", delta: "hello" }]);
  });

  it("maps tool-call to a tool-call event", () => {
    expect(translateAgentEvent(toolCall)).toEqual([{ type: "tool-call", id: "call-1", name: "read", params: "file" }]);
  });

  it("maps a successful tool-result to a non-error event", () => {
    expect(translateAgentEvent(toolResultSuccess)).toEqual([
      { type: "tool-result", id: "call-1", name: "read", result: "file contents", isError: false }
    ]);
  });

  it("maps a failed tool-result to an error event", () => {
    expect(translateAgentEvent(toolResultFailure)).toEqual([
      { type: "tool-result", id: "call-1", name: "read", result: "not found", isError: true }
    ]);
  });

  it("treats interaction-requested as presentation-internal", () => {
    expect(translateAgentEvent(interactionRequested)).toEqual([]);
  });

  it("maps a finished run to a finish event", () => {
    expect(translateAgentEvent(runFinished)).toEqual([{ type: "finish", text: "stop" }]);
  });

  it("maps a stopped run to a max-turns error event", () => {
    expect(translateAgentEvent(runStopped)).toEqual([{ type: "error", message: "Max turns exceeded (5)" }]);
  });
});
