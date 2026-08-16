import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import { Effect, Option, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Response from "effect/unstable/ai/Response";
import { Predicate, Schema } from "effect";
import type { JsonValue } from "@prodigy/core";
import type { Session, Message, TextPart, ToolCallPart, ToolResultPart } from "./session.ts";
import type { ConfigData } from "./config.ts";
import type { OutputEvent } from "./output.ts";
import { AgenticToolkit } from "./tools/index.ts";

export interface AgentConfig {
  readonly session: Session;
  readonly config: ConfigData;
  readonly cwd?: string;
}

const formatToolResult = (encodedResult: JsonValue): string => {
  if (Array.isArray(encodedResult)) {
    return encodedResult.join("\n");
  } else if (Predicate.isString(encodedResult)) {
    return encodedResult;
  } else {
    return JSON.stringify(encodedResult);
  }
};

export const DEFAULT_AGENTS_MD = "";

export const loadAgentsMd = (fs: FileSystem.FileSystem, cwd = ".") =>
  Effect.gen(function* () {
    const path = `${cwd}/AGENTS.md`;
    const exists = yield* fs.exists(path);
    if (!exists) return Option.none();
    const content = yield* fs.readFileString(path);
    const trimmed = content.trim();
    if (!trimmed) return Option.none();
    return Option.some(trimmed);
  }).pipe(Effect.catch(() => Effect.succeed(Option.none())));

const streamPartToOutputEvent = (part: Response.AnyPart): Option.Option<OutputEvent> => {
  switch (part.type) {
    case "text-delta":
      return Option.some({ type: "text-delta", delta: part.delta });
    case "tool-call":
      return Option.some({ type: "tool-call", id: part.id, name: part.name, params: part.params });
    case "tool-result": {
      if (part.preliminary) {
        return Option.none();
      }
      return Option.some({
        type: "tool-result",
        id: part.id,
        name: part.name,
        result: formatToolResult(Schema.decodeUnknownSync(Schema.Json)(part.encodedResult)),
        isError: part.isFailure
      });
    }
    case "finish":
      return Option.some({ type: "finish", text: part.reason || "" });
    default:
      return Option.none();
  }
};

export const runAgent = (userMessages: readonly string[], agentConfig: AgentConfig) =>
  Effect.gen(function* () {
    const { session, config } = agentConfig;

    const messages: Message[] = [...session.messages];

    if (messages.length === 0) {
      const fs = yield* FileSystem.FileSystem;
      const agentsMdOption = yield* loadAgentsMd(fs, agentConfig.cwd);
      const agentsMd = Option.getOrElse(agentsMdOption, () => DEFAULT_AGENTS_MD);
      const explicitPrompt = config.systemPrompt ?? "";
      const combined = [agentsMd, explicitPrompt].filter(Boolean).join("\n\n");
      if (combined) {
        messages.push({ role: "system", content: combined });
      }
    }

    for (const msg of userMessages) {
      messages.push({ role: "user", content: msg });
    }

    const outputEvents: OutputEvent[] = [];
    let turnCount = 0;
    let finished = false;

    const runTurns = Effect.gen(function* () {
      while (!finished && turnCount < config.maxTurns) {
        turnCount++;

        const llmStream = LanguageModel.streamText({
          prompt: messages,
          toolkit: AgenticToolkit
        });

        const turnOutputEvents: OutputEvent[] = [];
        const assistantParts: Array<TextPart | ToolCallPart> = [];
        const toolParts: Array<ToolResultPart> = [];

        yield* Effect.logDebug(`Agent turn ${turnCount} starting with ${messages.length} messages`);

        yield* llmStream.pipe(
          Stream.runForEach((part) => {
            const maybeEvent = streamPartToOutputEvent(part);
            if (Option.isSome(maybeEvent)) {
              turnOutputEvents.push(maybeEvent.value);
            }

            switch (part.type) {
              case "text-delta":
                return Effect.void;
              case "tool-call": {
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
                toolParts.push({
                  type: "tool-result",
                  id: part.id,
                  name: part.name,
                  isFailure: part.isFailure,
                  result: part.encodedResult
                });
                return Effect.logDebug(
                  `Tool result: ${part.name} -> ${formatToolResult(
                    Schema.decodeUnknownSync(Schema.Json)(part.encodedResult)
                  ).slice(0, 200)}...`
                );
              }
              case "finish":
                finished = true;
                return Effect.logDebug(`LLM finish: reason=${part.reason}`);
              default:
                return Effect.logDebug(`Unknown stream part: ${part.type}`);
            }
          })
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
    });

    yield* runTurns;

    if (!finished) {
      outputEvents.push({ type: "error", message: "Max turns exceeded" });
    }

    session.messages.splice(0, session.messages.length, ...messages);

    return outputEvents;
  });
