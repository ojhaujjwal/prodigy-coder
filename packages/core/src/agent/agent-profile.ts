import { Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";

/** A positive integer used as an Agent profile's turn bound. */
export const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)), Schema.brand("PositiveInt"));
export type PositiveInt = Schema.Schema.Type<typeof PositiveInt>;

/**
 * A named, runtime-bound plain typed value for one agent instance. It selects
 * one typed Effect AI toolkit and the policy governing its use: the handler
 * Layer, the system prompt, and the turn limit. A run may override `maxTurns`
 * within the profile's bound, but it can never replace the toolkit.
 *
 * The toolkit is a typed Effect AI `Toolkit` value (whose tools record stays
 * precise), and the handler Layer's pairing and requirements are checked by the
 * compiler; the composition root provides its required services.
 */
export type AgentProfile<TTools extends Record<string, Tool.Any>> = {
  readonly toolkit: Toolkit.Toolkit<TTools>;
  readonly toolkitHandlerLayer: Layer.Layer<
    Tool.HandlersFor<TTools>,
    never,
    Tool.HandlerServices<TTools[keyof TTools]>
  >;
  readonly systemPrompt: string;
  readonly maxTurns: PositiveInt;
};
