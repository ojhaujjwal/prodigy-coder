import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { ProdigyAgent, makeProdigyAgentLayer } from "../prodigy-agent.ts";
import { defaultAgenticProfile } from "../../toolkit/default-toolkit.ts";
import {
  scriptedCommandExecutorLayer,
  scriptedInteractionLayer,
  scriptedSkillRepositoryLayer,
  scriptedToolModelLayer,
  scriptedWorkspaceLayer
} from "./helpers.ts";
import type { AgentEvent } from "../agent-event.ts";

/** A minimal HTTP client that never succeeds; webfetch is not exercised here. */
const stubHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() => Effect.die(new Error("webfetch not stubbed")))
);

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  reason,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
});

/**
 * The profile owns the default toolkit's handler Layer. Its handler Layer
 * requires the full authority set plus `HttpClient` for webfetch; the
 * composition root provides scripted/test layers for those requirements.
 */
const defaultProfile = defaultAgenticProfile();

const storeLayer = Layer.provideMerge(memoryStoreLayer, BunCrypto.layer);

const capabilityLayers = Layer.mergeAll(
  scriptedWorkspaceLayer({ "a.txt": "hello world" }).layer,
  scriptedCommandExecutorLayer({ "bash -c echo hi": { exitCode: 0, stdout: "hi\n", stderr: "" } }).layer,
  scriptedInteractionLayer([{ _tag: "Answered", answer: "42" }]).layer,
  scriptedSkillRepositoryLayer([
    { name: "grill", description: "Grills you", content: "Interview relentlessly.", disableModelInvocation: false }
  ]),
  stubHttpClientLayer
);

const runLayer = Layer.provideMerge(
  Layer.provideMerge(makeProdigyAgentLayer(defaultProfile), storeLayer),
  Layer.provideMerge(capabilityLayers, scriptedToolModelLayer([]))
);

layer(runLayer)("Default agentic toolkit", (it) => {
  it.effect("composes the full authority set into a ProdigyAgent layer", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events = yield* agent.run({ prompt: "Hello" }).pipe(Stream.runCollect);
      // With an empty model script, the run still emits run-started and run-ended.
      expect(events[0].type).toBe("run-started");
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );
});

// A focused run exercising read + shell + ask_user through the composed runtime.
const exerciseLayer = Layer.provideMerge(
  Layer.provideMerge(
    makeProdigyAgentLayer(defaultProfile),
    Layer.provideMerge(
      storeLayer,
      scriptedToolModelLayer([
        [{ type: "tool-call", id: "c1", name: "read", params: { filePath: "a.txt" } }, finish("tool-calls")],
        [{ type: "tool-call", id: "c2", name: "shell", params: { command: "echo hi" } }, finish("tool-calls")],
        [{ type: "tool-call", id: "c3", name: "ask_user", params: { question: "what?" } }, finish("tool-calls")],
        [{ type: "text-delta", id: "t", delta: "done" }, finish("stop")]
      ])
    )
  ),
  Layer.provideMerge(capabilityLayers, Layer.empty)
);

layer(exerciseLayer)("Default agentic toolkit execution", (it) => {
  it.effect("executes read, shell, and ask_user through the capability services", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events: ReadonlyArray<AgentEvent> = yield* agent.run({ prompt: "Do things" }).pipe(Stream.runCollect);

      const readResult = events.find((e) => e.type === "tool-result" && e.toolName === "read");
      expect(readResult).toMatchObject({ outcome: { _tag: "Success", output: "hello world" } });

      const shellResult = events.find((e) => e.type === "tool-result" && e.toolName === "shell");
      expect(shellResult).toMatchObject({ outcome: { _tag: "Success", output: "hi\n" } });

      const askResult = events.find((e) => e.type === "tool-result" && e.toolName === "ask_user");
      expect(askResult).toMatchObject({ outcome: { _tag: "Success", output: "42" } });

      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );
});
