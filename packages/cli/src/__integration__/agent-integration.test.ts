import { describe, expect, layer } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Predicate, Schema, Stream } from "effect";
import * as FileSystem from "effect/FileSystem";
import { LanguageModel, Prompt, Response } from "effect/unstable/ai";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  Workspace,
  WorkspacePath,
  ProdigyAgent,
  PositiveInt,
  SessionStore,
  makeProdigyAgentLayer,
  makeDefaultAgenticProfile,
  memorySessionStoreLayer
} from "@prodigy/core";
import type { AgentEvent } from "@prodigy/core";
import type { OutputEvent } from "../output.ts";
import type { ConfigData } from "../config.ts";
import { needsApproval } from "../approval.ts";
import { makeHumanInteractionLayer } from "../human-interaction.ts";
import { makeSkillRepositoryLayer } from "../skills.ts";
import { layer as commandExecutorLayer } from "../adapters/command-executor.ts";
import { layer as workspaceLayer } from "../adapters/workspace.ts";

type MockResponse =
  | { readonly type: "text"; readonly content: string }
  | { readonly type: "tool-call"; readonly id: string; readonly name: string; readonly arguments: Schema.Json };

type TestConfig = Pick<ConfigData, "maxTurns" | "approvalMode" | "nonInteractive" | "systemPrompt">;

const finish = (reason: "stop" | "tool-calls" | "length"): Response.StreamPartEncoded => ({
  type: "finish",
  reason,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
});

const scriptedModelLayer = (
  turns: ReadonlyArray<ReadonlyArray<MockResponse>>,
  prompts: Array<Prompt.Prompt>
): Layer.Layer<LanguageModel.LanguageModel> => {
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

const outputEvents = (events: ReadonlyArray<AgentEvent>): ReadonlyArray<OutputEvent> =>
  events.flatMap((event): ReadonlyArray<OutputEvent> => {
    switch (event.type) {
      case "text-delta":
        return [{ type: "text-delta" as const, delta: event.delta }];
      case "tool-call":
        return [{ type: "tool-call" as const, id: event.callId, name: event.toolName, params: event.input }];
      case "tool-result":
        return [
          event.outcome._tag === "Success"
            ? {
                type: "tool-result" as const,
                id: event.callId,
                name: event.toolName,
                result: Predicate.isString(event.outcome.output)
                  ? event.outcome.output
                  : JSON.stringify(event.outcome.output),
                isError: false
              }
            : {
                type: "tool-result" as const,
                id: event.callId,
                name: event.toolName,
                result: event.outcome.error,
                isError: true
              }
        ];
      case "run-ended":
        return [
          event.result._tag === "Finished"
            ? { type: "finish" as const, text: event.result.finishReason }
            : { type: "error" as const, message: `Max turns exceeded (${event.result.limit})` }
        ];
      default:
        return [];
    }
  });

const runAgentWithMockServer = (
  userMessages: readonly string[],
  responses: ReadonlyArray<ReadonlyArray<MockResponse>>,
  configOverrides: Partial<TestConfig> = {},
  cwd = "."
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const config: TestConfig = {
        maxTurns: 50,
        approvalMode: "none",
        nonInteractive: true,
        systemPrompt: undefined,
        ...configOverrides
      };
      const prompts: Array<Prompt.Prompt> = [];
      const capabilityLayer = Layer.mergeAll(
        memorySessionStoreLayer,
        workspaceLayer(cwd),
        commandExecutorLayer(cwd),
        makeHumanInteractionLayer(config.nonInteractive ?? false),
        makeSkillRepositoryLayer([])
      ).pipe(Layer.provideMerge(BunServices.layer));
      const agentsPath = Schema.decodeUnknownSync(WorkspacePath)("AGENTS.md");
      const agentsMd = yield* Effect.gen(function* () {
        const workspace = yield* Workspace;
        return yield* workspace
          .read(agentsPath)
          .pipe(Effect.catchTag("WorkspaceLookupError", () => Effect.succeed("")));
      }).pipe(
        // @effect-diagnostics-next-line effect/strictEffectProvide:off
        Effect.provide(capabilityLayer)
      );
      const profile = makeDefaultAgenticProfile({
        maxTurns: PositiveInt.make(config.maxTurns),
        systemPrompt: [agentsMd.trim(), config.systemPrompt ?? ""].filter(Boolean).join("\n\n"),
        needsApproval: (toolName) => needsApproval(toolName, config.approvalMode)
      });
      const modelLayer = scriptedModelLayer(responses, prompts);
      const handlerLayer = profile.toolkitHandlerLayer.pipe(
        Layer.provide(Layer.merge(capabilityLayer, FetchHttpClient.layer))
      );
      const agentLayer = Layer.provideMerge(
        Layer.provideMerge(makeProdigyAgentLayer(profile), capabilityLayer),
        handlerLayer
      );
      const context = yield* Layer.build(Layer.provideMerge(agentLayer, modelLayer));
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));
      const events = yield* agent
        .run({ prompt: userMessages.join("\n\n"), maxTurns: config.maxTurns })
        .pipe(Stream.runCollect);
      const collected = Array.from(events);
      const started = collected.find(
        (event): event is Extract<AgentEvent, { readonly type: "run-started" }> => event.type === "run-started"
      );
      const session =
        started === undefined
          ? undefined
          : yield* Effect.gen(function* () {
              const store = yield* SessionStore;
              return yield* store.load(started.sessionId);
            }).pipe(Effect.provide(context));
      return { result: outputEvents(collected), server: { calls: prompts }, session, events: collected };
    })
  );

