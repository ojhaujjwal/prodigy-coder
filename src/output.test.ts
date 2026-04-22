import { describe, it, expect } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as TestConsole from "effect/testing/TestConsole";
import { makeTextFormatter, makeStreamJsonFormatter, type OutputEvent } from "./output.ts";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);

const parseJson = (input: string) =>
  Schema.decodeUnknownSync(Schema.fromJsonString(JsonRecord))(input)

const testLayer = TestConsole.layer;

describe("output", () => {
  describe("text formatter", () => {
    it.effect("text formatter processes text-delta event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter();
        const event: OutputEvent = { type: "text-delta", delta: "Hello, world!" };
        yield* formatter(event);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("text formatter processes tool-call event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter();
        const event: OutputEvent = {
          type: "tool-call",
          id: "tool-1",
          name: "read",
          params: { filePath: "/test/file.txt" }
        };
        yield* formatter(event);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("text formatter processes tool-result event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter();
        const event: OutputEvent = {
          type: "tool-result",
          id: "tool-1",
          name: "read",
          result: "file contents here",
          isError: false
        };
        yield* formatter(event);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("text formatter processes finish event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter();
        const event: OutputEvent = { type: "finish", text: "Task completed successfully." };
        yield* formatter(event);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("text formatter processes error event", () =>
      Effect.gen(function* () {
        const formatter = makeTextFormatter();
        const event: OutputEvent = { type: "error", message: "Something went wrong" };
        yield* formatter(event);
      }).pipe(Effect.provide(testLayer))
    );
  });

  describe("stream-json formatter", () => {
    it.effect("stream-json formatter outputs valid LDJSON for text-delta", () =>
      Effect.gen(function* () {
        const formatter = makeStreamJsonFormatter();
        const event: OutputEvent = { type: "text-delta", delta: "Hello" };
        yield* formatter(event);
        const outputs = yield* TestConsole.logLines;
        expect(outputs.length).toBe(1);
        const outputStr = String(outputs[0]);
        const parsed = parseJson(outputStr);
        expect(parsed.type).toBe("content");
        expect(Array.isArray(parsed.content)).toBe(true);
        // oxlint-disable-next-line typescript/consistent-type-assertions
        const content = parsed.content as Array<{ type: string; text: string }>;
        expect(content[0].type).toBe("text");
        expect(content[0].text).toBe("Hello");
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("stream-json formatter outputs valid LDJSON for tool-call", () =>
      Effect.gen(function* () {
        const formatter = makeStreamJsonFormatter();
        const event: OutputEvent = {
          type: "tool-call",
          id: "tool-1",
          name: "read",
          params: { filePath: "/test.txt" }
        };
        yield* formatter(event);
        const outputs = yield* TestConsole.logLines;
        expect(outputs.length).toBe(1);
        const parsed = parseJson(String(outputs[0]));
        expect(parsed.type).toBe("tool_use");
        expect(parsed.name).toBe("read");
        expect(parsed.input).toEqual({ filePath: "/test.txt" });
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("stream-json formatter outputs valid LDJSON for tool-result", () =>
      Effect.gen(function* () {
        const formatter = makeStreamJsonFormatter();
        const event: OutputEvent = {
          type: "tool-result",
          id: "tool-1",
          name: "read",
          result: "file contents",
          isError: false
        };
        yield* formatter(event);
        const outputs = yield* TestConsole.logLines;
        expect(outputs.length).toBe(1);
        const parsed = parseJson(String(outputs[0]));
        expect(parsed.type).toBe("tool_result");
        expect(parsed.content).toBe("file contents");
        expect(parsed.is_error).toBe(false);
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("stream-json formatter outputs valid LDJSON for finish", () =>
      Effect.gen(function* () {
        const formatter = makeStreamJsonFormatter();
        const event: OutputEvent = { type: "finish", text: "Done" };
        yield* formatter(event);
        const outputs = yield* TestConsole.logLines;
        expect(outputs.length).toBe(1);
        const parsed = parseJson(String(outputs[0]));
        expect(parsed.type).toBe("final");
        expect(parsed.content).toBe("Done");
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("stream-json formatter outputs valid LDJSON for error", () =>
      Effect.gen(function* () {
        const formatter = makeStreamJsonFormatter();
        const event: OutputEvent = { type: "error", message: "Failed" };
        yield* formatter(event);
        const outputs = yield* TestConsole.logLines;
        expect(outputs.length).toBe(1);
        const parsed = parseJson(String(outputs[0]));
        expect(parsed.type).toBe("error");
        expect(parsed.message).toBe("Failed");
      }).pipe(Effect.provide(testLayer))
    );

    it.effect("all event types are handled without errors", () =>
      Effect.gen(function* () {
        const formatter = makeStreamJsonFormatter();
        const events: OutputEvent[] = [
          { type: "text-delta", delta: "test" },
          { type: "tool-call", id: "1", name: "test", params: {} },
          { type: "tool-result", id: "1", name: "test", result: "ok", isError: false },
          { type: "finish", text: "done" },
          { type: "error", message: "err" }
        ];
        for (const event of events) {
          yield* formatter(event);
        }
      }).pipe(Effect.provide(testLayer))
    );
  });
});
