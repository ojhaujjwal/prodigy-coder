import { describe, it, expect } from "@effect/vitest";
import { Schema } from "effect";
import { runAgent, type AgentConfig } from "../src/agent.ts";
import { SessionSchema } from "../src/session.ts";

describe("agent", () => {
  it("runAgent should have correct type signature", () => {
    const config = {
      type: "openai-compat" as const,
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o"
    };

    const session = Schema.decodeUnknownSync(SessionSchema)({
      id: "test-session",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const agentConfig: AgentConfig = {
      session,
      config: {
        provider: config,
        approvalMode: "none",
        maxTurns: 10,
        systemPrompt: undefined
      }
    };

    const result = runAgent(["test prompt"], agentConfig);
    expect(result).toBeDefined();
  });

  it("runAgent should handle empty session with systemPrompt", () => {
    const config = {
      type: "openai-compat" as const,
      apiKey: "test-key",
      model: "gpt-4o"
    };

    const session = Schema.decodeUnknownSync(SessionSchema)({
      id: "test-session",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    const agentConfig: AgentConfig = {
      session,
      config: {
        provider: config,
        approvalMode: "none",
        maxTurns: 5,
        systemPrompt: "You are a helpful assistant."
      }
    };

    const result = runAgent(["test prompt"], agentConfig);
    expect(result).toBeDefined();
  });
});