layer(Layer.merge(BunServices.layer, FetchHttpClient.layer))("e2e", (it) => {
  it.effect("responds with text from mock OpenAI server", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(["hello"], [[testText("Hello from mock server")]]);
      expect(result.filter((event) => event.type === "text-delta").length).toBeGreaterThan(0);
      expect(result.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
      expect(result.filter((event) => event.type === "tool-call")).toHaveLength(0);
    })
  );

  it.effect("executes single tool-call then returns text", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["run echo"],
        [[testToolCall("call-1", "shell", { command: "echo hello-e2e" })], [testText("Done")]]
      );
      const toolCalls = result.filter((event) => event.type === "tool-call");
      const toolResults = result.filter((event) => event.type === "tool-result");
      expect(toolCalls).toHaveLength(1);
      expect(toolCalls[0]).toMatchObject({ name: "shell", params: { command: "echo hello-e2e" } });
      expect(toolResults).toHaveLength(1);
      expect(toolResults[0]).toMatchObject({ name: "shell", isError: false });
      if (toolResults[0]?.type === "tool-result") expect(toolResults[0].result).toContain("hello-e2e");
      expect(result.filter((event) => event.type === "text-delta").length).toBeGreaterThan(0);
      expect(result.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
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
      expect(result.filter((event) => event.type === "tool-call")).toHaveLength(2);
      expect(result.filter((event) => event.type === "tool-result")).toHaveLength(2);
      expect(result.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
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
      expect(result.filter((event) => event.type === "tool-call")).toHaveLength(2);
      expect(result.filter((event) => event.type === "tool-result")).toHaveLength(2);
      expect(result.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
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
      expect(result.filter((event) => event.type === "tool-call").length).toBeGreaterThanOrEqual(2);
      expect(result.filter((event) => event.type === "tool-result").length).toBeGreaterThanOrEqual(2);
      expect(result.filter((event) => event.type === "finish").length).toBeGreaterThanOrEqual(1);
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
      expect(result.filter((event) => event.type === "tool-result")).toEqual(
        expect.arrayContaining([expect.objectContaining({ isError: true })])
      );
    })
  );

  it.effect("emits max-turns-exceeded error when loop limit reached", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["infinite loop"],
        [[testToolCall("call-1", "shell", { command: "echo loop" })]],
        { maxTurns: 1 }
      );
      const errors = result.filter((event) => event.type === "error");
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ message: "Max turns exceeded (1)" });
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
      expect(result).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool-result", name: "shell", isError: true })])
      );
      expect(result).toEqual(
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
      const updatedContent = yield* fs.readFileString(`${tmpDir}/README.md`);
      expect(result.filter((event) => event.type === "tool-call").map((event) => event.name)).toEqual([
        "glob",
        "read",
        "read",
        "write"
      ]);
      expect(result.filter((event) => event.type === "tool-result")).toHaveLength(4);
      expect(result.filter((event) => event.type === "tool-result").every((event) => !event.isError)).toBe(true);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text-delta", delta: expect.stringContaining("Updated README.md") })
        ])
      );
      expect(updatedContent).toContain("Coding Agent CLI");
      expect(updatedContent).toContain("prodigy <prompt>");
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
