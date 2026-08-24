import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Layer, Queue } from "effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Terminal from "effect/Terminal";
import { HumanInteraction } from "@prodigy/core";
import type { InteractionResponse } from "@prodigy/core";
import { makeHumanInteractionLayer } from "./human-interaction.ts";

/**
 * A terminal whose input has already ended (EOF, piped stdin, quit).
 * `Prompt.run` maps any input failure to `QuitError`, which is exactly the
 * channel-closed condition the adapter must degrade from.
 */
const endedInputTerminal = Effect.gen(function* () {
  const queue = yield* Queue.bounded<Terminal.UserInput, Cause.Done>(1);
  yield* Queue.end(queue);
  return Terminal.make({
    columns: Effect.succeed(80),
    rows: Effect.succeed(24),
    readInput: Effect.succeed(Queue.asDequeue(queue)),
    readLine: Effect.fail(new Terminal.QuitError({})),
    display: () => Effect.void
  });
});

const promptEnvLayer = Layer.mergeAll(
  Layer.effect(Terminal.Terminal, endedInputTerminal),
  Path.layer,
  FileSystem.layerNoop({})
);

const interactionWith = (nonInteractive: boolean) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(makeHumanInteractionLayer(nonInteractive).pipe(Layer.provide(promptEnvLayer)));
    return yield* HumanInteraction.pipe(Effect.provide(context));
  });

describe("human interaction adapter", () => {
  it.effect("denies without prompting in non-interactive mode", () =>
    Effect.gen(function* () {
      const interaction = yield* interactionWith(true);
      const response: InteractionResponse = yield* interaction.request({
        toolName: "shell",
        callId: "call-1",
        input: { command: "ls" }
      });
      expect(response).toEqual({
        _tag: "Denied",
        reason: "Interaction is unavailable in non-interactive mode"
      });
    })
  );

  it.effect("degrades an approval prompt on a closed channel to a denial", () =>
    Effect.gen(function* () {
      const interaction = yield* interactionWith(false);
      const response: InteractionResponse = yield* interaction.request({
        toolName: "shell",
        callId: "call-2",
        input: { command: "rm -rf /" }
      });
      expect(response).toEqual({ _tag: "Denied", reason: "Prompt channel unavailable" });
    })
  );

  it.effect("degrades a question on a closed channel to a denial, not an answer", () =>
    Effect.gen(function* () {
      const interaction = yield* interactionWith(false);
      const response: InteractionResponse = yield* interaction.request({ question: "What is your name?" });
      expect(response._tag).toBe("Denied");
      expect(response).not.toMatchObject({ _tag: "Answered" });
    })
  );
});
