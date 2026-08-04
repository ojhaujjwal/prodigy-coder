import { Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai";
import type { Response } from "effect/unstable/ai";

export const EchoTool = Tool.make("echo", {
  description: "Echo a value",
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ value: Schema.String }),
  failure: Schema.Struct({ message: Schema.String }),
  failureMode: "return"
});

export const EchoToolkit = Toolkit.make(EchoTool);

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
