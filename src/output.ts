import { Schema } from "effect"

export const TextDelta = Schema.Struct({
  type: Schema.Literal("text-delta"),
  delta: Schema.String,
})
export type TextDelta = typeof TextDelta.Type

export const ToolCall = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Unknown,
})
export type ToolCall = typeof ToolCall.Type

export const ToolResult = Schema.Struct({
  type: Schema.Literal("tool-result"),
  id: Schema.String,
  name: Schema.String,
  result: Schema.String,
  isError: Schema.Boolean,
})
export type ToolResult = typeof ToolResult.Type

export const ToolApprovalRequest = Schema.Struct({
  type: Schema.Literal("tool-approval-request"),
  id: Schema.String,
  toolCallId: Schema.String,
  toolName: Schema.String,
})
export type ToolApprovalRequest = typeof ToolApprovalRequest.Type

export const ApprovalResponse = Schema.Struct({
  type: Schema.Literal("approval-response"),
  approved: Schema.Boolean,
})
export type ApprovalResponse = typeof ApprovalResponse.Type

export const Finish = Schema.Struct({
  type: Schema.Literal("finish"),
  text: Schema.String,
})
export type Finish = typeof Finish.Type

export const ErrorEvent = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
})
export type ErrorEvent = typeof ErrorEvent.Type

export const OutputEvent = Schema.Union(
  [TextDelta, ToolCall, ToolResult, ToolApprovalRequest, ApprovalResponse, Finish, ErrorEvent]
)
export type OutputEvent = typeof OutputEvent.Type

export type Formatter = (event: OutputEvent) => void

const textColor = (color: number, text: string): string => `\x1b[${color}m${text}\x1b[0m`

const truncate = (str: string, maxLen: number): string => {
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + "..."
}

export const makeTextFormatter = (): Formatter =>
(event: OutputEvent): void => {
  const e = event as TextDelta | ToolCall | ToolResult | ToolApprovalRequest | ApprovalResponse | Finish | ErrorEvent
  switch (e.type) {
    case "text-delta":
      Bun.write(Bun.stdout, e.delta)
      break
    case "tool-call": {
      const paramsStr = JSON.stringify(e.params)
      const display = `> ${e.name}(${truncate(paramsStr, 100)})`
      Bun.write(Bun.stdout, textColor(34, display) + "\n")
      break
    }
    case "tool-result":
      Bun.write(Bun.stdout, textColor(90, truncate(e.result, 500)) + "\n")
      break
    case "tool-approval-request":
      Bun.write(Bun.stdout, textColor(33, `Tool ${e.toolName} requires approval. Allow? (y/n) `))
      break
    case "approval-response":
      Bun.write(Bun.stdout, textColor(90, e.approved ? "Approved" : "Rejected") + "\n")
      break
    case "finish":
      Bun.write(Bun.stdout, "\n" + e.text + "\n")
      break
    case "error":
      Bun.write(Bun.stderr, textColor(31, `Error: ${e.message}`) + "\n")
      break
  }
}

export const makeStreamJsonFormatter = (): Formatter =>
(event: OutputEvent): void => {
  const e = event as TextDelta | ToolCall | ToolResult | ToolApprovalRequest | ApprovalResponse | Finish | ErrorEvent
  let output: Record<string, unknown> = { type: e.type }

  switch (e.type) {
    case "text-delta":
      output = { type: "content", content: [{ type: "text", text: e.delta }] }
      break
    case "tool-call":
      output = { type: "tool_use", name: e.name, input: e.params }
      break
    case "tool-result":
      output = { type: "tool_result", content: e.result, is_error: e.isError }
      break
    case "tool-approval-request":
      output = { type: "approval_required", tool_name: e.toolName }
      break
    case "approval-response":
      output = { type: "approval_response", approved: e.approved }
      break
    case "finish":
      output = { type: "final", content: e.text }
      break
    case "error":
      output = { type: "error", message: e.message }
      break
  }

  Bun.write(Bun.stdout, JSON.stringify(output) + "\n")
}

export const createFormatter = (format: "text" | "stream-json"): Formatter =>
  format === "text" ? makeTextFormatter() : makeStreamJsonFormatter()