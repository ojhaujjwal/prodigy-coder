import * as Model from "effect/unstable/ai/Model";
import * as OpenAiClient from "@effect/ai-openai-compat/OpenAiClient";
import * as OpenAiLanguageModel from "@effect/ai-openai-compat/OpenAiLanguageModel";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { ProviderConfig } from "../config.ts";

export const buildGeminiProviderLayer = (config: ProviderConfig, modelName: string, apiKey: Redacted.Redacted) => {
  const baseUrl = config.baseUrl ?? "https://generativelanguage.googleapis.com/v1beta";
  const clientLayer = OpenAiClient.layer({
    apiKey,
    apiUrl: baseUrl
  });
  const languageModelLayer = OpenAiLanguageModel.layer({
    model: modelName
  });
  const combined = languageModelLayer.pipe(Layer.provide(clientLayer));

  return Model.make("gemini", modelName, combined);
};
