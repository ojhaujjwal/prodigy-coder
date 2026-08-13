import { expect, it, layer } from "@effect/vitest";
import { Effect, Layer, Schema, Stream } from "effect";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { SessionStore } from "../../capabilities/session-store.ts";
import { HumanInteraction, HumanInteractionError } from "../../capabilities/human-interaction.ts";
import { makeProdigyAgentLayer as makeAgentLayer, ProdigyAgent } from "../prodigy-agent.ts";
import type { AgentError } from "../agent-error.ts";
import type { AgentEvent } from "../agent-event.ts";
import { PositiveInt, type AgentProfile } from "../agent-profile.ts";
import { Tool, Toolkit } from "effect/unstable/ai";
import {
  ApprovalToolkit,
  approvalProfile,
  echoProfile,
  scriptedEchoToolkit,
  scriptedInteractionLayer,
  scriptedToolModelLayer
} from "./helpers.ts";
import type { Response } from "effect/unstable/ai";

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  reason,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
});

const approvedToolkitLayer = ApprovalToolkit.toLayer({
  "approval-gated": (input: { value: string }) => Effect.succeed({ value: `ran:${input.value}` })
});

const makeApprovalRunLayer = (
  turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>,
  interaction: ReturnType<typeof scriptedInteractionLayer>
) =>
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.provideMerge(
        Layer.provideMerge(
          makeAgentLayer(approvalProfile(approvedToolkitLayer)),
          Layer.provideMerge(memoryStoreLayer, BunCrypto.layer)
        ),
        scriptedToolModelLayer(turns)
      ),
      approvedToolkitLayer
    ),
    interaction.layer
  );

const approvedTurns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>> = [
  [
    { type: "tool-call", id: "call-approve", name: "approval-gated", params: { value: "run it" } },
    finish("tool-calls")
  ],
  [{ type: "text-delta", id: "text-1", delta: "approved!" }, finish("stop")]
];

layer(makeApprovalRunLayer(approvedTurns, scriptedInteractionLayer([{ _tag: "Approved" }])))(
  "ProdigyAgent interaction approval (R1)",
  (it) => {
    it.effect("emits interaction-requested before the wait, then resumes with the approved tool result", () =>
      Effect.gen(function* () {
        const agent = yield* ProdigyAgent;
        const events: ReadonlyArray<AgentEvent> = yield* agent
          .run({ prompt: "Approve the tool" })
          .pipe(Stream.runCollect);

        expect(events.map((event) => event.type)).toEqual([
          "run-started",
          "turn-started",
          "tool-call",
          "interaction-requested",
          "turn-started",
          "tool-result",
          "text-delta",
          "run-ended"
        ]);

        const interactionRequested = events.find((e) => e.type === "interaction-requested");
        expect(interactionRequested).toEqual({
          type: "interaction-requested",
          request: { toolName: "approval-gated", callId: "call-approve", input: { value: "run it" } }
        });

        const toolResult = events.find((e) => e.type === "tool-result");
        expect(toolResult).toEqual({
          type: "tool-result",
          callId: "call-approve",
          toolName: "approval-gated",
          outcome: { _tag: "Success", output: { value: "ran:run it" } }
        });

        // The transcript must carry the native approval request/response pair
        // so a resumed run can re-resolve it through Effect AI's protocol.
        const started = events[0];
        if (started.type !== "run-started") throw new Error("expected run-started");
        const store = yield* SessionStore;
        const snapshot = yield* store.load(started.sessionId);
        const assistantMessage = snapshot.session.messages.find(
          (m) => m.role === "assistant" && Array.isArray(m.content)
        );
        expect(assistantMessage).toMatchObject({
          role: "assistant",
          content: [
            { type: "tool-call", id: "call-approve", name: "approval-gated" },
            { type: "tool-approval-request" }
          ]
        });
        const toolMessage = snapshot.session.messages.find((m) => m.role === "tool");
        expect(toolMessage).toMatchObject({
          role: "tool",
          content: [{ type: "tool-approval-response", approvalId: expect.any(String), approved: true }]
        });
      })
    );
  }
);

/**
 * R2: denial is recoverable. The `HumanInteraction` denies the request; the
 * next `streamText` injects an `execution-denied` failure result, which the
 * loop projects as a model-visible `Failed` tool result. The run continues and
 * finishes normally — no stream failure.
 */
const deniedTurns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>> = [
  [{ type: "tool-call", id: "call-deny", name: "approval-gated", params: { value: "risky" } }, finish("tool-calls")],
  [{ type: "text-delta", id: "text-2", delta: "denied, recovering" }, finish("stop")]
];

