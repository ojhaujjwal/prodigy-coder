import { Layer, Schema } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HumanInteraction } from "../capabilities/human-interaction.ts";
import { Workspace } from "../capabilities/workspace.ts";
import { CommandExecutor } from "../capabilities/command-executor.ts";
import { SkillRepository } from "../capabilities/skill-repository.ts";

/**
 * The authority requirements of a profile's handler Layers. A profile whose
 * tools need `Workspace`/`CommandExecutor`/`HumanInteraction`/`SkillRepository`
 * declares them here; the composition root provides the concrete Layers.
 */
export type ToolkitAuthorities = Workspace | CommandExecutor | HumanInteraction | SkillRepository;

/**
 * A positive integer: the profile's default turn bound, and the ceiling for
 * per-run `maxTurns` overrides (validated in `run-request.ts`).
 */
const PositiveInt = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)));
export type PositiveInt = Schema.Schema.Type<typeof PositiveInt>;

/**
 * A named, runtime-bound plain typed value for one agent instance. It selects
 * one typed Effect AI toolkit and the policy governing its use: the handler
 * Layer, the system prompt, and the turn limit. A run may override `maxTurns`
 * within the profile's bound, but it can never replace the toolkit.
 *
 * The toolkit is a typed Effect AI `Toolkit` value (whose tools record stays
 * precise), the handler Layer's pairing is checked by the compiler, and
 * `authorities` declares the capability services the handler Layer requires
 * (`Workspace`, `CommandExecutor`, `HumanInteraction`); the composition root
 * must provide them.
 */
export type AgentProfile<TTools extends Record<string, Tool.Any>, TAuthorities extends ToolkitAuthorities = never> = {
  readonly toolkit: Toolkit.Toolkit<TTools>;
  readonly toolkitLayer: Layer.Layer<
    Tool.HandlersFor<TTools>,
    never,
    TAuthorities | Tool.HandlerServices<TTools[keyof TTools]>
  >;
  readonly authorities?: TAuthorities;
  readonly systemPrompt: string;
  readonly maxTurns: PositiveInt;
};

/**
 * The toolkit's full handler-service requirements: what `streamText` needs
 * when resolving and executing the toolkit's handlers.
 */
export type ToolkitServices<TTools extends Record<string, Tool.Any>> =
  | Tool.HandlerServices<TTools[keyof TTools]>
  | Tool.ResultDecodingServices<TTools[keyof TTools]>;

/**
 * The requirement channel a profile propagates: its authorities, the toolkit's
 * handler services, and the toolkit's handler-tag requirements (what the
 * toolkit Effect and `streamText` need).
 */
export type ProfileAuthorities<
  TTools extends Record<string, Tool.Any>,
  TAuthorities extends ToolkitAuthorities = never
> = TAuthorities | ToolkitServices<TTools> | Tool.HandlersFor<TTools>;
