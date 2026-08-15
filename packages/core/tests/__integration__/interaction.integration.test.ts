import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HumanInteraction, HumanInteractionError } from "../../src/capabilities/human-interaction.ts";
import { SessionStore } from "../../src/capabilities/session-store.ts";
import { makeProdigyAgentLayer, ProdigyAgent } from "../../src/agent/prodigy-agent.ts";
import { PositiveInt, type AgentProfile } from "../../src/agent/agent-profile.ts";
import type { AgentError } from "../../src/agent/agent-error.ts";
import {
  ApprovalToolkit,
  approvalProfile,
  echoProfile,
  scriptedEchoToolkit,
  scriptedInteractionLayer,
  scriptedToolModelLayer,
  finishPart
} from "./agent-helpers.ts";
import { finish, runWithWireServer, storeLayer } from "./wire-run.ts";

const approvedToolkitLayer = ApprovalToolkit.toLayer({
  "approval-gated": (input: { value: string }) => Effect.succeed({ value: `ran:${input.value}` })
});

describe("ProdigyAgent interaction approval", () => {
  it.effect("emits interaction-requested, resumes after approval, and persists the transcript", () =>
    Effect.gen(function* () {
      const interaction = scriptedInteractionLayer([{ _tag: "Approved" }]);
      const agentLayer = Layer.provideMerge(
        Layer.provideMerge(
          Layer.provideMerge(makeProdigyAgentLayer(approvalProfile(approvedToolkitLayer)), storeLayer),
          approvedToolkitLayer
        ),
        interaction.layer
      );
      const { events, context } = yield* runWithWireServer(
        [
          [
            { type: "tool-call", id: "call-approve", name: "approval-gated", params: { value: "run it" } },
            finish("tool-calls")
          ],
          [{ type: "text-delta", delta: "approved!" }, finish("stop")]
        ],
        agentLayer,
        "Approve the tool"
      );

      expect(events.map((e) => e.type)).toEqual([
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

      const started = events[0];
      if (started.type !== "run-started") throw new Error("expected run-started");
      const store = Context.get(context, SessionStore);
      const snapshot = yield* store.load(started.sessionId);
      const assistantMessage = snapshot.session.messages.find(
        (m) => m.role === "assistant" && Array.isArray(m.content)
      );
      expect(assistantMessage).toMatchObject({
        role: "assistant",
        content: [{ type: "tool-call", id: "call-approve", name: "approval-gated" }, { type: "tool-approval-request" }]
      });
      const toolMessage = snapshot.session.messages.find((m) => m.role === "tool");
      expect(toolMessage).toMatchObject({
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: expect.any(String), approved: true }]
      });
    })
  );

  it.effect("a denied approval is a failed tool result, not a run failure", () =>
    Effect.gen(function* () {
      const interaction = scriptedInteractionLayer([{ _tag: "Denied", reason: "Not now" }]);
      const agentLayer = Layer.provideMerge(
        Layer.provideMerge(
          Layer.provideMerge(makeProdigyAgentLayer(approvalProfile(approvedToolkitLayer)), storeLayer),
          approvedToolkitLayer
        ),
        interaction.layer
      );
      const { events } = yield* runWithWireServer(
        [
          [
            { type: "tool-call", id: "call-deny", name: "approval-gated", params: { value: "risky" } },
            finish("tool-calls")
          ],
          [{ type: "text-delta", delta: "denied, recovering" }, finish("stop")]
        ],
        agentLayer,
        "Do the risky thing"
      );

      const toolResult = events.find((e) => e.type === "tool-result");
      expect(toolResult).toMatchObject({
        type: "tool-result",
        callId: "call-deny",
        toolName: "approval-gated",
        outcome: { _tag: "Failed" }
      });
      expect(events.some((e) => e.type === "text-delta" && e.delta === "denied, recovering")).toBe(true);
      const ended = events[events.length - 1];
      if (ended.type !== "run-ended") throw new Error("expected run-ended");
      expect(ended.result._tag).toBe("Finished");
    })
  );

  it.effect("a HumanInteractionError fails the run with InteractionCapabilityError", () =>
    Effect.gen(function* () {
      const failingInteractionLayer = Layer.succeed(
        HumanInteraction,
        HumanInteraction.of({
          request: () => Effect.fail(new HumanInteractionError({ reason: "ChannelClosed" }))
        })
      );
      const agentLayer = Layer.provideMerge(
        Layer.provideMerge(
          Layer.provideMerge(
            Layer.provideMerge(makeProdigyAgentLayer(approvalProfile(approvedToolkitLayer)), storeLayer),
            scriptedToolModelLayer([
              [
                { type: "tool-call", id: "call-fail", name: "approval-gated", params: { value: "x" } },
                finishPart("tool-calls")
              ]
            ])
          ),
          approvedToolkitLayer
        ),
        failingInteractionLayer
      );

      const context = yield* Layer.build(agentLayer);
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));
      const failure: AgentError = yield* agent.run({ prompt: "Do it" }).pipe(Stream.runCollect, Effect.flip);

      expect(failure._tag).toBe("InteractionCapabilityError");
      if (failure._tag === "InteractionCapabilityError") {
        expect(failure.reason).toBe("ChannelClosed");
      }
    })
  );

  it.effect("correlates two approval requests in one turn to their own responses", () =>
    Effect.gen(function* () {
      const interaction = scriptedInteractionLayer([{ _tag: "Approved" }, { _tag: "Denied", reason: "nope" }]);
      const agentLayer = Layer.provideMerge(
        Layer.provideMerge(
          Layer.provideMerge(makeProdigyAgentLayer(approvalProfile(approvedToolkitLayer)), storeLayer),
          approvedToolkitLayer
        ),
        interaction.layer
      );
      const { events } = yield* runWithWireServer(
        [
          [
            { type: "tool-call", id: "call-1", name: "approval-gated", params: { value: "first" } },
            { type: "tool-call", id: "call-2", name: "approval-gated", params: { value: "second" } },
            finish("tool-calls")
          ],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        agentLayer,
        "Do both"
      );

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

  it.effect("a toolkit with no interaction-requiring tools emits no interaction-requested", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const { events } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "call-echo", name: "echo", params: { value: "hi" } }, finish("tool-calls")],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        Layer.provideMerge(
          Layer.provideMerge(makeProdigyAgentLayer(echoProfile(toolkit.layer)), storeLayer),
          toolkit.layer
        ),
        "Echo hi"
      );

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

  it.effect("fails at composition when an approval-gated tool lacks HumanInteraction (R6a)", () =>
    Effect.gen(function* () {
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

      const failure = yield* Layer.build(
        Layer.provideMerge(
          Layer.provideMerge(makeProdigyAgentLayer(noChannelProfile), storeLayer),
          scriptedToolModelLayer([
            [
              { type: "tool-call", id: "call-nc", name: "approval-no-channel", params: { value: "x" } },
              finishPart("tool-calls")
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

  it.effect("fails typed at runtime when a provider emits approval without a channel (R6b)", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const agentLayer = Layer.provideMerge(
        Layer.provideMerge(
          Layer.provideMerge(makeProdigyAgentLayer(echoProfile(toolkit.layer)), storeLayer),
          scriptedToolModelLayer([
            [
              { type: "tool-call", id: "call-x", name: "echo", params: { value: "hi" } },
              { type: "tool-approval-request", approvalId: "a1", toolCallId: "call-x" },
              finishPart("tool-calls")
            ]
          ])
        ),
        toolkit.layer
      );

      const context = yield* Layer.build(agentLayer);
      const agent = yield* ProdigyAgent.pipe(Effect.provide(context));
      const failure: AgentError = yield* agent.run({ prompt: "Run it" }).pipe(Stream.runCollect, Effect.flip);

      expect(failure._tag).toBe("ToolSystemError");
      if (failure._tag === "ToolSystemError") {
        expect(failure.reason).toBe("ToolkitMisconfiguration");
      }
    })
  );
});
