import { describe, expect } from "@effect/vitest";
import { it } from "vitest";
import { assembleMessages } from "./checkpoint-assembler.ts";
import { emptyTurnState, type TurnState } from "./turn-reducer.ts";

describe("assembleMessages", () => {
  it("assembles assistant text before tool calls, then groups tool results", () => {
    const state: TurnState = {
      assistantText: "Hello",
      assistantParts: [{ type: "tool-call", id: "c1", name: "echo", params: { value: "hi" }, providerExecuted: false }],
      toolParts: [{ type: "tool-result", id: "c1", name: "echo", isFailure: false, result: { value: "ok" } }],
      approvalParts: [],
      pendingApprovals: [],
      hasToolCalls: true,
      hasFinish: false,
      finishReason: "unknown"
    };
    expect(assembleMessages(state)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Hello" },
          { type: "tool-call", id: "c1", name: "echo", params: { value: "hi" }, providerExecuted: false }
        ]
      },
      {
        role: "tool",
        content: [{ type: "tool-result", id: "c1", name: "echo", isFailure: false, result: { value: "ok" } }]
      }
    ]);
  });

  it("returns no messages for an empty turn", () => {
    expect(assembleMessages(emptyTurnState())).toEqual([]);
  });

  it("emits a string assistant content when only text is present", () => {
    const textOnly: TurnState = { ...emptyTurnState(), assistantText: "hello" };
    expect(assembleMessages(textOnly)).toEqual([{ role: "assistant", content: "hello" }]);
  });

  it("groups approval responses with tool results in the tool message", () => {
    const state: TurnState = {
      ...emptyTurnState(),
      toolParts: [{ type: "tool-result", id: "c1", name: "echo", isFailure: false, result: { value: "ok" } }],
      approvalParts: [{ type: "tool-approval-response", approvalId: "a1", approved: true }]
    };
    expect(assembleMessages(state)).toEqual([
      {
        role: "tool",
        content: [
          { type: "tool-result", id: "c1", name: "echo", isFailure: false, result: { value: "ok" } },
          { type: "tool-approval-response", approvalId: "a1", approved: true }
        ]
      }
    ]);
  });
});
