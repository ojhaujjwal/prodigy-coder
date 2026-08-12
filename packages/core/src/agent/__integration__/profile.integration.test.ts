import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { ProdigyAgent, makeProdigyAgentLayer } from "../prodigy-agent.ts";
import {
  ApprovalToolkit,
  approvalProfile,
  echoProfile,
  scriptedEchoToolkit,
  scriptedInteractionLayer,
  scriptedToolModelLayer,
  textProfile
} from "./helpers.ts";

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  reason,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
});

const storeLayer = Layer.provideMerge(memoryStoreLayer, BunCrypto.layer);

layer(
  Layer.provideMerge(
    Layer.provideMerge(makeProdigyAgentLayer(textProfile()), storeLayer),
    scriptedToolModelLayer([[{ type: "text-delta", id: "t1", delta: "hi" }, finish("stop")]])
  )
)("AgentProfile with no authorities", (it) => {
  it.effect("runs without a HumanInteraction layer and finishes", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events = yield* agent.run({ prompt: "Hello" }).pipe(Stream.runCollect);
      expect(events.some((e) => e.type === "run-ended")).toBe(true);
    })
  );
});

const echoToolkit = scriptedEchoToolkit();

layer(
  Layer.provideMerge(
    Layer.provideMerge(makeProdigyAgentLayer(echoProfile(echoToolkit.layer)), storeLayer),
    scriptedToolModelLayer([
      [{ type: "tool-call", id: "c1", name: "echo", params: { value: "x" } }, finish("tool-calls")],
      [{ type: "text-delta", id: "t2", delta: "done" }, finish("stop")]
    ])
  )
)("AgentProfile with a tool handler Layer", (it) => {
  it.effect("executes the tool through the profile's handler Layer", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events = yield* agent.run({ prompt: "Echo" }).pipe(Stream.runCollect);
      expect(echoToolkit.calls).toEqual([{ value: "x" }]);
      expect(events.some((e) => e.type === "tool-result")).toBe(true);
    })
  );
});

const approvedToolkitLayer = ApprovalToolkit.toLayer({
  "approval-gated": () => Effect.succeed({ value: "approved" })
});
const interaction = scriptedInteractionLayer([{ _tag: "Approved" }]);

layer(
  Layer.provideMerge(
    Layer.provideMerge(makeProdigyAgentLayer(approvalProfile(approvedToolkitLayer)), storeLayer),
    Layer.provideMerge(
      scriptedToolModelLayer([
        [{ type: "tool-call", id: "c1", name: "approval-gated", params: { value: "y" } }, finish("tool-calls")],
        [{ type: "text-delta", id: "t3", delta: "done" }, finish("stop")]
      ]),
      interaction.layer
    )
  )
)("AgentProfile with HumanInteraction authority", (it) => {
  it.effect("declares HumanInteraction and resolves approvals through it", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events = yield* agent.run({ prompt: "Approve" }).pipe(Stream.runCollect);
      expect(events.some((e) => e.type === "interaction-requested")).toBe(true);
      expect(interaction.requests).toHaveLength(1);
    })
  );
});
