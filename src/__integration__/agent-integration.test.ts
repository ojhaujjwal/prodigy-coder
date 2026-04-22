import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { runAgent, type AgentConfig } from "../agent.ts";
import { createMockLLMLayer, createStubToolkit, createTestConfig, createTestSession } from "./helpers.ts";
import { Layer } from "effect";

class TestError extends Error {
  readonly _tag = "TestError";
}

const runAgentWithMocks = (
  mockResponses: import("./helpers.ts").TurnResponse[],
  configOverrides?: Partial<import("../config.ts").ConfigData>,
  sessionMessages?: import("../session.ts").Message[]
) => {
  const config = createTestConfig(configOverrides);
  const session = createTestSession(sessionMessages);
  const { layer } = createStubToolkit();

  const agentConfig: AgentConfig = {
    session,
    config
  };

  const mockLLMLayer = createMockLLMLayer(mockResponses);

  return runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));
};

describe("agent integration", () => {
  it.effect("Test 1: Text-only response", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hello, world!" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const result = yield* runAgentWithMocks(mockResponses);

      const textDeltas = result.filter((e) => e.type === "text-delta");
      const finishes = result.filter((e) => e.type === "finish");
      const toolCalls = result.filter((e) => e.type === "tool-call");
      const toolResults = result.filter((e) => e.type === "tool-result");

      expect(textDeltas.length).toBe(1);
      expect(textDeltas[0].delta).toBe("Hello, world!");
      expect(finishes.length).toBe(1);
      expect(toolCalls.length).toBe(0);
      expect(toolResults.length).toBe(0);
    })
  );

  it.effect("Test 2: Single tool call then finish", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [
          { type: "text-delta", delta: "Done" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const toolCalls = result.filter((e) => e.type === "tool-call");
      const toolResults = result.filter((e) => e.type === "tool-result");
      const finishes = result.filter((e) => e.type === "finish");

      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].name).toBe("read");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].isError).toBe(false);
      expect(toolResults[0].result).toBe("stub read result");
      expect(finishes.length).toBe(1);
    })
  );

  it.effect("Test 3: Two tool calls in one turn", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "read", params: { filePath: "/a" } },
          { type: "tool-call", id: "call-2", name: "write", params: { filePath: "/b", content: "x" } }
        ],
        [{ type: "finish", reason: "stop" }]
      ];

      const { layer, calls } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const toolCalls = result.filter((e) => e.type === "tool-call");
      const toolResults = result.filter((e) => e.type === "tool-result");

      expect(toolCalls.length).toBe(2);
      expect(toolResults.length).toBe(2);

      expect(calls["read"]).toEqual([{ filePath: "/a" }]);
      expect(calls["write"]).toEqual([{ filePath: "/b", content: "x" }]);
    })
  );

  it.effect("Test 5: Tool execution error fails the stream", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/bad" } }],
        [{ type: "finish", reason: "stop" }]
      ];

      const { layer } = createStubToolkit({ read: new TestError("file not found") });
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const error = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer)).pipe(Effect.flip);

      expect(error._tag).toBe("AiError");
    })
  );

  it.effect("Test 6: approvalMode none", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "shell", params: { command: "ls" } }],
        [{ type: "finish", reason: "stop" }]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const approvalRequests = result.filter((e) => e.type === "tool-approval-request");

      expect(approvalRequests.length).toBe(0);
    })
  );

  it.effect("Test 7: approvalMode dangerous", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "shell", params: { command: "ls" } },
          { type: "tool-call", id: "call-2", name: "read", params: { filePath: "/test.txt" } }
        ],
        [{ type: "finish", reason: "stop" }]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "dangerous" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const approvalRequests = result.filter((e) => e.type === "tool-approval-request");

      expect(approvalRequests.length).toBe(1);
      expect(approvalRequests[0].toolName).toBe("shell");
    })
  );

  it.effect("Test 8: maxTurns 1 with tool call", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const errors = result.filter((e) => e.type === "error");

      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain("Max turns exceeded");
    })
  );

  it.effect("Test 9: System prompt prepended", () =>
    Effect.gen(function* () {
      const capturedPrompts: Array<{ content: Array<{ role: string; content: unknown }> }> = [];

      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "text-delta", delta: "Hi" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ systemPrompt: "You are a helpful assistant." });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses, (prompt) => {
        capturedPrompts.push(JSON.parse(JSON.stringify(prompt)));
      });

      yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      expect(capturedPrompts.length).toBe(1);
      const prompt = capturedPrompts[0];
      expect(
        prompt.content.some(
          (m) =>
            m.role === "system" && typeof m.content === "string" && m.content.includes("You are a helpful assistant")
        )
      ).toBe(true);
    })
  );

  it.effect("Test 10: Session messages accumulate", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [
          { type: "text-delta", delta: "Done" },
          { type: "finish", reason: "stop" }
        ]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };

      const mockLLMLayer = createMockLLMLayer(mockResponses);

      yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      expect(agentConfig.session.messages.length >= 2).toBe(true);
      expect(agentConfig.session.messages.some((m) => m.role === "user")).toBe(true);
    })
  );

  it.effect("Test 11: approvalMode all requests approval for all tools", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          { type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } },
          { type: "tool-call", id: "call-2", name: "shell", params: { command: "ls" } }
        ],
        [{ type: "finish", reason: "stop" }]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "all" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const approvalRequests = result.filter((e) => e.type === "tool-approval-request");

      expect(approvalRequests.length).toBe(2);
      expect(approvalRequests[0].toolName).toBe("read");
      expect(approvalRequests[1].toolName).toBe("shell");
    })
  );

  it.effect("Test 12: maxTurns text-only stops after max turns", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "text-delta", delta: "Turn 1" }],
        [{ type: "text-delta", delta: "Turn 2" }]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none", maxTurns: 2 });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const textDeltas = result.filter((e) => e.type === "text-delta");
      const errors = result.filter((e) => e.type === "error");

      expect(textDeltas.length).toBe(2);
      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain("Max turns exceeded");
    })
  );

  it.effect("Test 13: Multi-turn text then tool then finish", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "text-delta", delta: "Let me check" }],
        [{ type: "tool-call", id: "call-1", name: "read", params: { filePath: "/test.txt" } }],
        [{ type: "finish", reason: "stop" }]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const eventTypes = result.map((e) => e.type);

      expect(eventTypes).toContain("text-delta");
      expect(eventTypes).toContain("tool-call");
      expect(eventTypes).toContain("tool-result");
      expect(eventTypes).toContain("finish");
      expect(eventTypes.indexOf("text-delta")).toBeLessThan(eventTypes.indexOf("tool-call"));
      expect(eventTypes.indexOf("tool-call")).toBeLessThan(eventTypes.indexOf("tool-result"));
      expect(eventTypes.indexOf("tool-result")).toBeLessThan(eventTypes.indexOf("finish"));
    })
  );

  it.effect("Test 14: Tool result with array encodedResult is newline-joined", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [{ type: "tool-call", id: "call-1", name: "grep", params: { pattern: "test", path: "/tmp" } }],
        [{ type: "finish", reason: "stop" }]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const toolResults = result.filter((e) => e.type === "tool-result");

      expect(toolResults.length).toBe(1);
      expect(typeof toolResults[0].result).toBe("string");
      expect(toolResults[0].result).toBe("stub grep result");
    })
  );

  it.todo("Test 15: Tool result with object encodedResult is JSON stringified");

  it.effect("Test 16: Preliminary tool result is ignored", () =>
    Effect.gen(function* () {
      const mockResponses: import("./helpers.ts").TurnResponse[] = [
        [
          {
            type: "tool-result",
            id: "call-1",
            name: "read",
            result: "ignored",
            preliminary: true
          }
        ],
        [{ type: "finish", reason: "stop" }]
      ];

      const { layer } = createStubToolkit();
      const config = createTestConfig({ approvalMode: "none" });
      const session = createTestSession();
      const agentConfig: AgentConfig = { session, config };
      const mockLLMLayer = createMockLLMLayer(mockResponses);

      const result = yield* runAgent("test prompt", agentConfig, Layer.merge(mockLLMLayer, layer));

      const toolResults = result.filter((e) => e.type === "tool-result");

      expect(toolResults.length).toBe(0);
    })
  );
});
