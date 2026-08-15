import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { makeProdigyAgentLayer } from "../../src/agent/prodigy-agent.ts";
import { PositiveInt, type AgentProfile } from "../../src/agent/agent-profile.ts";
import { EchoToolkit, echoProfile, scriptedEchoToolkit, textProfile } from "./agent-helpers.ts";
import { finish, runWithWireServer, storeLayer } from "./wire-run.ts";

const echoRunLayer = (toolkit: ReturnType<typeof scriptedEchoToolkit>) =>
  Layer.provideMerge(Layer.provideMerge(makeProdigyAgentLayer(echoProfile(toolkit.layer)), storeLayer), toolkit.layer);

describe("AgentProfile composition", () => {
  it.effect("a text-only profile runs without a HumanInteraction layer", () =>
    Effect.gen(function* () {
      const { events } = yield* runWithWireServer(
        [[{ type: "text-delta", delta: "hi" }, finish("stop")]],
        Layer.provideMerge(makeProdigyAgentLayer(textProfile()), storeLayer),
        "Hello"
      );
      expect(events.some((e) => e.type === "run-ended")).toBe(true);
    })
  );

  it.effect("an echo profile executes its tool through the handler Layer", () =>
    Effect.gen(function* () {
      const toolkit = scriptedEchoToolkit();
      const { events } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "c1", name: "echo", params: { value: "x" } }, finish("tool-calls")],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        echoRunLayer(toolkit),
        "Echo"
      );
      expect(toolkit.calls).toEqual([{ value: "x" }]);
      expect(events.some((e) => e.type === "tool-result")).toBe(true);
    })
  );

  it.effect("a same-name replaced tool uses its complete new definition and handler", () =>
    Effect.gen(function* () {
      const ReplacedSumTool = Tool.make("sum", {
        description: "Replaced sum: returns a string",
        parameters: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
        success: Schema.String,
        failureMode: "return"
      });
      const replacedToolkit = Toolkit.make(ReplacedSumTool);
      const replacedToolkitLayer = replacedToolkit.toLayer({
        sum: ({ a, b }) => Effect.succeed(`replaced:${a + b}`)
      });
      const echoToolkit = scriptedEchoToolkit();
      const mergedToolkit = Toolkit.merge(EchoToolkit, replacedToolkit);
      const mergedProfile: AgentProfile<typeof mergedToolkit.tools> = {
        toolkit: mergedToolkit,
        toolkitHandlerLayer: Layer.merge(echoToolkit.layer, replacedToolkitLayer),
        systemPrompt: "",
        maxTurns: PositiveInt.make(50)
      };

      const { events } = yield* runWithWireServer(
        [
          [{ type: "tool-call", id: "c1", name: "sum", params: { a: 2, b: 3 } }, finish("tool-calls")],
          [{ type: "text-delta", delta: "done" }, finish("stop")]
        ],
        Layer.provideMerge(makeProdigyAgentLayer(mergedProfile), storeLayer),
        "Sum"
      );

      const result = events.find((e) => e.type === "tool-result" && e.toolName === "sum");
      expect(result).toMatchObject({ outcome: { _tag: "Success", output: "replaced:5" } });
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );
});
