import { Context, Effect, Layer, Schema, Stream } from "effect";
import { expect, layer } from "@effect/vitest";
import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import { Tool, Toolkit } from "effect/unstable/ai";
import { layerNoDeps as memoryStoreLayer } from "../../capabilities/memory-session-store.ts";
import { ProdigyAgent, makeProdigyAgentLayer } from "../prodigy-agent.ts";
import { EchoToolkit, scriptedEchoToolkit, scriptedToolModelLayer } from "./helpers.ts";
import type { AgentEvent } from "../agent-event.ts";
import type { AgentProfile } from "../agent-profile.ts";

const finish = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  reason,
  usage: {
    inputTokens: { uncached: 1, total: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 1, text: 1, reasoning: undefined }
  },
  response: undefined
});

// ---------------------------------------------------------------------------
// A custom tool: `sum` with its own handler Layer backed by a caller-provided
// authority (a `Calculator` service). This is the "remote tool" pattern — the
// tool definition is ordinary; its handler delegates to the authority.
// ---------------------------------------------------------------------------

class Calculator extends Context.Service<
  Calculator,
  { readonly add: (a: number, b: number) => Effect.Effect<number> }
>()("@prodigy/core/agent/__integration__/custom-toolkit.integration.test/Calculator") {}

const calculatorLayer = Layer.succeed(
  Calculator,
  Calculator.of({ add: (a: number, b: number) => Effect.succeed(a + b) })
);

// ---------------------------------------------------------------------------
// Same-name replacement: redefine `sum` with a completely new schema,
// description, result shape, and handler. Later definitions own execution.
// ---------------------------------------------------------------------------

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

// The merged toolkit: the echo toolkit plus the custom `sum` (which the later
// replaced definition owns). `Toolkit.merge` composes definitions; the
// handler Layer is composed with `Layer.merge` (later definitions own
// same-name execution).
const echoToolkit = scriptedEchoToolkit();

const mergedToolkit = Toolkit.merge(EchoToolkit, replacedToolkit);

const mergedProfile: AgentProfile<typeof mergedToolkit.tools> = {
  toolkit: mergedToolkit,
  toolkitHandlerLayer: Layer.merge(echoToolkit.layer, replacedToolkitLayer),
  systemPrompt: "",
  maxTurns: 50
};

const storeLayer = Layer.provideMerge(memoryStoreLayer, BunCrypto.layer);

layer(
  Layer.provideMerge(
    Layer.provideMerge(
      Layer.provideMerge(makeProdigyAgentLayer(mergedProfile), storeLayer),
      scriptedToolModelLayer([
        [{ type: "tool-call", id: "c1", name: "sum", params: { a: 2, b: 3 } }, finish("tool-calls")],
        [{ type: "text-delta", id: "t", delta: "done" }, finish("stop")]
      ])
    ),
    calculatorLayer
  )
)("Custom and remote toolkit composition", (it) => {
  it.effect("a replaced same-name tool uses its complete new definition and handler", () =>
    Effect.gen(function* () {
      const agent = yield* ProdigyAgent;
      const events: ReadonlyArray<AgentEvent> = yield* agent.run({ prompt: "Sum" }).pipe(Stream.runCollect);

      const call = events.find((e) => e.type === "tool-call" && e.toolName === "sum");
      expect(call).toMatchObject({ toolName: "sum", input: { a: 2, b: 3 } });

      const result = events.find((e) => e.type === "tool-result" && e.toolName === "sum");
      // The replacement handler returns a string (its new success schema), not
      // the original numeric result — proving the complete definition replaced.
      expect(result).toMatchObject({ outcome: { _tag: "Success", output: "replaced:5" } });
      expect(events.at(-1)?.type).toBe("run-ended");
    })
  );
});
