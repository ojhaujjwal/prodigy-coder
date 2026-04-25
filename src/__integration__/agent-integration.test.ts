import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Tool } from "effect/unstable/ai";
import { BunServices } from "@effect/platform-bun";
import { runAgent, type AgentConfig } from "../agent.ts";
import { buildProviderLayer } from "../provider.ts";
import { AgenticToolkitLayer, makeToolkitLayer, AgenticToolkit } from "../tools/index.ts";
import type { OutputEvent } from "../output.ts";
import type { Message } from "../session.ts";
import { createMockOpenAIServer, createTestConfig, createTestSession, type MockOpenAIResponse } from "./helpers.ts";
import type { ConfigData } from "../config.ts";

const runAgentWithMockServer = (
  prompt: string,
  responses: MockOpenAIResponse[][],
  configOverrides?: Partial<ConfigData>,
  toolkitLayer?: Layer.Layer<Tool.HandlersFor<typeof AgenticToolkit.tools>>
) =>
  Effect.gen(function* () {
    const server = yield* createMockOpenAIServer(responses);

    const config = createTestConfig({
      provider: {
        type: "openai-compat",
        apiKey: "test",
        baseUrl: server.url,
        model: "test-model"
      },
      ...configOverrides
    });

    const session = createTestSession();
    const agentConfig: AgentConfig = { session, config };

    const tl = toolkitLayer ?? AgenticToolkitLayer;
    const providerLayer = Layer.merge(buildProviderLayer(config.provider), tl).pipe(
      Layer.provide(FetchHttpClient.layer)
    );

    const result = yield* runAgent(prompt, agentConfig, providerLayer);

    return { result, server, session };
  });

