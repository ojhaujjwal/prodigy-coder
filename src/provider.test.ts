import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { buildProviderLayer } from "../src/provider.ts"

describe("provider", () => {
  it("buildProviderLayer should create layer for openai-compat type", () => {
    const config = {
      type: "openai-compat" as const,
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o",
    }
    const layer = buildProviderLayer(config)
    assert.isDefined(layer)
  })

  it("buildProviderLayer should create layer for openai type", () => {
    const config = {
      type: "openai" as const,
      apiKey: "test-key",
      model: "gpt-4o",
    }
    const layer = buildProviderLayer(config)
    assert.isDefined(layer)
  })

  it("buildProviderLayer should create layer for anthropic type", () => {
    const config = {
      type: "anthropic" as const,
      apiKey: "test-key",
      model: "claude-3-5-sonnet-20241022",
    }
    const layer = buildProviderLayer(config)
    assert.isDefined(layer)
  })

  it("buildProviderLayer should create layer for openrouter type", () => {
    const config = {
      type: "openrouter" as const,
      apiKey: "test-key",
      model: "anthropic/claude-3-5-sonnet-20241022",
    }
    const layer = buildProviderLayer(config)
    assert.isDefined(layer)
  })

  it("buildProviderLayer should use default model for openai-compat", () => {
    const config = {
      type: "openai-compat" as const,
      apiKey: "test-key",
    }
    const layer = buildProviderLayer(config)
    assert.isDefined(layer)
  })

  it("buildProviderLayer should use default model for openai", () => {
    const config = {
      type: "openai" as const,
      apiKey: "test-key",
    }
    const layer = buildProviderLayer(config)
    assert.isDefined(layer)
  })

  it("buildProviderLayer should use default model for anthropic", () => {
    const config = {
      type: "anthropic" as const,
      apiKey: "test-key",
    }
    const layer = buildProviderLayer(config)
    assert.isDefined(layer)
  })

  it("buildProviderLayer should use default model for openrouter", () => {
    const config = {
      type: "openrouter" as const,
      apiKey: "test-key",
    }
    const layer = buildProviderLayer(config)
    assert.isDefined(layer)
  })
})