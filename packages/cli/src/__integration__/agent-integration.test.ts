import { describe, layer, expect } from "@effect/vitest";
import { Crypto, Effect, Layer } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { Tool } from "effect/unstable/ai";
import { BunServices } from "@effect/platform-bun";
import { runAgent, type AgentConfig } from "../agent.ts";
import { buildProviderLayer } from "../provider.ts";
import { makeToolkitLayer, AgenticToolkit, EmptySkillsRepoLayer } from "../tools/index.ts";
import { ApprovalGate, makeApprovalGateLayer } from "../approval-gate.ts";
import type { OutputEvent } from "../output.ts";
import type { Message } from "../session.ts";
import { createMockOpenAIServer, createTestConfig, createTestSession, type MockOpenAIResponse } from "./helpers.ts";
import type { ConfigData } from "../config.ts";

const runAgentWithMockServer = (
  userMessages: readonly string[],
  responses: MockOpenAIResponse[][],
  configOverrides?: Partial<ConfigData>,
  toolkitLayer?: Layer.Layer<Tool.HandlersFor<typeof AgenticToolkit.tools>, never, ApprovalGate>,
  cwd = "."
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

    const sessionId = yield* (yield* Crypto.Crypto).randomUUIDv4;
    const session = createTestSession(sessionId);
    const agentConfig: AgentConfig = { session, config, cwd };

    const tl =
      toolkitLayer ??
      makeToolkitLayer({
        nonInteractive: config.nonInteractive ?? false,
        skillsRepoLayer: EmptySkillsRepoLayer
      });
    const agentLayer = Layer.merge(
      buildProviderLayer(config.provider).pipe(Layer.provideMerge(FetchHttpClient.layer)),
      tl
    ).pipe(Layer.provide(makeApprovalGateLayer(config)));
    const agentContext = yield* Layer.build(agentLayer);
    const result = yield* runAgent(userMessages, agentConfig).pipe(Effect.provide(agentContext));

    return { result, server, session };
  });

