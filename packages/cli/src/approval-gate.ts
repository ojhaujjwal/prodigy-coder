import { Context, Effect, Layer } from "effect";
import * as AiError from "effect/unstable/ai/AiError";
import type * as Prompt from "effect/unstable/cli/Prompt";
import type { JsonValue } from "@prodigy/core";
import { needsApproval } from "./approval.ts";
import { ApprovalPrompt, makeApprovalPromptLayer } from "./approval-prompt.ts";
import type { ConfigData } from "./config.ts";

export class ApprovalGate extends Context.Service<
  ApprovalGate,
  {
    readonly approve: (toolName: string, params: JsonValue) => Effect.Effect<boolean, never, never>;
  }
>()("@prodigy/cli/approval-gate/ApprovalGate") {}

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

export const createApprovalGate = (
  config: {
    approvalMode: ConfigData["approvalMode"];
    nonInteractive: boolean;
  },
  prompt: typeof ApprovalPrompt.Service
): typeof ApprovalGate.Service => ({
  approve: (toolName: string, params: JsonValue) => {
    if (config.approvalMode === "none") {
      return Effect.succeed(true);
    }
    if (!needsApproval(toolName, config.approvalMode)) {
      return Effect.succeed(true);
    }
    if (config.nonInteractive) {
      return Effect.succeed(false);
    }
    return prompt.confirm(`Allow ${toolName}(${JSON.stringify(params)})?`);
  }
});

export const makeApprovalGate = (
  config: ConfigData
): Effect.Effect<typeof ApprovalGate.Service, never, ApprovalPrompt> =>
  Effect.gen(function* () {
    const prompt = yield* ApprovalPrompt;
    return ApprovalGate.of(
      createApprovalGate(
        {
          approvalMode: config.approvalMode,
          nonInteractive: config.nonInteractive ?? false
        },
        prompt
      )
    );
  });

export const makeApprovalGateLayer = (config: ConfigData): Layer.Layer<ApprovalGate, never, Prompt.Environment> =>
  Layer.effect(ApprovalGate, makeApprovalGate(config)).pipe(Layer.provide(makeApprovalPromptLayer()));
