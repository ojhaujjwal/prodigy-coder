import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import * as Prompt from "effect/unstable/ai/Prompt";
import { Effect, Layer, Stream } from "effect";
import { Tool } from "effect/unstable/ai";
import { BunServices } from "@effect/platform-bun";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { Session, Message } from "./session.ts";
import type { ConfigData } from "./config.ts";
import { needsApproval } from "./approval.ts";
import type { OutputEvent } from "./output.ts";
import { MyToolkit } from "./tools/index.ts";

export interface AgentConfig {
  readonly session: Session;
  readonly config: ConfigData;
}

const messageToEncoded = (msg: Message): Prompt.MessageEncoded => {
  if (msg.role === "system") {
    return { role: "system", content: msg.content };
  }
  if (msg.role === "user") {
    return { role: "user", content: [{ type: "text", text: msg.content }] };
  }
  return { role: "assistant", content: [{ type: "text", text: msg.content }] };
};

export const runAgent = (
  promptText: string,
  agentConfig: AgentConfig,
  providerLayer: Layer.Layer<LanguageModel.LanguageModel | Tool.HandlersFor<typeof MyToolkit.tools>>
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
        toolkit: MyToolkit
      });

      const turnOutputEvents: OutputEvent[] = [];
      const toolCallNames = new Map<string, string>();

      const fullLayer = Layer.merge(
        providerLayer,
        Layer.merge(BunServices.layer, FetchHttpClient.layer)
      );

      yield* llmStream.pipe(
        Stream.runForEach((part) => {
          switch (part.type) {
            case "text-delta":
              turnOutputEvents.push({ type: "text-delta", delta: part.delta });
              return Effect.void;
            case "tool-call": {
              turnOutputEvents.push({ type: "tool-call", id: part.id, name: part.name, params: part.params });
              toolCallNames.set(part.id, part.name);
              const approved = needsApproval(part.name, config.approvalMode);
              if (approved && config.approvalMode !== "none") {
                turnOutputEvents.push({
                  type: "tool-approval-request",
                  id: crypto.randomUUID(),
                  toolCallId: part.id,
                  toolName: part.name
                });
              }
              return Effect.void;
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
              return Effect.void;
            }
            case "tool-approval-request":
              turnOutputEvents.push({
                type: "tool-approval-request",
                id: part.approvalId,
                toolCallId: part.toolCallId,
                toolName: toolCallNames.get(part.toolCallId) ?? ""
              });
              return Effect.void;
            case "finish":
              finished = true;
              turnOutputEvents.push({ type: "finish", text: part.reason || "" });
              return Effect.void;
            default:
              return Effect.void;
          }
        }),
        Effect.provide(fullLayer)
      );

      outputEvents.push(...turnOutputEvents);

      const toolResults = turnOutputEvents.filter((e) => e.type === "tool-result");
      for (const toolResult of toolResults) {
        if (toolResult.type === "tool-result") {
          messages.push({
            role: "assistant",
            content: ""
          });
          messages.push({
            role: "assistant",
            content: `[tool result: ${toolResult.name}] ${toolResult.result}`
          });
        }
      }
    }

    if (!finished) {
      outputEvents.push({ type: "error", message: "Max turns exceeded" });
    }

    (session as { messages: Message[] }).messages = messages;

    return outputEvents;
  });
