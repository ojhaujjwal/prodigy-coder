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
>()("prodigy-coder/approval-gate/ApprovalGate") {}

export const approvalDeniedError = (toolName: string): AiError.AiError =>
  AiError.make({
    module: "ApprovalGate",
    method: "approve",
    reason: new AiError.UnknownError({ description: `Tool ${toolName} was denied approval` })
  });

export const DefaultApprovalGateLayer = Layer.succeed(
  ApprovalGate,
  ApprovalGate.of({ approve: () => Effect.succeed(true) })
);

export const createApprovalGate = (config: {
  approvalMode: ConfigData["approvalMode"];
  nonInteractive: boolean;
}): typeof ApprovalGate.Service => ({
  approve: (toolName: string, params: unknown) => {
    if (config.approvalMode === "none") {
      return Effect.succeed(true);
    }
    if (!needsApproval(toolName, config.approvalMode)) {
      return Effect.succeed(true);
    }
    if (config.nonInteractive) {
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
  }
});

export const makeApprovalGateLayer = (config: ConfigData): Layer.Layer<ApprovalGate> =>
  Layer.succeed(
    ApprovalGate,
    ApprovalGate.of(
      createApprovalGate({
        approvalMode: config.approvalMode,
        nonInteractive: config.nonInteractive ?? false
      })
    )
  );