layer(makeApprovalRunLayer(deniedTurns, scriptedInteractionLayer([{ _tag: "Denied", reason: "Not now" }])))(
  "ProdigyAgent interaction denial (R2)",
  (it) => {
    it.effect("a denied approval is a failed tool result, not a run failure", () =>
      Effect.gen(function* () {
        const agent = yield* ProdigyAgent;
        const events: ReadonlyArray<AgentEvent> = yield* agent
          .run({ prompt: "Do the risky thing" })
          .pipe(Stream.runCollect);

        const interactionRequested = events.find((e) => e.type === "interaction-requested");
        expect(interactionRequested).toEqual({
          type: "interaction-requested",
          request: { toolName: "approval-gated", callId: "call-deny", input: { value: "risky" } }
        });

        const toolResult = events.find((e) => e.type === "tool-result");
        expect(toolResult).toMatchObject({
          type: "tool-result",
          callId: "call-deny",
          toolName: "approval-gated",
          outcome: { _tag: "Failed" }
        });

        // The run continues past the denial and finishes normally.
        expect(events.some((e) => e.type === "text-delta" && e.delta === "denied, recovering")).toBe(true);
        const ended = events[events.length - 1];
        expect(ended.type).toBe("run-ended");
        if (ended.type === "run-ended") {
          expect(ended.result._tag).toBe("Finished");
        }
      })
    );
  }
);

/**
 * R3: a toolkit with no interaction-requiring tools has no `HumanInteraction`
 * requirement and emits no `interaction-requested` events. The run proceeds
 * normally. The echo toolkit layer is used, and no `HumanInteraction` layer is
 * provided — the composition still type-checks because the agent layer's
 * requirements are only the echo handler services.
 */
const echoTurns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>> = [
  [{ type: "tool-call", id: "call-echo", name: "echo", params: { value: "hi" } }, finish("tool-calls")],
  [{ type: "text-delta", id: "text-3", delta: "done" }, finish("stop")]
];

layer(
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.provideMerge(
        makeAgentLayer(echoProfile(scriptedEchoToolkit().layer)),
        Layer.provideMerge(memoryStoreLayer, BunCrypto.layer)
      ),
      scriptedToolModelLayer(echoTurns)
    ),
    scriptedEchoToolkit().layer
  )
)("ProdigyAgent no-interaction toolkit (R3)", (it) => {
  it.effect("emits no interaction-requested and runs normally without a HumanInteraction layer", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events: ReadonlyArray<AgentEvent> = yield* agent.run({ prompt: "Echo hi" }).pipe(Stream.runCollect);

      expect(events.some((e) => e.type === "interaction-requested")).toBe(false);
      expect(events.map((e) => e.type)).toEqual([
        "run-started",
        "turn-started",
        "tool-call",
        "tool-result",
        "turn-started",
        "text-delta",
        "run-ended"
      ]);
    })
  );
});

/**
 * R4: correlation/ordering. Two approval-gated tool calls in one turn produce
 * two `interaction-requested` events, each resolved by its own scripted
 * response (first approved, second denied). Each request precedes its
 * resolution: the first tool executes, the second is denied as a failure.
 */
const twoApprovalsTurns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>> = [
  [
    { type: "tool-call", id: "call-1", name: "approval-gated", params: { value: "first" } },
    { type: "tool-call", id: "call-2", name: "approval-gated", params: { value: "second" } },
    finish("tool-calls")
  ],
  [{ type: "text-delta", id: "text-4", delta: "done" }, finish("stop")]
];

layer(
  makeApprovalRunLayer(
    twoApprovalsTurns,
    scriptedInteractionLayer([{ _tag: "Approved" }, { _tag: "Denied", reason: "nope" }])
  )
)("ProdigyAgent interaction correlation (R4)", (it) => {
  it.effect("each interaction-requested precedes and correlates to its own response", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events: ReadonlyArray<AgentEvent> = yield* agent.run({ prompt: "Do both" }).pipe(Stream.runCollect);

      const requests = events.filter((e) => e.type === "interaction-requested");
      expect(requests).toEqual([
        {
          type: "interaction-requested",
          request: { toolName: "approval-gated", callId: "call-1", input: { value: "first" } }
        },
        {
          type: "interaction-requested",
          request: { toolName: "approval-gated", callId: "call-2", input: { value: "second" } }
        }
      ]);

      // Both requests precede the turn that resolves them.
      const firstRequestIndex = events.indexOf(requests[0]);
      const secondRequestIndex = events.indexOf(requests[1]);
      const firstResultIndex = events.findIndex((e) => e.type === "tool-result" && e.callId === "call-1");
      const secondResultIndex = events.findIndex((e) => e.type === "tool-result" && e.callId === "call-2");
      expect(firstRequestIndex).toBeLessThan(secondRequestIndex);
      expect(firstRequestIndex).toBeLessThan(firstResultIndex);
      expect(secondRequestIndex).toBeLessThan(secondResultIndex);

      const firstResult = events.find((e) => e.type === "tool-result" && e.callId === "call-1");
      expect(firstResult).toMatchObject({ outcome: { _tag: "Success" } });
      const secondResult = events.find((e) => e.type === "tool-result" && e.callId === "call-2");
      expect(secondResult).toMatchObject({ outcome: { _tag: "Failed" } });
    })
  );
});

