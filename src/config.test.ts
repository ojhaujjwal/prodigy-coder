import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { AppConfig, loadConfig, maskConfig, ConfigSchema } from "./config.ts"
import * as FileSystem from "effect/FileSystem"
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices"

const CONFIG_DATA = {
  provider: {
    type: "openai-compat" as const,
    apiKey: "file-key",
    baseUrl: "https://custom.example.com/v1",
    model: "gpt-4o-mini",
  },
  approvalMode: "dangerous" as const,
  maxTurns: 100,
  systemPrompt: "Custom prompt",
}

const CONFIG_CONTENT = Schema.encodeSync(Schema.fromJsonString(ConfigSchema))(CONFIG_DATA)

const CUSTOM_CONFIG_DATA = {
  provider: {
    type: "anthropic" as const,
    apiKey: "anthropic-key",
    model: "claude-3-5-sonnet-20241022",
  },
  approvalMode: "all" as const,
  maxTurns: 25,
  systemPrompt: undefined,
}

const CUSTOM_CONFIG_CONTENT = Schema.encodeSync(Schema.fromJsonString(ConfigSchema))(CUSTOM_CONFIG_DATA)

const ENV_OVERRIDE_CONFIG_DATA = {
  provider: {
    type: "openai-compat" as const,
    apiKey: "file-key",
    model: "gpt-4o",
  },
  approvalMode: "none" as const,
  maxTurns: 50,
  systemPrompt: undefined,
}

const ENV_OVERRIDE_CONFIG_CONTENT = Schema.encodeSync(Schema.fromJsonString(ConfigSchema))(ENV_OVERRIDE_CONFIG_DATA)

let testTmpDir: string
let counter = 0

const getTmpDir = () => Effect.sync(() => testTmpDir)

const homeLayer = (home: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({ HOME: home })
  )

const setupTmpDir = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    counter++
    testTmpDir = `/tmp/prodigy-config-test-${Date.now()}-${counter}`
    yield* fs.makeDirectory(testTmpDir)
  }).pipe(Effect.provide(bunServicesLayer))

const teardownTmpDir = () =>
  Effect.flatMap(getTmpDir(), (tmpDir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(tmpDir, { recursive: true }).pipe(
        Effect.catchTag("PlatformError", () => Effect.void)
      )
    }).pipe(Effect.provide(bunServicesLayer))
  )

const writeConfigFile = (content: string, filename = ".prodigy-coder.json") =>
  Effect.flatMap(getTmpDir(), (tmpDir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(`${tmpDir}/${filename}`, content)
    }).pipe(Effect.provide(bunServicesLayer))
  )

const runWithConfig = <A, E, R>(effect: Effect.Effect<A, E, R | AppConfig>) =>
  Effect.flatMap(getTmpDir(), (home) =>
    effect.pipe(
      Effect.provide(
        loadConfig().pipe(
          Layer.provideMerge(
            Layer.merge(bunServicesLayer, homeLayer(home))
          )
        )
      )
    )
  )

const runWithConfigPath = <A, E, R>(filename: string, effect: Effect.Effect<A, E, R | AppConfig>) =>
  Effect.flatMap(getTmpDir(), (home) =>
    effect.pipe(
      Effect.provide(
        loadConfig(`${home}/${filename}`).pipe(
          Layer.provideMerge(
            Layer.merge(bunServicesLayer, homeLayer(home))
          )
        )
      )
    )
  )

const runWithConfigAndEnv = <A, E, R>(env: Record<string, string>, effect: Effect.Effect<A, E, R | AppConfig>) =>
  Effect.flatMap(getTmpDir(), (home) =>
    effect.pipe(
      Effect.provide(
        loadConfig().pipe(
          Layer.provideMerge(
            Layer.merge(
              Layer.merge(bunServicesLayer, homeLayer(home)),
              ConfigProvider.layer(ConfigProvider.fromUnknown(env))
            )
          )
        )
      )
    )
  )

describe("config", () => {
  describe("loadConfig", () => {
    it.effect("loads from .prodigy-coder.json file correctly", () =>
      setupTmpDir().pipe(
        Effect.andThen(writeConfigFile(CONFIG_CONTENT)),
        Effect.andThen(
          runWithConfig(Effect.gen(function* () {
            const config = yield* AppConfig
            assert.equal(config.provider.type, "openai-compat")
            assert.equal(config.provider.apiKey, "file-key")
            assert.equal(config.provider.baseUrl, "https://custom.example.com/v1")
            assert.equal(config.provider.model, "gpt-4o-mini")
            assert.equal(config.approvalMode, "dangerous")
            assert.equal(config.maxTurns, 100)
            assert.equal(config.systemPrompt, "Custom prompt")
          }))
        ),
        Effect.ensuring(teardownTmpDir())
      ))

    it.effect("missing file returns default config", () =>
      setupTmpDir().pipe(
        Effect.andThen(
          runWithConfig(Effect.gen(function* () {
            const config = yield* AppConfig
            assert.equal(config.provider.type, "openai-compat")
            assert.equal(config.provider.model, "gpt-4o")
            assert.equal(config.approvalMode, "none")
            assert.equal(config.maxTurns, 50)
          }))
        ),
        Effect.ensuring(teardownTmpDir())
      ))

    it.effect("invalid config file throws error", () =>
      setupTmpDir().pipe(
        Effect.andThen(writeConfigFile('{"provider":{"type":"invalid-provider"},"approvalMode":"invalid"}')),
        Effect.andThen(
          runWithConfig(Effect.gen(function* () {
            yield* AppConfig
          }))
        ),
        Effect.flip,
        Effect.ensuring(teardownTmpDir())
      ))

    it.effect("explicit config path is used when provided", () =>
      setupTmpDir().pipe(
        Effect.andThen(writeConfigFile(CUSTOM_CONFIG_CONTENT, "custom-config.json")),
        Effect.andThen(
          runWithConfigPath("custom-config.json", Effect.gen(function* () {
            const config = yield* AppConfig
            assert.equal(config.provider.type, "anthropic")
            assert.equal(config.provider.apiKey, "anthropic-key")
          }))
        ),
        Effect.ensuring(teardownTmpDir())
      ))

    it.effect("env vars override file values", () =>
      setupTmpDir().pipe(
        Effect.andThen(writeConfigFile(ENV_OVERRIDE_CONFIG_CONTENT)),
        Effect.andThen(
          runWithConfigAndEnv({
            PRODIGY_CODER_MODEL: "gpt-4o-mini",
            PRODIGY_CODER_APPROVAL_MODE: "all",
          }, Effect.gen(function* () {
            const config = yield* AppConfig
            assert.equal(config.provider.model, "gpt-4o-mini")
            assert.equal(config.approvalMode, "all")
          }))
        ),
        Effect.ensuring(teardownTmpDir())
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