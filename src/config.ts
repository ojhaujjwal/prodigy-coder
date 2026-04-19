import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import * as FileSystem from "effect/FileSystem"

export const ProviderType = Schema.Literals(["openai-compat", "openai", "anthropic", "openrouter"])
export type ProviderType = typeof ProviderType.Type

export const ApprovalMode = Schema.Literals(["none", "dangerous", "all"])
export type ApprovalMode = typeof ApprovalMode.Type

export const ProviderConfig = Schema.Struct({
  type: ProviderType,
  baseUrl: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
})
export type ProviderConfig = typeof ProviderConfig.Type

export const ConfigSchema = Schema.Struct({
  provider: ProviderConfig,
  approvalMode: Schema.Literals(["none", "dangerous", "all"]),
  maxTurns: Schema.Number,
  systemPrompt: Schema.optional(Schema.String),
})
export type ConfigData = typeof ConfigSchema.Type

export interface Config extends ConfigData {}

const envOverrides = (
  config: ConfigData,
  apiKey: string | undefined,
  baseUrl: string | undefined,
  model: string | undefined,
  approvalMode: string | undefined
): ConfigData => ({
  ...config,
  provider: {
    ...config.provider,
    apiKey: apiKey ?? config.provider.apiKey,
    baseUrl: baseUrl ?? config.provider.baseUrl,
    model: model ?? config.provider.model,
  },
  approvalMode: (approvalMode ?? config.approvalMode) as ApprovalMode,
})

const defaultConfig = (apiKey?: string, model?: string): ConfigData => ({
  provider: {
    type: "openai-compat" as const,
    apiKey: apiKey,
    baseUrl: "https://api.openai.com/v1",
    model: model ?? "gpt-4o",
  },
  approvalMode: "none" as const,
  maxTurns: 50,
  systemPrompt: undefined,
})

const HOME_CONFIG_PATHS = [".prodigy-coder.json", ".config/prodigy-coder.json"]

const findConfigFile = Effect.fnUntraced(function* (explicitPath: Option.Option<string>) {
  const fs = yield* FileSystem.FileSystem
  const home = yield* Config.string("HOME").pipe(
    Config.orElse(() => Config.succeed("/"))
  )

  if (Option.isSome(explicitPath)) {
    const exists = yield* fs.exists(explicitPath.value)
    if (exists) return Option.some(explicitPath.value)
    return Option.none()
  }

  for (const configPath of HOME_CONFIG_PATHS) {
    const fullPath = `${home}/${configPath}`
    const exists = yield* fs.exists(fullPath)
    if (exists) return Option.some(fullPath)
  }

  const cwdExists = yield* fs.exists(".prodigy-coder.json")
  if (cwdExists) return Option.some(".prodigy-coder.json")

  return Option.none()
})

const readConfigFile = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  const content = yield* fs.readFileString(path)
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigSchema))(content)
})

class AppConfig extends Context.Service<
  AppConfig,
  ConfigData
>()("AppConfig") {
  static readonly layer = Layer.effect(
    AppConfig,
    Effect.gen(function* () {
      const apiKey = yield* Config.option(
        Config.redacted("PRODIGY_CODER_API_KEY").pipe(
          Config.orElse(() => Config.redacted("OPENAI_API_KEY")),
          Config.orElse(() => Config.redacted("ANTHROPIC_API_KEY")),
          Config.orElse(() => Config.redacted("OPENROUTER_API_KEY"))
        )
      )
      const baseUrl = yield* Config.option(Config.string("PRODIGY_CODER_BASE_URL"))
      const model = yield* Config.option(Config.string("PRODIGY_CODER_MODEL"))
      const approvalMode = yield* Config.option(Config.string("PRODIGY_CODER_APPROVAL_MODE"))

        const apiKeyValue = Option.map(apiKey, Redacted.value)
      const modelValue = Option.getOrElse(model, () => "gpt-4o")

      let loadedConfig = defaultConfig(Option.getOrUndefined(apiKeyValue), modelValue)

      const configPath = yield* findConfigFile(Option.none())
      if (Option.isSome(configPath)) {
        const fileConfig = yield* readConfigFile(configPath.value)
        loadedConfig = envOverrides(fileConfig, Option.getOrUndefined(apiKeyValue), Option.getOrUndefined(baseUrl), modelValue, Option.getOrUndefined(approvalMode))
      } else {
        loadedConfig = envOverrides(loadedConfig, Option.getOrUndefined(apiKeyValue), Option.getOrUndefined(baseUrl), modelValue, Option.getOrUndefined(approvalMode))
      }

      return Schema.decodeUnknownSync(ConfigSchema)(loadedConfig) as ConfigData
    })
  )

  static readonly layerWithPath = (path: string) =>
    Layer.effect(
      AppConfig,
      Effect.gen(function* () {
        const apiKey = yield* Config.option(
          Config.redacted("PRODIGY_CODER_API_KEY").pipe(
            Config.orElse(() => Config.redacted("OPENAI_API_KEY")),
            Config.orElse(() => Config.redacted("ANTHROPIC_API_KEY")),
            Config.orElse(() => Config.redacted("OPENROUTER_API_KEY"))
          )
        )
        const baseUrl = yield* Config.option(Config.string("PRODIGY_CODER_BASE_URL"))
        const model = yield* Config.option(Config.string("PRODIGY_CODER_MODEL"))
        const approvalMode = yield* Config.option(Config.string("PRODIGY_CODER_APPROVAL_MODE"))

      const apiKeyValue = Option.map(apiKey, Redacted.value)
        const modelValue = Option.getOrElse(model, () => "gpt-4o")

        let loadedConfig = defaultConfig(Option.getOrUndefined(apiKeyValue), modelValue)

        const configPath = yield* findConfigFile(Option.some(path))
        if (Option.isSome(configPath)) {
          const fileConfig = yield* readConfigFile(configPath.value)
          loadedConfig = envOverrides(fileConfig, Option.getOrUndefined(apiKeyValue), Option.getOrUndefined(baseUrl), modelValue, Option.getOrUndefined(approvalMode))
        } else {
          loadedConfig = envOverrides(loadedConfig, Option.getOrUndefined(apiKeyValue), Option.getOrUndefined(baseUrl), modelValue, Option.getOrUndefined(approvalMode))
        }

        return Schema.decodeUnknownSync(ConfigSchema)(loadedConfig) as ConfigData
      })
    )
}

export const loadConfig = (explicitPath?: string) =>
  explicitPath
    ? AppConfig.layerWithPath(explicitPath)
    : AppConfig.layer

export const maskConfig = (config: ConfigData): ConfigData => ({
  ...config,
  provider: {
    ...config.provider,
    apiKey: config.provider.apiKey ? "***" : undefined,
  },
})

export { AppConfig }