import { expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { PositiveInt, type AgentProfile } from "./agent-profile.ts";
import { resolveAgentProfile } from "./profile-resolution.ts";

const EchoTool = Tool.make("echo", {
  description: "Echo a value",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
  failureMode: "return"
});

const EchoToolkit = Toolkit.make(EchoTool);

it.effect("resolves and closes over the profile handler Layer", () => {
  const calls: Array<string> = [];
  const profile: AgentProfile<typeof EchoToolkit.tools> = {
    toolkit: EchoToolkit,
    toolkitHandlerLayer: EchoToolkit.toLayer({
      echo: ({ value }) =>
        Effect.sync(() => {
          calls.push(value);
          return { value };
        })
    }),
    systemPrompt: "system",
    maxTurns: PositiveInt.make(2)
  };

  return Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* resolveAgentProfile(profile);
      const result = yield* resolved.toolkit.handle("echo", { value: "hello" });
      yield* Stream.runCollect(result);

      expect(calls).toEqual(["hello"]);
      expect(resolved.systemPrompt).toBe("system");
      expect(resolved.maxTurns).toBe(2);
    })
  );
});
