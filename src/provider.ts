import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Model from "effect/unstable/ai/Model";
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import * as OpenAiClient_OpenAi from "@effect/ai-openai/OpenAiClient";
import * as OpenAiLanguageModel_OpenAi from "@effect/ai-openai/OpenAiLanguageModel";
import * as AnthropicClient from "@effect/ai-anthropic/AnthropicClient";
import * as AnthropicLanguageModel from "@effect/ai-anthropic/AnthropicLanguageModel";
import * as OpenRouterClient from "@effect/ai-openrouter/OpenRouterClient";
import * as OpenRouterLanguageModel from "@effect/ai-openrouter/OpenRouterLanguageModel";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { ProviderConfig } from "./config.ts";

const DEFAULT_MODELS = {
  "openai-compat": "gpt-4o",
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-20241022",
  openrouter: "anthropic/claude-3-5-sonnet-20241022",
  bedrock: "anthropic.claude-3-5-sonnet-20241022"
} as const;

const getDefaultModel = (type: ProviderConfig["type"]): string => DEFAULT_MODELS[type];

type BuildProviderLayerReturn = Model.Model<
  "openai-compat" | "openai" | "anthropic" | "openrouter" | "bedrock",
  LanguageModel.LanguageModel,
  HttpClient.HttpClient
>;

export const buildProviderLayer = (config: ProviderConfig): BuildProviderLayerReturn => {
  const modelName = config.model ?? getDefaultModel(config.type);
  const apiKey = config.apiKey ? Redacted.make(config.apiKey) : Redacted.make("");

  const result = (() => {
    switch (config.type) {
      case "openai-compat": {
        const baseUrl = config.baseUrl ?? "https://api.openai.com/v1";
        const clientLayer = OpenAiClient.layer({
          apiKey,
          apiUrl: baseUrl
        });
        const languageModelLayer = OpenAiLanguageModel.layer({
          model: modelName
        });
        const combined = languageModelLayer.pipe(Layer.provide(clientLayer));
        return Model.make("openai-compat", modelName, combined);
      }
      case "openai": {
        const clientLayer = OpenAiClient_OpenAi.layer({
          apiKey
        });
        const languageModelLayer = OpenAiLanguageModel_OpenAi.layer({
          model: modelName
        });
        const combined = languageModelLayer.pipe(Layer.provide(clientLayer));
        return Model.make("openai", modelName, combined);
      }
      case "anthropic": {
        const clientLayer = AnthropicClient.layer({
          apiKey
        });
        const languageModelLayer = AnthropicLanguageModel.layer({
          model: modelName
        });
        const combined = languageModelLayer.pipe(Layer.provide(clientLayer));
        return Model.make("anthropic", modelName, combined);
      }
      case "openrouter": {
        const clientLayer = OpenRouterClient.layer({
          apiKey
        });
        const languageModelLayer = OpenRouterLanguageModel.layer({
          model: modelName
        });
        const combined = languageModelLayer.pipe(Layer.provide(clientLayer));
        return Model.make("openrouter", modelName, combined);
      }
      case "bedrock": {
        const baseUrl = config.baseUrl ?? "https://bedrock-mantle.us-east-1.api.aws/v1";
        const clientLayer = OpenAiClient.layer({
          apiKey,
          apiUrl: baseUrl
        });
        const languageModelLayer = OpenAiLanguageModel.layer({
          model: modelName
        });
        const combined = languageModelLayer.pipe(Layer.provide(clientLayer));
        return Model.make("bedrock", modelName, combined);
      }
    }
  })();

  return result as BuildProviderLayerReturn;
};
