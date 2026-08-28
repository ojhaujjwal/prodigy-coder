import { describe, expect, layer } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Schema, Stream } from "effect";
import * as AiError from "effect/unstable/ai/AiError";
import * as FileSystem from "effect/FileSystem";
import * as TestConsole from "effect/testing/TestConsole";
import { LanguageModel, Prompt, Response } from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { SessionStore, SessionId, PositiveInt, fileSystemWorkspaceLayer, memorySessionStoreLayer } from "@prodigy/core";
import type { ConfigData } from "../config.ts";
import { RunFailed, runInvocation } from "../invocation.ts";
import { makeStreamJsonFormatter, makeTextFormatter, type OutputEvent } from "../output.ts";
import { makeHumanInteractionLayer } from "../human-interaction.ts";
import { makeSkillRepositoryLayer } from "../skills.ts";
import { layer as commandExecutorLayer } from "../adapters/command-executor.ts";

type MockResponse =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: Schema.Json };

type TestConfig = Pick<ConfigData, "maxTurns" | "approvalMode" | "nonInteractive" | "systemPrompt">;

/** Brand a plain number so fixtures satisfy the `PositiveInt` config field. */
const turns = (n: number): PositiveInt => Schema.decodeUnknownSync(PositiveInt)(n);

const finish = (reason: "stop" | "tool-calls" | "length"): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
});

const scriptedModelLayer = (turns: ReadonlyArray<ReadonlyArray<MockResponse>>, prompts: Array<Prompt.Prompt>) => {
  let turn = 0;
  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (input) => {
        prompts.push(input.prompt);
        const response = turns[turn] ?? [];
        turn += 1;
        const parts: Response.StreamPartEncoded[] = [];
        for (const [index, part] of response.entries()) {
          if (part.type === "text") {
            parts.push({ type: "text-delta", id: `${turn}-${index}`, delta: part.content });
          } else {
            parts.push({ type: "tool-call", id: part.id, name: part.name, params: part.arguments });
          }
        }
        parts.push(finish(response.some((part) => part.type === "tool-call") ? "tool-calls" : "stop"));
        return Stream.fromIterable(parts);
      }
    })
  );
};

const testToolCall = (id: string, name: string, arguments_: Schema.Json): MockResponse => ({
  type: "tool-call",
  id,
  name,
  arguments: arguments_
});

const testText = (content: string): MockResponse => ({ type: "text", content });

/** A model whose stream always fails: the fatal-run projection's trigger. */
const failingModelLayer = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () => Effect.succeed([]),
    streamText: () =>
      Stream.fail(
        AiError.make({
          module: "Test",
          method: "streamText",
          reason: new AiError.UnknownError({ description: "model exploded" })
        })
      )
  })
);

const makeConfig = (overrides: Partial<TestConfig> = {}): ConfigData => ({
  provider: {
    type: "openai-compat",
    model: "test-model"
  },
  maxTurns: turns(50),
  approvalMode: "none",
  nonInteractive: true,
  systemPrompt: undefined,
  ...overrides
});

const makeInvocationStream = (
  userMessages: readonly string[],
  responses: ReadonlyArray<ReadonlyArray<MockResponse>>,
  configOverrides: Partial<TestConfig> = {},
  cwd = ".",
  modelLayer?: Layer.Layer<LanguageModel.LanguageModel>
) =>
  Effect.gen(function* () {
    const config = makeConfig(configOverrides);
    const prompts: Array<Prompt.Prompt> = [];
    const testLayer = Layer.mergeAll(
      memorySessionStoreLayer,
      fileSystemWorkspaceLayer(cwd).pipe(Layer.provide(commandExecutorLayer(cwd))),
      commandExecutorLayer(cwd),
      makeHumanInteractionLayer(config.nonInteractive ?? false),
      makeSkillRepositoryLayer([])
    ).pipe(Layer.provideMerge(BunServices.layer));
    const runContext = yield* Layer.build(
      Layer.mergeAll(testLayer, modelLayer ?? scriptedModelLayer(responses, prompts), FetchHttpClient.layer)
    );

    const events = runInvocation(userMessages.join("\n\n"), Option.none(), config, []).pipe(Stream.provide(runContext));

    return { config, prompts, events, runContext };
  });

