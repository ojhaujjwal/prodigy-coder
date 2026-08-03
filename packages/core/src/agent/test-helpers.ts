import { Effect, Layer, Stream } from "effect";
import { LanguageModel, Response } from "effect/unstable/ai";

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
