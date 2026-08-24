import { Effect, Layer } from "effect";
import * as Prompt from "effect/unstable/cli/Prompt";
import { HumanInteraction, type InteractionRequest, type InteractionResponse } from "@prodigy/core";

export const makeHumanInteractionLayer = (nonInteractive: boolean) =>
  Layer.effect(
    HumanInteraction,
    Effect.gen(function* () {
      const promptContext = yield* Effect.context<Prompt.Environment>();

      /**
       * A closed or unusable prompt channel (EOF, piped stdin, quit) degrades
       * to a denial instead of aborting the run. Approvals resolve as denied
       * so the model can continue with other work, and questions surface as a
       * failed tool result for the same reason. This is presentation policy:
       * core treats channel failure as exceptional; the terminal adapter knows
       * a dead prompt is ordinary in non-TTY contexts.
       */
      const degraded: InteractionResponse = { _tag: "Denied", reason: "Prompt channel unavailable" };

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
            Effect.catch(() => Effect.succeed(degraded)),
            Effect.provide(promptContext)
          );
        }

        return Prompt.run(Prompt.text({ message: input.question })).pipe(
          Effect.map((answer): InteractionResponse => ({ _tag: "Answered", answer })),
          Effect.catch(() => Effect.succeed(degraded)),
          Effect.provide(promptContext)
        );
      };

      return HumanInteraction.of({ request });
    })
  );
