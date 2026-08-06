import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";
import {
  HumanInteraction,
  type InteractionRequest,
  type InteractionResponse
} from "../../capabilities/human-interaction.ts";

export const EchoTool = Tool.make("echo", {
  description: "Echo a value",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return"
});

export const EchoToolkit = Toolkit.make(EchoTool);

/** A tool that requires human approval before the handler executes. */
export const ApprovalTool = Tool.make("approval-gated", {
  description: "A tool that requires human approval",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return",
  needsApproval: true,
  dependencies: [HumanInteraction]
});

export const ApprovalToolkit = Toolkit.make(ApprovalTool);

export type ScriptedEchoOutcome =
  | { readonly _tag: "Success"; readonly value: string }
  | { readonly _tag: "Failure"; readonly message: string };

export type ScriptedEchoToolkit = {
  readonly layer: Layer.Layer<Tool.HandlersFor<typeof EchoToolkit.tools>>;
  readonly calls: Array<Readonly<{ value: string }>>;
};

export const scriptedEchoToolkit = (
  outcome: ScriptedEchoOutcome = { _tag: "Success", value: "echoed" }
): ScriptedEchoToolkit => {
  const calls: Array<Readonly<{ value: string }>> = [];
  const layer = EchoToolkit.toLayer({
    echo: (input) => {
      calls.push(input);
      if (outcome._tag === "Failure") {
        return Effect.fail({ message: outcome.message });
      }
      return Effect.succeed({ value: outcome.value });
    }
  });
  return { layer, calls };
};

export const scriptedToolModelLayer = (
  turns: ReadonlyArray<ReadonlyArray<Response.StreamPartEncoded>>
): Layer.Layer<LanguageModel.LanguageModel> => {
  let index = 0;
  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => {
        const parts = turns[index] ?? [];
        index += 1;
        return Stream.fromIterable(parts);
      }
    })
  );
};

export type ScriptedInteraction = {
  readonly layer: Layer.Layer<HumanInteraction>;
  readonly requests: Array<InteractionRequest>;
};

/**
 * A scripted `HumanInteraction` adapter for integration tests: records every
 * request and answers each in order from the supplied responses. The core
 * analogue of the CLI's scripted approval tests.
 */
export const scriptedInteractionLayer = (responses: ReadonlyArray<InteractionResponse>): ScriptedInteraction => {
  const requests: Array<InteractionRequest> = [];
  let index = 0;
  const layer = Layer.succeed(
    HumanInteraction,
    HumanInteraction.of({
      request: (input) => {
        requests.push(input);
        const response = responses[index] ?? { _tag: "Denied", reason: "No scripted response" };
        index += 1;
        return Effect.succeed(response);
      }
    })
  );
  return { layer, requests };
};
