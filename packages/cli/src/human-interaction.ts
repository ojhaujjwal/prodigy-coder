import { Effect, Layer } from "effect";
import * as Prompt from "effect/unstable/cli/Prompt";
import {
  HumanInteraction,
  HumanInteractionError,
  type InteractionRequest,
  type InteractionResponse
} from "@prodigy/core";

export const makeHumanInteractionLayer = (
  nonInteractive: boolean
): Layer.Layer<HumanInteraction, never, Prompt.Environment> =>
  Layer.effect(
    HumanInteraction,
    Effect.gen(function* () {
      const promptContext = yield* Effect.context<Prompt.Environment>();

      const request = (input: InteractionRequest) => {
        if (nonInteractive) {
          return Effect.succeed<InteractionResponse>({
            _tag: "Denied",
            reason: "Interaction is unavailable in non-interactive mode"
          });
        }

        if ("toolName" in input) {
          return Prompt.run(
            Prompt.confirm({
              message: `Allow ${input.toolName}(${JSON.stringify(input.input)})?`,
              initial: false
            })
          ).pipe(
            Effect.map(
              (approved): InteractionResponse =>
                approved ? { _tag: "Approved" } : { _tag: "Denied", reason: "User denied approval" }
            ),
            Effect.catch(() => new HumanInteractionError({ reason: "ChannelClosed" })),
            Effect.provide(promptContext)
          );
        }

        return Prompt.run(Prompt.text({ message: input.question })).pipe(
          Effect.map((answer): InteractionResponse => ({ _tag: "Answered", answer })),
          Effect.catch(() => new HumanInteractionError({ reason: "ChannelClosed" })),
          Effect.provide(promptContext)
        );
      };

      return HumanInteraction.of({ request });
    })
  );
