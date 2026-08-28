import { Effect, Layer } from "effect";
import * as Prompt from "effect/unstable/cli/Prompt";
import { HumanInteraction, type InteractionRequest, type InteractionResponse, type JsonValue } from "@prodigy/core";

const degradedResponse: InteractionResponse = { _tag: "Denied", reason: "Prompt channel unavailable" };

const nonInteractiveResponse: InteractionResponse = {
  _tag: "Denied",
  reason: "Interaction is unavailable in non-interactive mode"
};

const approvalPrompt = (toolName: string, input: JsonValue) =>
  Prompt.confirm({
    message: `Allow ${toolName}(${JSON.stringify(input)})?`,
    initial: false
  });

const questionPrompt = (question: string) => Prompt.text({ message: question });

/**
 * CLI `HumanInteraction` adapter.
 *
 * - `nonInteractive === true` → never prompts, every request is denied.
 * - otherwise → `Prompt.confirm` for approvals, `Prompt.text` for questions.
 *
 * A closed prompt channel (EOF, piped stdin, `QuitError`) degrades to
 * `Denied("Prompt channel unavailable")` instead of failing the run. This is
 * presentation policy — core treats channel failure as exceptional, but the
 * terminal adapter knows a dead prompt is ordinary in non-TTY contexts.
 *
 * The `Prompt.Environment` (Terminal, FileSystem, Path) is captured once at
 * layer construction via explicit service dependencies and then provided per
 * request. This hides the terminal requirement from the `HumanInteraction`
 * contract, which intentionally exposes `request` as `Effect<InteractionResponse>`
 * with no environment.
 */
export const makeHumanInteractionLayer = (nonInteractive: boolean) =>
  Layer.effect(
    HumanInteraction,
    Effect.gen(function* () {
      if (nonInteractive) {
        return HumanInteraction.of({ request: () => Effect.succeed(nonInteractiveResponse) });
      }

      // `Prompt.run` requires the `Prompt.Environment` (Terminal, FileSystem,
      // Path). `HumanInteraction.request` intentionally hides that requirement,
      // so we capture the whole environment once and provide it to each prompt.
      // `Effect.context<Prompt.Environment>()` stays correct if `Prompt.Environment`
      // gains a member; a hand-built context would silently miss it.
      const promptContext = yield* Effect.context<Prompt.Environment>();

      const request = (input: InteractionRequest): Effect.Effect<InteractionResponse> => {
        if ("toolName" in input) {
          return Prompt.run(approvalPrompt(input.toolName, input.input)).pipe(
            Effect.map(
              (approved): InteractionResponse =>
                approved ? { _tag: "Approved" } : { _tag: "Denied", reason: "User denied approval" }
            ),
            Effect.catch(() => Effect.succeed(degradedResponse)),
            Effect.provide(promptContext)
          );
        }

        return Prompt.run(questionPrompt(input.question)).pipe(
          Effect.map((answer): InteractionResponse => ({ _tag: "Answered", answer })),
          Effect.catch(() => Effect.succeed(degradedResponse)),
          Effect.provide(promptContext)
        );
      };

      return HumanInteraction.of({ request });
    })
  );
