import { Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"

export const ProviderType = Schema.Literals(["openai-compat", "openai", "anthropic", "openrouter"])
export type ProviderType = typeof ProviderType.Type

export const ApprovalMode = Schema.Literals(["none", "dangerous", "all"])
export type ApprovalMode = typeof ApprovalMode.Type

export const ProviderConfig = Schema.Struct({
  type: ProviderType,
  baseUrl: Schema.optional(Schema.String),
  apiKey: Schema.optional(Schema.String),
  model: Schema.String,
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

const loadEnvVar = (key: string): string | undefined => process.env[key]

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

export const loadConfig = (explicitPath?: string): ConfigData => {
  const apiKey =
    loadEnvVar("PRODIGY_CODER_API_KEY") ??
    loadEnvVar("OPENAI_API_KEY") ??
    loadEnvVar("ANTHROPIC_API_KEY") ??
    loadEnvVar("OPENROUTER_API_KEY")
  const baseUrl = loadEnvVar("PRODIGY_CODER_BASE_URL")
  const model = loadEnvVar("PRODIGY_CODER_MODEL")
  const approvalMode = loadEnvVar("PRODIGY_CODER_APPROVAL_MODE")

  let loadedConfig = defaultConfig(apiKey, model)

  const configPath = explicitPath ?? findConfigFileSync()
  if (configPath) {
    const content = fs.readFileSync(configPath, "utf-8")
    const parsed = JSON.parse(content)
    const decoded = Schema.decodeUnknownSync(ConfigSchema)(parsed)
    loadedConfig = envOverrides(decoded, apiKey, baseUrl, model, approvalMode)
  } else {
    loadedConfig = envOverrides(loadedConfig, apiKey, baseUrl, model, approvalMode)
  }

  return Schema.decodeUnknownSync(ConfigSchema)(loadedConfig) as Config
}

function findConfigFileSync(): string | undefined {
  const home = process.env.HOME ?? "/"
  for (const configPath of HOME_CONFIG_PATHS) {
    const fullPath = path.join(home, configPath)
    if (fs.existsSync(fullPath)) {
      return fullPath
    }
  }
  if (fs.existsSync(".prodigy-coder.json")) {
    return ".prodigy-coder.json"
  }
  return undefined
}

export const maskConfig = (config: ConfigData): ConfigData => ({
  ...config,
  provider: {
    ...config.provider,
    apiKey: config.provider.apiKey ? "***" : undefined,
  },
})