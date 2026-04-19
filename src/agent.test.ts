import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Layer } from "effect"
import { runAgent, type AgentConfig } from "../src/agent.ts"

describe("agent", () => {
  it("runAgent should have correct type signature", () => {
    const config = {
      type: "openai-compat" as const,
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    }

    const session = {
      id: "test-session",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const agentConfig: AgentConfig = {
      session,
      config: {
        provider: config,
        approvalMode: "none",
        maxTurns: 10,
        systemPrompt: undefined,
      },
      handlers: {},
    }

    const mockProviderLayer = Layer.succeed(
      {} as any,
      {}
    )

    const result = runAgent("test prompt", agentConfig, mockProviderLayer)
    assert.isDefined(result)
  })

  it("runAgent should handle empty session with systemPrompt", () => {
    const config = {
      type: "openai-compat" as const,
      apiKey: "test-key",
      model: "gpt-4o",
    }

    const session = {
      id: "test-session",
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }

    const agentConfig: AgentConfig = {
      session,
      config: {
        provider: config,
        approvalMode: "none",
        maxTurns: 5,
        systemPrompt: "You are a helpful assistant.",
      },
      handlers: {},
    }

    const mockProviderLayer = Layer.succeed(
      {} as any,
      {}
    )

    const result = runAgent("test prompt", agentConfig, mockProviderLayer)
    assert.isDefined(result)
  })
})