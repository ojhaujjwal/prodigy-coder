import { describe, it, expect } from "@effect/vitest";
import { Effect, Layer, Queue } from "effect";
import { BunServices } from "@effect/platform-bun";
import * as Terminal from "effect/Terminal";
import * as Option from "effect/Option";
import * as AiError from "effect/unstable/ai/AiError";
import { Toolkit } from "effect/unstable/ai";
import { makeAskUserHandler, AskUserTool } from "./askUser.ts";

const makeMockTerminalLayer = (inputs: Terminal.UserInput[]): Layer.Layer<Terminal.Terminal> =>
  Layer.effect(
    Terminal.Terminal,
    Effect.gen(function* () {
      const queue = yield* Queue.make<Terminal.UserInput>();
      for (const input of inputs) {
        yield* Queue.offer(queue, input);
      }
      return Terminal.make({
        columns: Effect.succeed(80),
        display: () => Effect.void,
        readInput: Effect.succeed(Queue.asDequeue(queue)),
        readLine: Effect.succeed("")
      });
    })
  );

const toUserInput = (key: string): Terminal.UserInput => ({
  input: Option.some(key),
  key: { name: key, ctrl: false, meta: false, shift: false }
});

const enterInput: Terminal.UserInput = {
  input: Option.some("enter"),
  key: { name: "enter", ctrl: false, meta: false, shift: false }
};

const dummyContext: Toolkit.HandlerContext<typeof AskUserTool> = {
  preliminary: () => Effect.void
};

describe("askUser tool", () => {
  it.effect("handler returns user input when Terminal is available", () =>
    Effect.gen(function* () {
      // oxlint-disable-next-line prodigy/no-process
      const stdin = globalThis.process.stdin;
      const originalIsTTY: boolean | undefined = stdin.isTTY;
      stdin.isTTY = true;

      const handler = makeAskUserHandler(false);
      const result = yield* handler({ question: "What is your name?" }, dummyContext);
      expect(result).toBe("Alice");

      stdin.isTTY = originalIsTTY;
    }).pipe(
      Effect.provide(
        Layer.merge(
          BunServices.layer,
          makeMockTerminalLayer([
            toUserInput("A"),
            toUserInput("l"),
            toUserInput("i"),
            toUserInput("c"),
            toUserInput("e"),
            enterInput
          ])
        )
      )
    )
  );

  it.effect("handler fails with error in non-interactive mode", () =>
    Effect.gen(function* () {
      const handler = makeAskUserHandler(true);
      const result = yield* handler({ question: "What is your name?" }, dummyContext).pipe(Effect.flip);
      expect(result._tag).toBe("AiError");
      expect(result.reason._tag).toBe("UnknownError");
      if (result.reason instanceof AiError.UnknownError) {
        expect(result.reason.description).toContain("non-interactive mode");
      }
    }).pipe(Effect.provide(BunServices.layer))
  );
});
