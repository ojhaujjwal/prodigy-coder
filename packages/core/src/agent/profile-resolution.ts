import { Context, Effect, Layer, Option, Scope } from "effect";
import { Tool, Toolkit } from "effect/unstable/ai";
import { HumanInteraction } from "../capabilities/human-interaction.ts";
import { ToolSystemError } from "./agent-error.ts";
import type { AgentProfile, PositiveInt } from "./agent-profile.ts";

/** The services required while executing a resolved toolkit. */
type ToolkitServices<TTools extends Record<string, Tool.Any>> =
  | Tool.HandlerServices<TTools[keyof TTools]>
  | Tool.ResultDecodingServices<TTools[keyof TTools]>;

/** The profile data resolved once during agent-layer construction. */
export type ResolvedAgentProfile<TTools extends Record<string, Tool.Any>> = {
  readonly toolkit: Toolkit.WithHandler<TTools>;
  readonly toolkitContext: Context.Context<ToolkitServices<TTools>>;
  readonly systemPrompt: string;
  readonly maxTurns: PositiveInt;
};

/**
 * Resolve a declarative profile into the stable toolkit used by every run.
 *
 * The profile's handler Layer is built from the supplied Effect environment,
 * then the resulting handlers and execution requirements are closed over. The
 * approval check remains here because approval metadata is not represented in
 * the handler service requirements.
 */
export const resolveAgentProfile = Effect.fn("resolveAgentProfile")(function* <TTools extends Record<string, Tool.Any>>(
  profile: AgentProfile<TTools>
): Effect.fn.Return<ResolvedAgentProfile<TTools>, ToolSystemError, ToolkitServices<TTools> | Scope.Scope> {
  const toolkitContext = yield* Effect.context<ToolkitServices<TTools>>();
  const handlerContext = yield* Layer.build(profile.toolkitHandlerLayer).pipe(Effect.provideContext(toolkitContext));
  const toolkit = yield* profile.toolkit.pipe(Effect.provideContext(handlerContext));
  const approvalGatedTools = Object.values(toolkit.tools).filter((tool) => tool.needsApproval !== undefined);

  if (approvalGatedTools.length > 0 && Option.isNone(Context.getOption(toolkitContext, HumanInteraction))) {
    return yield* new ToolSystemError({
      reason: "ToolkitMisconfiguration",
      cause: new Error(
        `Tools [${approvalGatedTools.map((tool) => tool.name).join(", ")}] require approval, ` +
          "but no HumanInteraction service is provided in the toolkit context"
      )
    });
  }

  return {
    toolkit,
    toolkitContext,
    systemPrompt: profile.systemPrompt,
    maxTurns: profile.maxTurns
  };
});