const runAgentWithMockServer = (
  userMessages: readonly string[],
  responses: ReadonlyArray<ReadonlyArray<MockResponse>>,
  configOverrides: Partial<TestConfig> = {},
  cwd = "."
) =>
  Effect.gen(function* () {
    const { prompts, events, runContext } = yield* makeInvocationStream(userMessages, responses, configOverrides, cwd);
    const result = yield* events.pipe(Stream.runCollect);
    const sessionEvent = result.find((event) => event.type === "session-info");
    const store = yield* SessionStore.pipe(Effect.provide(runContext));
    const session =
      sessionEvent && sessionEvent.type === "session-info"
        ? Option.getOrUndefined(
            yield* store.load(Schema.decodeUnknownSync(SessionId)(sessionEvent.sessionId)).pipe(Effect.option)
          )
        : undefined;

    return { result, session, server: { calls: prompts } };
  });

layer(Layer.merge(BunServices.layer, FetchHttpClient.layer))("E2E", (it) => {
  it.effect("responds with text from mock OpenAI server", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(["hello"], [[testText("Hello from mock server")]]);
      const events = result;
      expect(events.filter((event) => event.type === "text-delta").length).toBeGreaterThan(0);
      expect(events.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
      expect(events.filter((event) => event.type === "tool-call")).toHaveLength(0);
    })
  );

  it.effect("executes single tool-call then returns text", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["run echo"],
        [[testToolCall("call-1", "shell", { command: "echo hello-e2e" })], [testText("Done")]]
      );
      const events = result;
      const toolCalls = events.filter((event) => event.type === "tool-call");
      const toolResults = events.filter((event) => event.type === "tool-result");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({ name: "shell", params: { command: "echo hello-e2e" } });
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toMatchObject({ name: "shell", isError: false });
      if (toolResults[0]?.type === "tool-result") expect(toolResults[0].result).toContain("hello-e2e");
      expect(events.filter((event) => event.type === "text-delta").length).toBeGreaterThan(0);
      expect(events.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("executes multiple tool calls in one turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${tmpDir}/a.txt`, "content-a");
      yield* fs.writeFileString(`${tmpDir}/b.txt`, "");
      const { result } = yield* runAgentWithMockServer(
        ["read and write"],
        [
          [
            testToolCall("call-1", "read", { filePath: "a.txt" }),
            testToolCall("call-2", "write", { filePath: "b.txt", content: "updated" })
          ],
          [testText("All done")]
        ],
        {},
        tmpDir
      );
      const events = result;
      expect(events.filter((event) => event.type === "tool-call")).toHaveLength(2);
      expect(events.filter((event) => event.type === "tool-result")).toHaveLength(2);
      expect(events.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("executes sequential tool calls across turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${tmpDir}/src`);
      yield* fs.writeFileString(`${tmpDir}/src/a.ts`, "const x = 1;");
      yield* fs.writeFileString(`${tmpDir}/src/b.ts`, "const y = 2;");
      const { result } = yield* runAgentWithMockServer(
        ["find and read ts files"],
        [
          [testToolCall("call-1", "glob", { pattern: "*.ts", path: "src" })],
          [testToolCall("call-2", "read", { filePath: "src/a.ts" })],
          [testText("Analysis complete")]
        ],
        {},
        tmpDir
      );
      const events = result;
      expect(events.filter((event) => event.type === "tool-call")).toHaveLength(2);
      expect(events.filter((event) => event.type === "tool-result")).toHaveLength(2);
      expect(events.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("continues loop when turn has both text and tool-calls", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["run commands"],
        [
          [testToolCall("call-1", "shell", { command: "echo first" })],
          [testText("Result after tool"), testToolCall("call-2", "shell", { command: "echo second" })],
          [testText("All complete")]
        ]
      );
      const events = result;
      expect(events.filter((event) => event.type === "tool-call").length).toBeGreaterThanOrEqual(2);
      expect(events.filter((event) => event.type === "tool-result").length).toBeGreaterThanOrEqual(2);
      expect(events.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("reports tool execution error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped();
      const { result } = yield* runAgentWithMockServer(
        ["read bad file"],
        [[testToolCall("call-1", "read", { filePath: "missing.txt" })], [testText("Failed")]],
        {},
        tmpDir
      );
      const events = result;
      expect(events.filter((event) => event.type === "tool-result")).toEqual(
        expect.arrayContaining([expect.objectContaining({ isError: true })])
      );
    })
  );

  it.effect("emits max-turns-exceeded error when loop limit reached", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["infinite loop"],
        [[testToolCall("call-1", "shell", { command: "echo loop" })]],
        { maxTurns: turns(1) }
      );
      const errors = result.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: "Max turns exceeded (1)" });
    })
  );

  it.effect("renders a fatal model failure as an error event and fails with RunFailed", () =>
    Effect.gen(function* () {
      const { events } = yield* makeInvocationStream(["hello"], [], {}, ".", failingModelLayer);
      const received: OutputEvent[] = [];
      const failure = yield* events.pipe(
        Stream.runForEach((event) => Effect.sync(() => received.push(event))),
        Effect.flip
      );
      expect(failure).toBeInstanceOf(RunFailed);
      const errorEvent = received.find((event) => event.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.type === "error" && errorEvent.message).toContain("Model error");
    })
  );

  it.effect("accumulates session messages across turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${tmpDir}/test.txt`, "file content");
      const { session } = yield* runAgentWithMockServer(
        ["read and respond"],
        [[testToolCall("call-1", "read", { filePath: "test.txt" })], [testText("Done reading")]],
        {},
        tmpDir
      );
      expect(session?.session.messages.length).toBeGreaterThanOrEqual(4);
      expect(session?.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
      expect(session?.session.messages.filter((message) => message.role === "assistant").length).toBeGreaterThanOrEqual(
        1
      );
      expect(session?.session.messages.filter((message) => message.role === "tool").length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("approvalMode dangerous: blocks dangerous tool, allows safe tool", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${tmpDir}/safe.txt`, "data");
      const { result } = yield* runAgentWithMockServer(
        ["run shell and read"],
        [
          [
            testToolCall("call-1", "shell", { command: "ls" }),
            testToolCall("call-2", "read", { filePath: "safe.txt" })
          ],
          [testText("Done")]
        ],
        { approvalMode: "dangerous", nonInteractive: true },
        tmpDir
      );
      const events = result;
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool-result", name: "shell", isError: true })])
      );
      expect(events).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool-result", name: "read", isError: false })])
      );
    })
  );

  it.effect("approvalMode all: blocks all tools in non-interactive mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.writeFileString(`${tmpDir}/safe.txt`, "data");
      const { result } = yield* runAgentWithMockServer(
        ["run shell and read"],
        [
          [
            testToolCall("call-1", "shell", { command: "ls" }),
            testToolCall("call-2", "read", { filePath: "safe.txt" })
          ],
          [testText("Done")]
        ],
        { approvalMode: "all", nonInteractive: true },
        tmpDir
      );
      const toolResults = result.filter((event) => event.type === "tool-result");
      expect(toolResults).toHaveLength(2);
      expect(toolResults.every((event) => event.type === "tool-result" && event.isError)).toBe(true);
    })
  );

  it.effect("askUserTool fails in non-interactive mode", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["ask user something"],
        [[testToolCall("call-1", "ask_user", { question: "What is your name?" })], [testText("Asked")]],
        { approvalMode: "none", nonInteractive: true }
      );
      expect(result).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool-result", name: "ask_user", isError: true })])
      );
    })
  );

  it.effect("completes multi-step glob -> read -> write workflow", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped();
      yield* fs.makeDirectory(`${tmpDir}/src`);
      yield* fs.writeFileString(`${tmpDir}/README.md`, "# Prodigy Coder\n\nInitial content.\n");
      yield* fs.writeFileString(`${tmpDir}/src/index.ts`, "// CLI entry point\n");
      const { result } = yield* runAgentWithMockServer(
        ["Update README.md to add one sentence about CLI"],
        [
          [testToolCall("call-glob", "glob", { pattern: "README.md", path: "." })],
          [testToolCall("call-read-index", "read", { filePath: "src/index.ts" })],
          [testToolCall("call-read-readme", "read", { filePath: "README.md" })],
          [
            testToolCall("call-write", "write", {
              filePath: "README.md",
              content:
                "# Prodigy Coder\n\nInitial content.\n\nThis project is a Coding Agent CLI. Run it with `prodigy <prompt>`.\n"
            })
          ],
          [testText("Updated README.md with CLI usage info.")]
        ],
        {},
        tmpDir
      );
      const events = result;
      const updatedContent = yield* fs.readFileString(`${tmpDir}/README.md`);
      expect(events.filter((event) => event.type === "tool-call").map((event) => event.name)).toEqual([
        "glob",
        "read",
        "read",
        "write"
      ]);
      expect(events.filter((event) => event.type === "tool-result")).toHaveLength(4);
      expect(events.filter((event) => event.type === "tool-result").every((event) => !event.isError)).toBe(true);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text-delta", delta: expect.stringContaining("Updated README.md") })
        ])
      );
      expect(updatedContent).toContain("Coding Agent CLI");
      expect(updatedContent).toContain("prodigy <prompt>");
    })
  );

  it.effect("streams events incrementally through per-event handling", () =>
    Effect.gen(function* () {
      const { events } = yield* makeInvocationStream(["incremental"], [[testText("first"), testText("second")]], {});
      const received: OutputEvent[] = [];
      yield* events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            received.push(event);
          })
        )
      );
      expect(received[0]).toMatchObject({ type: "session-info" });
      expect(received.some((event) => event.type === "text-delta")).toBe(true);
      expect(received.at(-1)).toMatchObject({ type: "finish" });
    })
  );

  it.layer(TestConsole.layer)("formatter capture", (it) => {
    it.effect("drains a real run through the text formatter without throwing", () =>
      Effect.gen(function* () {
        const { events } = yield* makeInvocationStream(["hi"], [[testText("Hello")]]);
        yield* events.pipe(Stream.runForEach(makeTextFormatter()));
        const logs = yield* TestConsole.logLines;
        expect(logs.join("\n")).toContain("export PRODIGY_SESSION_ID=");
      })
    );

    it.effect("drains a real run through the stream-json formatter as parseable lines", () =>
      Effect.gen(function* () {
        const { events } = yield* makeInvocationStream(["hi"], [[testText("Hello")]]);
        yield* events.pipe(Stream.runForEach(makeStreamJsonFormatter()));
        const logs = yield* TestConsole.logLines;
        // TestConsole accumulates across tests in the file; the stream-json lines are
        // the ones that are JSON objects (text-formatter output is not JSON).
        const jsonLines = logs.map(String).filter((line) => line.startsWith("{"));
        const parsed = jsonLines.map((line) => JSON.parse(line));
        expect(parsed.length).toBeGreaterThan(0);
        expect(parsed.some((p) => p.type === "session")).toBe(true);
      })
    );
  });

  it.effect("falls back to a new session (with a notice) when the requested session id is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = yield* fs.makeTempDirectoryScoped();
      const badId = Schema.decodeUnknownSync(SessionId)("deadbeef");
      const modelLayer = scriptedModelLayer([[testText("Hello")]], []);
      const runContext = yield* Layer.build(
        Layer.mergeAll(
          memorySessionStoreLayer,
          fileSystemWorkspaceLayer(tmpDir).pipe(Layer.provide(commandExecutorLayer(tmpDir))),
          commandExecutorLayer(tmpDir),
          makeHumanInteractionLayer(false),
          makeSkillRepositoryLayer([]),
          modelLayer,
          FetchHttpClient.layer
        ).pipe(Layer.provideMerge(BunServices.layer))
      );
      const events = runInvocation("hi", Option.some(badId), makeConfig(), []).pipe(Stream.provide(runContext));
      const collected = yield* events.pipe(Stream.runCollect);
      const notices = collected.filter((e) => e.type === "notice");
      const sessions = collected.filter((e) => e.type === "session-info");
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ message: expect.stringContaining("not found") });
      expect(sessions).toHaveLength(1);
      expect(collected.some((e) => e.type === "finish")).toBe(true);
    })
  );

  describe("System Prompt", () => {
    const makeAgentsWorkspace = (content: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped();
        yield* fs.writeFileString(`${cwd}/AGENTS.md`, content);
        return cwd;
      });

    it.effect("prepends AGENTS.md content when no explicit systemPrompt", () =>
      Effect.gen(function* () {
        const cwd = yield* makeAgentsWorkspace("AI Agentic Coding CLI");
        const { server } = yield* runAgentWithMockServer(["hello"], [[testText("Hi there")]], {}, cwd);
        expect(server.calls).toHaveLength(1);
        const requestBody = JSON.stringify(server.calls[0]);
        expect(requestBody).toContain("AI Agentic Coding CLI");
        expect(requestBody).toContain("system");
        expect(requestBody).not.toContain("You are a helpful assistant");
      })
    );

    it.effect("prepends both AGENTS.md and explicit systemPrompt when both present", () =>
      Effect.gen(function* () {
        const cwd = yield* makeAgentsWorkspace("AI Agentic Coding CLI");
        const { server } = yield* runAgentWithMockServer(
          ["hello"],
          [[testText("Hi there")]],
          { systemPrompt: "You are a helpful assistant." },
          cwd
        );
        expect(server.calls).toHaveLength(1);
        const requestBody = JSON.stringify(server.calls[0]);
        expect(requestBody).toContain("AI Agentic Coding CLI");
        expect(requestBody).toContain("You are a helpful assistant");
        expect(requestBody).toContain("system");
      })
    );
  });
});
