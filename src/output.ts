import { Console, Effect, Schema } from "effect";

export const TextDelta = Schema.Struct({
  type: Schema.Literal("text-delta"),
  delta: Schema.String
});
export type TextDelta = typeof TextDelta.Type;

export const ToolCall = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown
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

export const OutputEvent = Schema.Union([TextDelta, ToolCall, ToolResult, Finish, ErrorEvent, SessionInfo]);
export type OutputEvent = typeof OutputEvent.Type;

export type OutputFormatter = (event: OutputEvent) => Effect.Effect<void>;

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
    }
  };

export const makeStreamJsonFormatter =
  (): OutputFormatter =>
  (event: OutputEvent): Effect.Effect<void> => {
    let output: Record<string, unknown> = { type: event.type };

    switch (event.type) {
      case "text-delta":
        output = { type: "content", content: [{ type: "text", text: event.delta }] };
        break;
      case "tool-call":
        output = { type: "tool_use", name: event.name, input: event.params };
        break;
      case "tool-result":
        output = { type: "tool_result", content: event.result, is_error: event.isError };
        break;
      case "finish":
        output = { type: "final", content: event.text };
        break;
      case "error":
        output = { type: "error", message: event.message };
        break;
      case "session-info":
        output = {
          type: "session",
          session_id: event.sessionId,
          export_command: `export PRODIGY_SESSION_ID=${event.sessionId}`
        };
        break;
    }

    return Console.log(JSON.stringify(output));
  };

export const createFormatter = (format: "text" | "stream-json"): OutputFormatter =>
  format === "text" ? makeTextFormatter() : makeStreamJsonFormatter();