layer(Layer.merge(BunServices.layer, EmptySkillsRepoLayer))("e2e", (it) => {
  it.effect("responds with text from mock OpenAI server", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["hello"],
        [[{ type: "text", content: "Hello from mock server" }]]
      );

      const textDeltas = result.filter((e: OutputEvent) => e.type === "text-delta");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");
      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");

      expect(textDeltas.length).toBeGreaterThan(0);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
      expect(toolCalls.length).toBe(0);
    })
  );

  it.effect("executes single tool-call then returns text", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["run echo"],
        [
          [{ type: "tool-call", id: "call-1", name: "shell", arguments: { command: "echo hello-e2e" } }],
          [{ type: "text", content: "Done" }]
        ]
      );

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
    })
  );

  it.effect("executes multiple tool calls in one turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const tmpDir = `/tmp/prodigy-e2e-${uuid}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.writeFileString(`${tmpDir}/a.txt`, "content-a");
      yield* fs.writeFileString(`${tmpDir}/b.txt`, "");

      const { result } = yield* runAgentWithMockServer(
        ["read and write"],
        [
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
        ]
      );

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");
      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");

      expect(toolCalls.length).toBe(2);
      expect(toolCalls[0].type === "tool-call" && toolCalls[0].name).toBe("read");
      expect(toolCalls[1].type === "tool-call" && toolCalls[1].name).toBe("write");
      expect(toolResults.length).toBe(2);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("executes sequential tool calls across turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const tmpDir = `/tmp/prodigy-e2e-${uuid}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.makeDirectory(`${tmpDir}/src`);
      yield* fs.writeFileString(`${tmpDir}/src/a.ts`, "const x = 1;");
      yield* fs.writeFileString(`${tmpDir}/src/b.ts`, "const y = 2;");

      const { result } = yield* runAgentWithMockServer(
        ["find and read ts files"],
        [
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
        ]
      );

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");
      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");

      expect(toolCalls.length).toBe(2);
      expect(toolCalls[0].type === "tool-call" && toolCalls[0].name).toBe("glob");
      expect(toolCalls[1].type === "tool-call" && toolCalls[1].name).toBe("read");
      expect(toolResults.length).toBe(2);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("continues loop when turn has both text and tool-calls", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["run commands"],
        [
          [{ type: "tool-call", id: "call-1", name: "shell", arguments: { command: "echo first" } }],
          [
            { type: "text", content: "Result after tool" },
            { type: "tool-call", id: "call-2", name: "shell", arguments: { command: "echo second" } }
          ],
          [{ type: "text", content: "All complete" }]
        ]
      );

      const toolCalls = result.filter((e: OutputEvent) => e.type === "tool-call");
      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const finishes = result.filter((e: OutputEvent) => e.type === "finish");

      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
      expect(toolResults.length).toBeGreaterThanOrEqual(2);
      expect(finishes.length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("reports tool execution error", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["read bad file"],
        [
          [{ type: "tool-call", id: "call-1", name: "read", arguments: { filePath: "/nonexistent/file.txt" } }],
          [{ type: "text", content: "Failed" }]
        ]
      );

      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].type === "tool-result" && toolResults[0].isError).toBe(true);
    })
  );

  it.effect("emits max-turns-exceeded error when loop limit reached", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["infinite loop"],
        [[{ type: "tool-call", id: "call-1", name: "shell", arguments: { command: "echo loop" } }]],
        { maxTurns: 1 }
      );

      const errors = result.filter((e: OutputEvent) => e.type === "error");
      expect(errors.length).toBe(1);
      expect(errors[0].type === "error" && errors[0].message).toContain("Max turns exceeded");
    })
  );

  it.effect("accumulates session messages across turns", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const tmpDir = `/tmp/prodigy-e2e-${uuid}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.writeFileString(`${tmpDir}/test.txt`, "file content");

      const { session } = yield* runAgentWithMockServer(
        ["read and respond"],
        [
          [
            {
              type: "tool-call",
              id: "call-1",
              name: "read",
              arguments: { filePath: `${tmpDir}/test.txt` }
            }
          ],
          [{ type: "text", content: "Done reading" }]
        ]
      );

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      expect(session.messages.length).toBeGreaterThanOrEqual(4);

      const userMessages = session.messages.filter((m: Message) => m.role === "user");
      expect(userMessages.length).toBe(1);

      const assistantMessages = session.messages.filter((m: Message) => m.role === "assistant");
      expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

      const toolMessages = session.messages.filter((m: Message) => m.role === "tool");
      expect(toolMessages.length).toBeGreaterThanOrEqual(1);
    })
  );

  it.effect("approvalMode dangerous: blocks dangerous tool, allows safe tool", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const tmpDir = `/tmp/prodigy-e2e-${uuid}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.writeFileString(`${tmpDir}/safe.txt`, "data");

      const { result } = yield* runAgentWithMockServer(
        ["run shell and read"],
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
        makeToolkitLayer({ nonInteractive: true, skillsRepoLayer: EmptySkillsRepoLayer })
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
    })
  );

  it.effect("approvalMode all: blocks all tools in non-interactive mode", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const tmpDir = `/tmp/prodigy-e2e-${uuid}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.writeFileString(`${tmpDir}/safe.txt`, "data");

      const { result } = yield* runAgentWithMockServer(
        ["run shell and read"],
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
        makeToolkitLayer({ nonInteractive: true, skillsRepoLayer: EmptySkillsRepoLayer })
      );

      yield* fs.remove(tmpDir, { recursive: true }).pipe(Effect.catch(() => Effect.void));

      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const shellResult = toolResults.find((e: OutputEvent) => e.type === "tool-result" && e.name === "shell");
      const readResult = toolResults.find((e: OutputEvent) => e.type === "tool-result" && e.name === "read");

      expect(shellResult).toBeDefined();
      if (shellResult && shellResult.type === "tool-result") expect(shellResult.isError).toBe(true);

      expect(readResult).toBeDefined();
      if (readResult && readResult.type === "tool-result") expect(readResult.isError).toBe(true);
    })
  );

  it.effect("askUserTool fails in non-interactive mode", () =>
    Effect.gen(function* () {
      const { result } = yield* runAgentWithMockServer(
        ["ask user something"],
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
        makeToolkitLayer({ nonInteractive: true, skillsRepoLayer: EmptySkillsRepoLayer })
      );

      const toolResults = result.filter((e: OutputEvent) => e.type === "tool-result");
      const askResult = toolResults.find((e: OutputEvent) => e.type === "tool-result" && e.name === "ask_user");

      expect(askResult).toBeDefined();
      if (askResult && askResult.type === "tool-result") {
        expect(askResult.isError).toBe(true);
        expect(askResult.result).toContain("non-interactive");
      }
    })
  );

  it.effect("completes multi-step glob → read → write workflow", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const uuid = yield* (yield* Crypto.Crypto).randomUUIDv4;
      const tmpDir = `/tmp/prodigy-e2e-${uuid}`;
      yield* fs.makeDirectory(tmpDir);
      yield* fs.makeDirectory(`${tmpDir}/src`);
      yield* fs.writeFileString(`${tmpDir}/README.md`, "# Prodigy Coder\n\nInitial content.\n");
      yield* fs.writeFileString(
        `${tmpDir}/src/index.ts`,
        "// CLI entry point\nimport { BunRuntime } from '@effect/platform-bun';\n"
      );

      const { result } = yield* runAgentWithMockServer(
        ["Update README.md to add one sentence about CLI"],
        [
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
        ]
      );

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
        const { server } = yield* runAgentWithMockServer(
          ["hello"],
          [[{ type: "text", content: "Hi there" }]],
          undefined,
          undefined,
          cwd
        );

        expect(server.calls.length).toBe(1);
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
          [[{ type: "text", content: "Hi there" }]],
          {
            systemPrompt: "You are a helpful assistant."
          },
          undefined,
          cwd
        );

        expect(server.calls.length).toBe(1);
        const requestBody = JSON.stringify(server.calls[0]);
        expect(requestBody).toContain("AI Agentic Coding CLI");
        expect(requestBody).toContain("You are a helpful assistant");
        expect(requestBody).toContain("system");
      })
    );
  });
});
