import { Context, Effect, Layer, Scope, Stream } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { LanguageModel } from "effect/unstable/ai";
import { ProdigyAgent } from "../../src/agent/prodigy-agent.ts";
import type { AgentError } from "../../src/agent/agent-error.ts";
import type { AgentEvent } from "../../src/agent/agent-event.ts";
import { SessionStore } from "../../src/capabilities/session-store.ts";
import { layerNoDeps as memoryStoreLayer } from "../../src/capabilities/memory-session-store.ts";
import {
  createMockLLMServer,
  openaiCompatProviderLayer,
  type MockLLMPart,
  type MockLLMServer
} from "./mock-llm-server.ts";

export const finish = (reason: "stop" | "tool-calls"): MockLLMPart => ({ type: "finish", reason });

export const storeLayer = Layer.provideMerge(memoryStoreLayer, BunCrypto.layer);

/**
 * Build a wire-backed `ProdigyAgent` context and its service. The caller
 * supplies an agent layer whose only remaining requirement is the
 * `LanguageModel`; this helper spins the mock server and points an
 * openai-compatible provider at it.
 */
export const buildWireContext = <E>(
  turns: ReadonlyArray<ReadonlyArray<MockLLMPart>>,
  agentLayer: Layer.Layer<ProdigyAgent | SessionStore, E, LanguageModel.LanguageModel>
): Effect.Effect<
  {
    readonly server: MockLLMServer;
    readonly context: Context.Context<ProdigyAgent | SessionStore>;
    readonly agent: ProdigyAgent["Service"];
  },
  E,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const server = yield* createMockLLMServer(turns);
    const providerLayer = openaiCompatProviderLayer(server.url);
    const fullLayer = Layer.provideMerge(Layer.provideMerge(agentLayer, providerLayer), FetchHttpClient.layer);
    const context = yield* Layer.build(fullLayer);
    const agent = yield* ProdigyAgent.pipe(Effect.provide(context));
    return { server, context, agent };
  });

/**
 * Run `ProdigyAgent` end-to-end against the wire-level mock LLM server.
 * Returns the collected events, the server (for `server.calls`), and the
 * built context (so tests can read services like the `SessionStore`).
 */
export const runWithWireServer = <E>(
  turns: ReadonlyArray<ReadonlyArray<MockLLMPart>>,
  agentLayer: Layer.Layer<ProdigyAgent | SessionStore, E, LanguageModel.LanguageModel>,
  prompt: string
): Effect.Effect<
  {
    readonly events: ReadonlyArray<AgentEvent>;
    readonly server: MockLLMServer;
    readonly context: Context.Context<ProdigyAgent | SessionStore>;
  },
  E | AgentError,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const { server, context, agent } = yield* buildWireContext(turns, agentLayer);
    const events = yield* agent.run({ prompt }).pipe(Stream.runCollect);
    return { events: Array.from(events), server, context };
  });
