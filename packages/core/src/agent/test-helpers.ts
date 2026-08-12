import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Prompt, Response } from "effect/unstable/ai";

/**
 * Build a scripted `LanguageModel` test-double over provider-neutral
 * `Response.StreamPartEncoded` parts. A contract-boundary double, not a mock
 * provider HTTP server — those belong to `@prodigy/cli`.
 *
 * The parts are decoded by `LanguageModel.make` and re-emitted as `Response
 * .StreamPart`s by `streamText`; the double needs no network and is fully
 * deterministic.
 */
export const testLanguageModelLayer = (
  parts: ReadonlyArray<Response.StreamPartEncoded>
): Layer.Layer<LanguageModel.LanguageModel> =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: () => Stream.fromIterable(parts)
    })
  );

/**
 * A scripted `LanguageModel` that records every `streamText` prompt exactly as
 * it reaches the model boundary, so tests can assert the provider-visible
 * transcript (e.g. that a prompt is not duplicated on the first turn).
 */
export type RecordingLanguageModel = {
  readonly layer: Layer.Layer<LanguageModel.LanguageModel>;
  readonly prompts: Array<Prompt.Prompt>;
};

export const recordingLanguageModelLayer = (
  parts: ReadonlyArray<Response.StreamPartEncoded>
): RecordingLanguageModel => {
  const prompts: Array<Prompt.Prompt> = [];
  const layer = Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([]),
      streamText: (input) => {
        prompts.push(input.prompt);
        return Stream.fromIterable(parts);
      }
    })
  );
  return { layer, prompts };
};
