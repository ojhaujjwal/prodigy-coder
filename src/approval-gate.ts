import { Context, Effect, Layer } from "effect";
import * as Prompt from "effect/unstable/cli/Prompt";
import * as AiError from "effect/unstable/ai/AiError";
import { BunServices } from "@effect/platform-bun";
import { needsApproval } from "./approval.ts";
import type { ConfigData } from "./config.ts";

export class ApprovalGate extends Context.Service<
  ApprovalGate,
  {
    readonly approve: (toolName: string, params: unknown) => Effect.Effect<boolean, never, never>;
  }
>()("ApprovalGate") {}

export const approvalDeniedError = (toolName: string): AiError.AiError =>
  AiError.make({
    module: "ApprovalGate",
    method: "approve",
    reason: new AiError.UnknownError({ description: `Tool ${toolName} was denied approval` })
  });

export const makeApprovalGateLayer = (config: ConfigData): Layer.Layer<ApprovalGate> =>
  Layer.effect(
    ApprovalGate,
    Effect.sync(() => {
      const approve = (toolName: string, params: unknown): Effect.Effect<boolean, never, never> => {
        if (config.nonInteractive) {
          return Effect.succeed(false);
        }
        if (config.approvalMode === "none") {
          return Effect.succeed(true);
        }
        if (!needsApproval(toolName, config.approvalMode)) {
          return Effect.succeed(true);
        }
        // oxlint-disable-next-line prodigy/no-process
        if (!globalThis.process?.stdin?.isTTY) {
          return Effect.succeed(false);
        }
        return Prompt.run(
          Prompt.confirm({
            message: `Allow ${toolName}(${JSON.stringify(params)})?`,
            initial: false
          })
        ).pipe(
          Effect.orElseSucceed(() => false),
          Effect.provide(BunServices.layer)
        );
      };

      return ApprovalGate.of({ approve });
    })
  );
