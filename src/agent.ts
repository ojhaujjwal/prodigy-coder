import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import { Effect, Layer, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { Session, Message, TextPart, ToolCallPart, ToolResultPart } from "./session.ts";
import type { ConfigData } from "./config.ts";
import type { OutputEvent } from "./output.ts";
import { AgenticToolkit } from "./tools/index.ts";
import { makeApprovalGateLayer } from "./approval-gate.ts";

export interface AgentConfig {
  readonly session: Session;
  readonly config: ConfigData;
}

const messageToEncoded = (msg: Message): Prompt.MessageEncoded => {
  switch (msg.role) {
    case "system":
      return { role: "system", content: msg.content };
    case "user":
      return { role: "user", content: msg.content };
    case "assistant":
      return { role: "assistant", content: msg.content };
    case "tool":
      return { role: "tool", content: msg.content };
  }
};

export const runAgent = (
  promptText: string,
  agentConfig: AgentConfig,
  providerLayer: Layer.Layer<LanguageModel.LanguageModel | Tool.HandlersFor<typeof AgenticToolkit.tools>>
) =>
  Effect.gen(function* () {
    const { session, config } = agentConfig;

    const messages: Message[] = [...session.messages];

    if (messages.length === 0 && config.systemPrompt) {
      messages.push({ role: "system", content: config.systemPrompt });
    }

    messages.push({ role: "user", content: promptText });

    const outputEvents: OutputEvent[] = [];
    let turnCount = 0;
    let finished = false;

    while (!finished && turnCount < config.maxTurns) {
      turnCount++;

      const promptMessages: Prompt.MessageEncoded[] = messages.map(messageToEncoded);

      const llmStream = LanguageModel.streamText({
        prompt: promptMessages,
        toolkit: AgenticToolkit
      });

      const turnOutputEvents: OutputEvent[] = [];
      const assistantParts: Array<TextPart | ToolCallPart> = [];
      const toolParts: Array<ToolResultPart> = [];

      const approvalGateLayer = makeApprovalGateLayer(config);
      const fullLayer = Layer.mergeAll(approvalGateLayer, FetchHttpClient.layer, providerLayer);

      yield* Effect.logDebug(`Agent turn ${turnCount} starting with ${messages.length} messages`);

      yield* llmStream.pipe(
        Stream.runForEach((part) => {
          switch (part.type) {
            case "text-delta":
              turnOutputEvents.push({ type: "text-delta", delta: part.delta });
              return Effect.void;
            case "tool-call": {
              turnOutputEvents.push({ type: "tool-call", id: part.id, name: part.name, params: part.params });
              assistantParts.push({
                type: "tool-call",
                id: part.id,
                name: part.name,
                params: part.params,
                providerExecuted: false
              });
              return Effect.logDebug(`LLM tool call: ${part.name}(${JSON.stringify(part.params)})`);
            }
            case "tool-result": {
              if (part.preliminary) {
                return Effect.void;
              }
              let resultStr: string;
              if (Array.isArray(part.encodedResult)) {
                resultStr = part.encodedResult.join("\n");
              } else if (typeof part.encodedResult === "string") {
                resultStr = part.encodedResult;
              } else {
                resultStr = JSON.stringify(part.encodedResult);
              }
              turnOutputEvents.push({
                type: "tool-result",
                id: part.id,
                name: part.name,
                result: resultStr,
                isError: part.isFailure
              });
              toolParts.push({
                type: "tool-result",
                id: part.id,
                name: part.name,
                isFailure: part.isFailure,
                result: part.encodedResult
              });
              return Effect.logDebug(`Tool result: ${part.name} -> ${resultStr.slice(0, 200)}...`);
            }
            case "finish":
              finished = true;
              turnOutputEvents.push({ type: "finish", text: part.reason || "" });
              return Effect.logDebug(`LLM finish: reason=${part.reason}`);
            default:
              return Effect.logDebug(`Unknown stream part: ${part.type}`);
          }
        }),
        Effect.provide(fullLayer)
      );

      outputEvents.push(...turnOutputEvents);

      const textParts = turnOutputEvents
        .filter((e) => e.type === "text-delta")
        .map((e) => (e.type === "text-delta" ? e.delta : ""))
        .join("");

      if (assistantParts.length > 0) {
        if (textParts.length > 0) {
          assistantParts.unshift({ type: "text", text: textParts });
        }
        messages.push({ role: "assistant", content: assistantParts });
      } else if (textParts.length > 0) {
        messages.push({ role: "assistant", content: textParts });
      }

      if (toolParts.length > 0) {
        messages.push({ role: "tool", content: toolParts });
      }

      const hasToolCalls = turnOutputEvents.some((e) => e.type === "tool-call");
      if (hasToolCalls) {
        finished = false;
      }
    }

    if (!finished) {
      outputEvents.push({ type: "error", message: "Max turns exceeded" });
    }

    session.messages = messages;

    return outputEvents;
  });
