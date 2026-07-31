import { Context, Effect, Layer } from "effect";
import * as Prompt from "effect/unstable/cli/Prompt";

export class ApprovalPrompt extends Context.Service<
  ApprovalPrompt,
  {
    readonly confirm: (message: string) => Effect.Effect<boolean, never, never>;
  }
>()("prodigy-coder/approval-prompt/ApprovalPrompt") {}

export const makeApprovalPromptLayer = (): Layer.Layer<ApprovalPrompt, never, Prompt.Environment> =>
  Layer.effect(
    ApprovalPrompt,
    Effect.gen(function* () {
      const promptContext = yield* Effect.context<Prompt.Environment>();

      const confirm = (message: string) =>
        Prompt.run(
          Prompt.confirm({
            message,
            initial: false
          })
        ).pipe(
          Effect.orElseSucceed(() => false),
          Effect.provide(promptContext)
        );

      return ApprovalPrompt.of({ confirm });
    })
  );
