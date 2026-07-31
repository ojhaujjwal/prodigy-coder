import { expect, layer } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, Layer, Option, Queue } from "effect";
import * as Terminal from "effect/Terminal";
import { ApprovalPrompt, makeApprovalPromptLayer } from "./approval-prompt.ts";

const makeMockTerminalLayer = (input: Terminal.UserInput): Layer.Layer<Terminal.Terminal> =>
  Layer.effect(
    Terminal.Terminal,
    Effect.gen(function* () {
      const queue = yield* Queue.make<Terminal.UserInput>();
      yield* Queue.offer(queue, input);
      return Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        display: () => Effect.void,
        readInput: Effect.succeed(Queue.asDequeue(queue)),
        readLine: Effect.succeed("")
      });
    })
  );

const yesInput: Terminal.UserInput = {
  input: Option.some("y"),
  key: { name: "y", ctrl: false, meta: false, shift: false }
};

const testLayer = makeApprovalPromptLayer().pipe(
  Layer.provideMerge(Layer.merge(BunServices.layer, makeMockTerminalLayer(yesInput)))
);

layer(testLayer)("approval-prompt", (it) => {
  it.effect("returns the user's confirmation", () =>
    Effect.gen(function* () {
      const prompt = yield* ApprovalPrompt;
      const result = yield* prompt.confirm("Allow tool?");
      expect(result).toBe(true);
    })
  );
});
