import { describe, it } from "@effect/vitest"
import { assert } from "@effect/vitest"
import { Effect } from "effect"
import {
  makeTextFormatter,
  makeStreamJsonFormatter,
  type OutputEvent,
} from "./output.ts"

describe("output", () => {
  describe("text formatter", () => {
    it("text formatter processes text-delta event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter()
        const event: OutputEvent = { type: "text-delta", delta: "Hello, world!" }
        yield* formatter(event)
      }))

    it("text formatter processes tool-call event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter()
        const event: OutputEvent = {
          type: "tool-call",
          id: "tool-1",
          name: "read",
          params: { filePath: "/test/file.txt" },
        }
        yield* formatter(event)
      }))

    it("text formatter processes tool-result event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter()
        const event: OutputEvent = {
          type: "tool-result",
          id: "tool-1",
          name: "read",
          result: "file contents here",
          isError: false,
        }
        yield* formatter(event)
      }))

    it("text formatter processes finish event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter()
        const event: OutputEvent = { type: "finish", text: "Task completed successfully." }
        yield* formatter(event)
      }))

    it("text formatter processes error event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter()
        const event: OutputEvent = { type: "error", message: "Something went wrong" }
        yield* formatter(event)
      }))

    it("text formatter processes tool-approval-request event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter()
        const event: OutputEvent = {
          type: "tool-approval-request",
          id: "approval-1",
          toolCallId: "tool-1",
          toolName: "shell",
        }
        yield* formatter(event)
      }))

    it("text formatter processes approval-response event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter()
        const event: OutputEvent = { type: "approval-response", approved: true }
        yield* formatter(event)
      }))
  })

  describe("stream-json formatter", () => {
    it("stream-json formatter outputs valid LDJSON for text-delta", () =>
      Effect.gen(function* () {
        const outputs: string[] = []
        const formatter = makeStreamJsonFormatter()
        const event: OutputEvent = { type: "text-delta", delta: "Hello" }

        yield* formatter(event)

        assert.equal(outputs.length, 1)
        const parsed = JSON.parse(outputs[0])
        assert.equal(parsed.type, "content")
        assert.isArray(parsed.content)
        assert.equal(parsed.content[0].type, "text")
        assert.equal(parsed.content[0].text, "Hello")
      }))

    it("stream-json formatter outputs valid LDJSON for tool-call", () =>
      Effect.gen(function* () {
        const outputs: string[] = []
        const formatter = makeStreamJsonFormatter()
        const event: OutputEvent = {
          type: "tool-call",
          id: "tool-1",
          name: "read",
          params: { filePath: "/test.txt" },
        }

        yield* formatter(event)

        assert.equal(outputs.length, 1)
        const parsed = JSON.parse(outputs[0])
        assert.equal(parsed.type, "tool_use")
        assert.equal(parsed.name, "read")
        assert.deepEqual(parsed.input, { filePath: "/test.txt" })
      }))

    it("stream-json formatter outputs valid LDJSON for tool-result", () =>
      Effect.gen(function* () {
        const outputs: string[] = []
        const formatter = makeStreamJsonFormatter()
        const event: OutputEvent = {
          type: "tool-result",
          id: "tool-1",
          name: "read",
          result: "file contents",
          isError: false,
        }

        yield* formatter(event)

        assert.equal(outputs.length, 1)
        const parsed = JSON.parse(outputs[0])
        assert.equal(parsed.type, "tool_result")
        assert.equal(parsed.content, "file contents")
        assert.equal(parsed.is_error, false)
      }))

    it("stream-json formatter outputs valid LDJSON for finish", () =>
      Effect.gen(function* () {
        const outputs: string[] = []
        const formatter = makeStreamJsonFormatter()
        const event: OutputEvent = { type: "finish", text: "Done" }

        yield* formatter(event)

        assert.equal(outputs.length, 1)
        const parsed = JSON.parse(outputs[0])
        assert.equal(parsed.type, "final")
        assert.equal(parsed.content, "Done")
      }))

    it("stream-json formatter outputs valid LDJSON for error", () =>
      Effect.gen(function* () {
        const outputs: string[] = []
        const formatter = makeStreamJsonFormatter()
        const event: OutputEvent = { type: "error", message: "Failed" }

        yield* formatter(event)

        assert.equal(outputs.length, 1)
        const parsed = JSON.parse(outputs[0])
        assert.equal(parsed.type, "error")
        assert.equal(parsed.message, "Failed")
      }))

    it("stream-json formatter outputs valid LDJSON for approval-request", () =>
      Effect.gen(function* () {
        const outputs: string[] = []
        const formatter = makeStreamJsonFormatter()
        const event: OutputEvent = {
          type: "tool-approval-request",
          id: "approval-1",
          toolCallId: "tool-1",
          toolName: "shell",
        }

        yield* formatter(event)

        assert.equal(outputs.length, 1)
        const parsed = JSON.parse(outputs[0])
        assert.equal(parsed.type, "approval_required")
        assert.equal(parsed.tool_name, "shell")
      }))

    it("stream-json formatter outputs valid LDJSON for approval-response", () =>
      Effect.gen(function* () {
        const outputs: string[] = []
        const formatter = makeStreamJsonFormatter()
        const event: OutputEvent = { type: "approval-response", approved: true }

        yield* formatter(event)

        assert.equal(outputs.length, 1)
        const parsed = JSON.parse(outputs[0])
        assert.equal(parsed.type, "approval_response")
        assert.equal(parsed.approved, true)
      }))

    it("all event types are handled without errors", () =>
      Effect.gen(function* () {
        const formatter = makeStreamJsonFormatter()
        const events: OutputEvent[] = [
          { type: "text-delta", delta: "test" },
          { type: "tool-call", id: "1", name: "test", params: {} },
          { type: "tool-result", id: "1", name: "test", result: "ok", isError: false },
          { type: "tool-approval-request", id: "1", toolCallId: "1", toolName: "test" },
          { type: "approval-response", approved: true },
          { type: "finish", text: "done" },
          { type: "error", message: "err" },
        ]

        for (const event of events) {
          yield* formatter(event)
        }
      }))
  })
})