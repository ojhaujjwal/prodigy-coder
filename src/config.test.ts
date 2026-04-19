import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { ConfigProvider, Effect } from "effect"
import { AppConfig, loadConfig, maskConfig } from "./config.ts"
import * as FileSystem from "effect/FileSystem"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"

describe("config", () => {
  describe("loadConfig", () => {
    it("loads from .prodigy-coder.json file correctly", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const configContent = JSON.stringify({
          provider: {
            type: "openai-compat",
            apiKey: "file-key",
            baseUrl: "https://custom.example.com/v1",
            model: "gpt-4o-mini",
          },
          approvalMode: "dangerous",
          maxTurns: 100,
          systemPrompt: "Custom prompt",
        })
        yield* fs.writeFileString(".prodigy-coder.json", configContent)

        const config = yield* AppConfig
        assert.equal(config.provider.type, "openai-compat")
        assert.equal(config.provider.apiKey, "file-key")
        assert.equal(config.provider.baseUrl, "https://custom.example.com/v1")
        assert.equal(config.provider.model, "gpt-4o-mini")
        assert.equal(config.approvalMode, "dangerous")
        assert.equal(config.maxTurns, 100)
        assert.equal(config.systemPrompt, "Custom prompt")
      }).pipe(
        Effect.provide(loadConfig()),
        Effect.provide(bunServicesLayer)
      ))

    it("env vars override file values", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const configContent = JSON.stringify({
          provider: {
            type: "openai-compat",
            apiKey: "file-key",
            model: "gpt-4o",
          },
          approvalMode: "none",
          maxTurns: 50,
        })
        yield* fs.writeFileString(".prodigy-coder.json", configContent)

        const config = yield* AppConfig
        assert.equal(config.provider.model, "gpt-4o-mini")
        assert.equal(config.approvalMode, "all")
      }).pipe(
        Effect.provide(loadConfig()),
        Effect.provide(bunServicesLayer),
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              PRODIGY_CODER_MODEL: "gpt-4o-mini",
              PRODIGY_CODER_APPROVAL_MODE: "all",
            })
          )
        )
      ))

    it("missing file returns default config", () =>
      Effect.gen(function* () {
        const config = yield* AppConfig
        assert.equal(config.provider.type, "openai-compat")
        assert.equal(config.provider.model, "gpt-4o")
        assert.equal(config.approvalMode, "none")
        assert.equal(config.maxTurns, 50)
      }).pipe(
        Effect.provide(loadConfig()),
        Effect.provide(bunServicesLayer)
      ))

    it("invalid config file throws error", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const configContent = JSON.stringify({
          provider: {
            type: "invalid-provider",
          },
          approvalMode: "invalid",
        })
        yield* fs.writeFileString(".prodigy-coder.json", configContent)

        yield* AppConfig
      }).pipe(
        Effect.provide(loadConfig()),
        Effect.provide(bunServicesLayer),
        Effect.flip,
        Effect.map((error) => {
          assert.isTrue(error !== undefined)
        })
      ))

    it("explicit config path is used when provided", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const configContent = JSON.stringify({
          provider: {
            type: "anthropic",
            apiKey: "anthropic-key",
            model: "claude-3-5-sonnet-20241022",
          },
          approvalMode: "all",
          maxTurns: 25,
        })
        yield* fs.writeFileString("custom-config.json", configContent)

        const config = yield* AppConfig
        assert.equal(config.provider.type, "anthropic")
        assert.equal(config.provider.apiKey, "anthropic-key")
      }).pipe(
        Effect.provide(loadConfig("custom-config.json")),
        Effect.provide(bunServicesLayer)
      ))
  })

  describe("maskConfig", () => {
    it("masks API keys", () => {
      const config = {
        provider: {
          type: "openai-compat" as const,
          apiKey: "secret-key",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o",
        },
        approvalMode: "none" as const,
        maxTurns: 50,
        systemPrompt: undefined,
      }
      const masked = maskConfig(config)
      assert.equal(masked.provider.apiKey, "***")
    })

    it("preserves undefined API keys", () => {
      const config = {
        provider: {
          type: "openai-compat" as const,
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o",
        },
        approvalMode: "none" as const,
        maxTurns: 50,
        systemPrompt: undefined,
      }
      const masked = maskConfig(config)
      assert.isUndefined(masked.provider.apiKey)
    })
  })
})