describe("e2e", () => {
  it.effect("responds with text from mock OpenAI server", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer("hello", [
        [{ type: "text", content: "Hello from mock server" }]
      ]);

      const textDeltas = result.filter((e: OutputEvent) => e.type === "text-delta");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");
      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");

      expect(textDeltas.length).toBeGreaterThan(0);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls.length).toBe(0);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("executes single tool-call then returns text", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer("run echo", [
        [{ type: "tool-call", id: "call-1", name: "shell", arguments: { command: "echo hello-e2e" } }],
        [{ type: "text", content: "Done" }]
      ]);

      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");
      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const textDeltas = result.filter((e: OutputEvent) => e.type === "text-delta");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");

      expect(toolCalls.length).toBe(1);
      expect(toolCalls[0].type === "tool-call" && toolCalls[0].name).toBe("shell");
      expect(toolCalls[0].type === "tool-call" && toolCalls[0].params).toEqual({ command: "echo hello-e2e" });

      expect(toolResults.length).toBe(1);
      expect(toolResults[0].type === "tool-result" && toolResults[0].name).toBe("shell");
      expect(toolResults[0].type === "tool-result" && toolResults[0].isError).toBe(false);
      expect(toolResults[0].type === "tool-result" && toolResults[0].result).toContain("hello-e2e");

      expect(textDeltas.length).toBeGreaterThan(0);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("executes multiple tool calls in one turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = `/tmp/prodigy-e2e-${crypto.randomUUID()}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.writeFileString(`${tmpDir}/a.txt`, "content-a");
      yield* fs.writeFileString(`${tmpDir}/b.txt`, "");

      const { result } = yield* runAgentWithMockServer("read and write", [
        [
          { type: "tool-call", id: "call-1", name: "read", arguments: { filePath: `${tmpDir}/a.txt` } },
          {
            type: "tool-call",
            id: "call-2",
            name: "write",
            arguments: { filePath: `${tmpDir}/b.txt`, content: "updated" }
          }
        ],
        [{ type: "text", content: "All done" }]
      ]);

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");
      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");

      expect(toolCalls.length).toBe(2);
      expect(toolCalls[0].type === "tool-call" && toolCalls[0].name).toBe("read");
      expect(toolCalls[1].type === "tool-call" && toolCalls[1].name).toBe("write");
      expect(toolResults.length).toBe(2);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("executes sequential tool calls across turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = `/tmp/prodigy-e2e-${crypto.randomUUID()}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.makeDirectory(`${tmpDir}/src`);
      yield* fs.writeFileString(`${tmpDir}/src/a.ts`, "const x = 1;");
      yield* fs.writeFileString(`${tmpDir}/src/b.ts`, "const y = 2;");

      const { result } = yield* runAgentWithMockServer("find and read ts files", [
        [
          {
            type: "tool-call",
            id: "call-1",
            name: "glob",
            arguments: { pattern: "*.ts", path: `${tmpDir}/src` }
          }
        ],
        [
          {
            type: "tool-call",
            id: "call-2",
            name: "read",
            arguments: { filePath: `${tmpDir}/src/a.ts` }
          }
        ],
        [{ type: "text", content: "Analysis complete" }]
      ]);

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");
      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");

      expect(toolCalls.length).toBe(2);
      expect(toolCalls[0].type === "tool-call" && toolCalls[0].name).toBe("glob");
      expect(toolCalls[1].type === "tool-call" && toolCalls[1].name).toBe("read");
      expect(toolResults.length).toBe(2);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("continues loop when turn has both text and tool-calls", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer("run commands", [
        [{ type: "tool-call", id: "call-1", name: "shell", arguments: { command: "echo first" } }],
        [
          { type: "text", content: "Result after tool" },
          { type: "tool-call", id: "call-2", name: "shell", arguments: { command: "echo second" } }
        ],
        [{ type: "text", content: "All complete" }]
      ]);

      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");
      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");

      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
      expect(toolResults.length).toBeGreaterThanOrEqual(2);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("reports tool execution error", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer("read bad file", [
        [{ type: "tool-call", id: "call-1", name: "read", arguments: { filePath: "/nonexistent/file.txt" } }],
        [{ type: "text", content: "Failed" }]
      ]);

      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].type === "tool-result" && toolResults[0].isError).toBe(true);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("emits max-turns-exceeded error when loop limit reached", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        "infinite loop",
        [[{ type: "tool-call", id: "call-1", name: "shell", arguments: { command: "echo loop" } }]],
        { maxTurns: 1 }
      );

      const errors = result.filter((e: OutputEvent) => e.type === "error");
      expect(errors.length).toBe(1);
      expect(errors[0].type === "error" && errors[0].message).toContain("Max turns exceeded");
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("accumulates session messages across turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = `/tmp/prodigy-e2e-${crypto.randomUUID()}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.writeFileString(`${tmpDir}/test.txt`, "file content");

      const { session } = yield* runAgentWithMockServer("read and respond", [
        [
          {
            type: "tool-call",
            id: "call-1",
            name: "read",
            arguments: { filePath: `${tmpDir}/test.txt` }
          }
        ],
        [{ type: "text", content: "Done reading" }]
      ]);

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      expect(session.messages.length).toBeGreaterThanOrEqual(4);

      const userMessages = session.messages.filter((m: Message) => m.role === "user");
      expect(userMessages.length).toBe(1);

      const assistantMessages = session.messages.filter((m: Message) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      const toolMessages = session.messages.filter((m: Message) => m.role === "tool");
      expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("prepends system prompt to LLM request", () =>
    Effect.gen(function* () {
      const { server } = yield* runAgentWithMockServer("hello", [[{ type: "text", content: "Hi there" }]], {
        systemPrompt: "You are a helpful assistant."
      });

      expect(server.calls.length).toBe(1);
      const requestBody = JSON.stringify(server.calls[0]);
      expect(requestBody).toContain("You are a helpful assistant");
      expect(requestBody).toContain("system");
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("approvalMode dangerous: blocks dangerous tool, allows safe tool", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = `/tmp/prodigy-e2e-${crypto.randomUUID()}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.writeFileString(`${tmpDir}/safe.txt`, "data");

      const { result } = yield* runAgentWithMockServer(
        "run shell and read",
        [
          [
            { type: "tool-call", id: "call-1", name: "shell", arguments: { command: "ls" } },
            {
              type: "tool-call",
              id: "call-2",
              name: "read",
              arguments: { filePath: `${tmpDir}/safe.txt` }
            }
          ],
          [{ type: "text", content: "Done" }]
        ],
        { approvalMode: "dangerous", nonInteractive: true },
        makeToolkitLayer({ approvalMode: "dangerous", nonInteractive: true })
      );

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const shellResult = toolResults.find((e: OutputEvent) => e.type === "tool-result" && e.name === "shell");
      const readResult = toolResults.find((e: OutputEvent) => e.type === "tool-result" && e.name === "read");

      expect(shellResult).toBeDefined();
      if (shellResult && shellResult.type === "tool-result") {
        expect(shellResult.isError).toBe(true);
        expect(shellResult.result).toContain("denied approval");
      }

      expect(readResult).toBeDefined();
      if (readResult && readResult.type === "tool-result") {
        expect(readResult.isError).toBe(false);
      }
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("approvalMode all: blocks all tools in non-interactive mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = `/tmp/prodigy-e2e-${crypto.randomUUID()}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.writeFileString(`${tmpDir}/safe.txt`, "data");

      const { result } = yield* runAgentWithMockServer(
        "run shell and read",
        [
          [
            { type: "tool-call", id: "call-1", name: "shell", arguments: { command: "ls" } },
            {
              type: "tool-call",
              id: "call-2",
              name: "read",
              arguments: { filePath: `${tmpDir}/safe.txt` }
            }
          ],
          [{ type: "text", content: "Done" }]
        ],
        { approvalMode: "all", nonInteractive: true },
        makeToolkitLayer({ approvalMode: "all", nonInteractive: true })
      );

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const shellResult = toolResults.find((e: OutputEvent) => e.type === "tool-result" && e.name === "shell");
      const readResult = toolResults.find((e: OutputEvent) => e.type === "tool-result" && e.name === "read");

      expect(shellResult).toBeDefined();
      if (shellResult && shellResult.type === "tool-result") expect(shellResult.isError).toBe(true);

      expect(readResult).toBeDefined();
      if (readResult && readResult.type === "tool-result") expect(readResult.isError).toBe(true);
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("askUserTool fails in non-interactive mode", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        "ask user something",
        [
          [
            {
              type: "tool-call",
              id: "call-1",
              name: "ask_user",
              arguments: { question: "What is your name?" }
            }
          ],
          [{ type: "text", content: "Asked" }]
        ],
        { approvalMode: "none", nonInteractive: true },
        makeToolkitLayer({ approvalMode: "none", nonInteractive: true })
      );

      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const askResult = toolResults.find((e: OutputEvent) => e.type === "tool-result" && e.name === "ask_user");

      expect(askResult).toBeDefined();
      if (askResult && askResult.type === "tool-result") {
        expect(askResult.isError).toBe(true);
        expect(askResult.result).toContain("non-interactive");
      }
    }).pipe(Effect.provide(BunServices.layer))
  );

  it.effect("completes multi-step glob → read → write workflow", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tmpDir = `/tmp/prodigy-e2e-${crypto.randomUUID()}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.makeDirectory(`${tmpDir}/src`);
      yield* fs.writeFileString(`${tmpDir}/README.md`, "# Prodigy Coder\n\nInitial content.\n");
      yield* fs.writeFileString(
        `${tmpDir}/src/index.ts`,
        "// CLI entry point\nimport { BunRuntime } from '@effect/platform-bun';\n"
      );

      const { result } = yield* runAgentWithMockServer("Update README.md to add one sentence about CLI", [
        [
          {
            type: "tool-call",
            id: "call-glob",
            name: "glob",
            arguments: { pattern: "README.md", path: tmpDir }
          }
        ],
        [
          {
            type: "tool-call",
            id: "call-read-index",
            name: "read",
            arguments: { filePath: `${tmpDir}/src/index.ts` }
          }
        ],
        [
          {
            type: "tool-call",
            id: "call-read-readme",
            name: "read",
            arguments: { filePath: `${tmpDir}/README.md` }
          }
        ],
        [
          {
            type: "tool-call",
            id: "call-write",
            name: "write",
            arguments: {
              filePath: `${tmpDir}/README.md`,
              content:
                "# Prodigy Coder\n\nInitial content.\n\nThis project is a Coding Agent CLI. Run it with `prodigy <prompt>`.\n"
            }
          }
        ],
        [{ type: "text", content: "Updated README.md with CLI usage info." }]
      ]);

      const updatedContent = yield* fs.readFileString(`${tmpDir}/README.md`);

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");
      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const textDeltas = result.filter((e: OutputEvent) => e.type === "text-delta");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");

      const toolCallNames = toolCalls
        .filter(
          (e: OutputEvent): e is { type: "tool-call"; id: string; name: string; params: unknown } =>
            e.type === "tool-call"
        )
        .map((e: { name: string }) => e.name);
      expect(toolCallNames).toEqual(["glob", "read", "read", "write"]);

      expect(toolResults.length).toBe(4);
      const allSucceeded = toolResults.every((e: OutputEvent) => e.type === "tool-result" && e.isError === false);
      expect(allSucceeded).toBe(true);

      expect(textDeltas.length).toBeGreaterThan(0);
      expect(
        textDeltas.some((e: OutputEvent) => e.type === "text-delta" && e.delta.includes("Updated README.md"))
      ).toBe(true);
      expect(finishes.length).toBeGreaterThanOrEqual(1);

      expect(updatedContent).toContain("Coding Agent CLI");
      expect(updatedContent).toContain("prodigy <prompt>");
    }).pipe(Effect.provide(BunServices.layer))
  );
});
