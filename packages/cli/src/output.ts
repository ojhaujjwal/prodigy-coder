import { Console, Effect, Schema } from "effect";
import type { JsonValue } from "@prodigy/core";

export const TextDelta = Schema.Struct({
  type: Schema.Literal("text-delta"),
  delta: Schema.String
});
export type TextDelta = typeof TextDelta.Type;

export const ToolCall = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Json
});
export type ToolCall = typeof ToolCall.Type;

export const ToolResult = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  result: Schema.String,
  isError: Schema.Boolean
});
export type ToolResult = typeof ToolResult.Type;

export const Finish = Schema.Struct({
  type: Schema.Literal("finish"),
  text: Schema.String
});
export type Finish = typeof Finish.Type;

export const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String
});
export type ErrorEvent = typeof ErrorEvent.Type;

export const SessionInfo = Schema.Struct({
  type: Schema.Literal("session-info"),
  sessionId: Schema.String
});
export type SessionInfo = typeof SessionInfo.Type;

export const Notice = Schema.Struct({
  type: Schema.Literal("notice"),
  message: Schema.String
});
export type Notice = typeof Notice.Type;

export const OutputEvent = Schema.Union([TextDelta, ToolCall, ToolResult, Finish, ErrorEvent, SessionInfo, Notice]);
export type OutputEvent = typeof OutputEvent.Type;

export type OutputFormatter = (event: OutputEvent) => Effect.Effect<void>;

/** The JSON protocol payload emitted by the stream-json formatter. */
export type OutputPayload =
  | { readonly type: "content"; readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }> }
  | { readonly type: "tool_use"; readonly name: string; readonly input: JsonValue }
  | { readonly type: "tool_result"; readonly content: string; readonly is_error: boolean }
  | { readonly type: "final"; readonly content: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "session"; readonly session_id: string; readonly export_command: string };

const textColor = (color: number, text: string): string => `\x1b[${color}m${text}\x1b[0m`;

const truncate = (str: string, maxLen: number): string => {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
};

export const makeTextFormatter =
  (): OutputFormatter =>
  (event: OutputEvent): Effect.Effect<void> => {
    switch (event.type) {
      case "text-delta":
        return Console.log(event.delta);
      case "tool-call": {
        const paramsStr = JSON.stringify(event.params);
        const display = `> ${event.name}(${truncate(paramsStr, 100)})`;
        return Console.log(textColor(34, display));
      }
      case "tool-result":
        return Console.log(textColor(90, truncate(event.result, 500)));
      case "finish":
        return Console.log("\n" + event.text + "\n");
      case "error":
        return Console.log(textColor(31, `Error: ${event.message}`));
      case "session-info":
        return Console.log(`\n---\nSession: ${event.sessionId}\nexport PRODIGY_SESSION_ID=${event.sessionId}\n---\n`);
      case "notice":
        return Console.log(textColor(33, event.message));
    }
  };

export const makeStreamJsonFormatter =
  (): OutputFormatter =>
  (event: OutputEvent): Effect.Effect<void> => {
    const output: OutputPayload = (() => {
      switch (event.type) {
        case "text-delta":
          return { type: "content", content: [{ type: "text", text: event.delta }] };
        case "tool-call":
          return { type: "tool_use", name: event.name, input: event.params };
        case "tool-result":
          return { type: "tool_result", content: event.result, is_error: event.isError };
        case "finish":
          return { type: "final", content: event.text };
        case "error":
          return { type: "error", message: event.message };
        case "session-info":
          return {
            type: "session",
            session_id: event.sessionId,
            export_command: `export PRODIGY_SESSION_ID=${event.sessionId}`
          };
        case "notice":
          return { type: "content", content: [{ type: "text", text: event.message }] };
      }
    })();

    return Console.log(JSON.stringify(output));
  };

export const createFormatter = (format: "text" | "stream-json"): OutputFormatter =>
  format === "text" ? makeTextFormatter() : makeStreamJsonFormatter();