/**
 * R5: capability failure. A `HumanInteractionError` (e.g. a closed channel)
 * fails the run with the typed `InteractionCapabilityError` — it is not a
 * denial and not a model-visible tool failure.
 */
const failingInteractionLayer = Layer.succeed(
  HumanInteraction,
  HumanInteraction.of({
    request: () => Effect.fail(new HumanInteractionError({ reason: "ChannelClosed" }))
  })
);

layer(
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.provideMerge(
        Layer.provideMerge(
          makeAgentLayer(approvalProfile(approvedToolkitLayer)),
          Layer.provideMerge(memoryStoreLayer, BunCrypto.layer)
        ),
        scriptedToolModelLayer([
          [{ type: "tool-call", id: "call-fail", name: "approval-gated", params: { value: "x" } }, finish("tool-calls")]
        ])
      ),
      approvedToolkitLayer
    ),
    failingInteractionLayer
  )
)("ProdigyAgent interaction capability failure (R5)", (it) => {
  it.effect("a HumanInteractionError fails the run with InteractionCapabilityError", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const failure: AgentError = yield* agent.run({ prompt: "Do it" }).pipe(Stream.runCollect, Effect.flip);

      expect(failure._tag).toBe("InteractionCapabilityError");
      if (failure._tag === "InteractionCapabilityError") {
        expect(failure.reason).toBe("ChannelClosed");
      }
    })
  );
});

/**
 * R6: an approval-gated tool that does NOT declare `HumanInteraction` as a
 * dependency is a toolkit misconfiguration. Effect AI emits the native
 * `tool-approval-request` part for any tool with `needsApproval` (approval is
 * gated by that option alone, independent of `dependencies`), so the type
 * system cannot see the hole. Profile resolution closes it:
 * the layer fails at build time with the typed
 * `ToolSystemError`/`toolkit-misconfiguration` — never an untyped runtime
 * exception.
 */
const ApprovalWithoutChannelTool = Tool.make("approval-no-channel", {
  description: "A tool that requires approval but declares no HumanInteraction dependency",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
  failureMode: "return",
  needsApproval: true
});

const ApprovalWithoutChannelToolkit = Toolkit.make(ApprovalWithoutChannelTool);

const noChannelProfile: AgentProfile<typeof ApprovalWithoutChannelToolkit.tools> = {
  toolkit: ApprovalWithoutChannelToolkit,
  toolkitHandlerLayer: ApprovalWithoutChannelToolkit.toLayer({
    "approval-no-channel": () => Effect.succeed({ value: "ran" })
  }),
  systemPrompt: "",
  maxTurns: PositiveInt.make(50)
};

it.effect("fails at composition when an approval-gated tool lacks HumanInteraction (R6a)", () =>
  Effect.gen(function* () {
    const failure = yield* Layer.build(
      Layer.provideMerge(
        Layer.provideMerge(makeAgentLayer(noChannelProfile), Layer.provideMerge(memoryStoreLayer, BunCrypto.layer)),
        scriptedToolModelLayer([
          [
            { type: "tool-call", id: "call-nc", name: "approval-no-channel", params: { value: "x" } },
            finish("tool-calls")
          ]
        ])
      )
    ).pipe(Effect.flip);

    expect(failure._tag).toBe("ToolSystemError");
    if (failure._tag === "ToolSystemError") {
      expect(failure.reason).toBe("ToolkitMisconfiguration");
    }
  })
);

/**
 * R6b: the runtime fallback — a provider stream can emit a raw
 * `tool-approval-request` part even when no tool declares `needsApproval`
 * (the guard passes at composition, since the echo tool is not
 * approval-gated). Without a `HumanInteraction` channel the run must fail
 * with the typed `ToolSystemError`/`toolkit-misconfiguration`, never an
 * untyped exception.
 */
layer(
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.provideMerge(
        makeAgentLayer(echoProfile(scriptedEchoToolkit().layer)),
        Layer.provideMerge(memoryStoreLayer, BunCrypto.layer)
      ),
      scriptedToolModelLayer([
        [
          { type: "tool-call", id: "call-x", name: "echo", params: { value: "hi" } },
          { type: "tool-approval-request", approvalId: "a1", toolCallId: "call-x" },
          finish("tool-calls")
        ]
      ])
    ),
    scriptedEchoToolkit().layer
  )
)("ProdigyAgent provider-emitted approval without a channel (R6b)", (it) => {
  it.effect("fails typed at runtime with ToolSystemError/toolkit-misconfiguration", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const failure: AgentError = yield* agent.run({ prompt: "Run it" }).pipe(Stream.runCollect, Effect.flip);

      expect(failure._tag).toBe("ToolSystemError");
      if (failure._tag === "ToolSystemError") {
        expect(failure.reason).toBe("ToolkitMisconfiguration");
      }
    })
  );
});
