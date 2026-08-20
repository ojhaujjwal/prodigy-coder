import { BunServices } from "@effect/platform-bun";
import {
  CommandExecutor,
  HumanInteraction,
  PositiveInt,
  ProdigyAgent,
  SessionStore,
  SkillRepository,
  Workspace,
  WorkspacePath,
  fileSessionStoreLayer,
  makeDefaultAgenticProfile,
  makeProdigyAgentLayer
} from "@prodigy/core";
import type { AgentError } from "@prodigy/core";
import { Crypto, Effect, Layer, Option, Schema, Stream } from "effect";
import type * as FileSystem from "effect/FileSystem";
import { LanguageModel } from "effect/unstable/ai";
import { Flag } from "effect/unstable/cli";
import type * as Prompt from "effect/unstable/cli/Prompt";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { layer as commandExecutorLayer } from "./adapters/command-executor.ts";
import { layer as workspaceLayer } from "./adapters/workspace.ts";
import type { ApprovalMode, ConfigData } from "./config.ts";
import { makeHumanInteractionLayer } from "./human-interaction.ts";
import { makeFileLoggerLayer } from "./logger.ts";
import { makeSkillRepositoryLayer, formatSkillsIndex } from "./skills.ts";
import type { Skill } from "./skills.ts";
import { needsApproval } from "./approval.ts";
import type { OutputEvent } from "./output.ts";
import { translateAgentEvent } from "./output-translate.ts";
import { buildProviderLayer } from "./provider.ts";

/** The `AGENTS.md` workspace path read into every invocation system prompt. */
const agentsPath = Schema.decodeUnknownSync(WorkspacePath)("AGENTS.md");

/**
 * Raw per-invocation flag inputs merged over the assembled configuration by
 * {@link resolveConfig}. These are the parsed command flags, not defaults.
 */
export interface InvocationFlags {
  readonly model: Option.Option<string>;
  readonly maxTurns: Option.Option<number>;
  readonly approvalMode: Option.Option<ApprovalMode>;
  readonly systemPrompt: Option.Option<string>;
  readonly nonInteractive: boolean;
}

/** The root `--config` flag: single source for the configuration file path. */
export const configFlag = Flag.string("config").pipe(Flag.withDescription("Config file path"), Flag.optional);

const systemPromptBuilder = (skills: readonly Skill[], config: ConfigData): string => {
  const explicitPrompt = config.systemPrompt ?? "";
  const autoInvokable = skills.filter((s) => !s.disableModelInvocation);

  const skillsIndex = autoInvokable.length > 0 ? formatSkillsIndex(autoInvokable) : "";

  return [skillsIndex, explicitPrompt].filter(Boolean).join("\n\n");
};

/** Convert a core agent error into its presentation message. */
const coreErrorMessage = (error: AgentError): string => {
  switch (error._tag) {
    case "SessionNotFound":
      return `Session ${error.id} not found`;
    case "InvalidRunRequest":
      return `Invalid run request: ${String(error.cause ?? "unknown request")}`;
    case "SessionStorageError":
      return `Session storage error: ${error.reason}`;
    case "ModelError":
      return `Model error: ${error.reason}`;
    case "ToolSystemError":
      return `Tool error: ${error.reason}`;
    case "InteractionCapabilityError":
      return `Interaction error: ${error.reason}`;
  }
};

/** Services the raw invocation needs from the composition root. */
type InvocationRequirements =
  | Workspace
  | CommandExecutor
  | HumanInteraction
  | SkillRepository
  | HttpClient.HttpClient
  | SessionStore
  | LanguageModel.LanguageModel
  | Crypto.Crypto;

/**
 * Merge parsed flag inputs over the assembled configuration.
 *
 * Precedence is: parsed flag value, then the `AppConfig` value (file, env,
 * default).
 */
export const resolveConfig = (appConfig: ConfigData, flags: InvocationFlags): ConfigData => ({
  ...appConfig,
  provider: {
    ...appConfig.provider,
    model: Option.getOrElse(flags.model, () => appConfig.provider.model)
  },
  maxTurns: Option.getOrElse(flags.maxTurns, () => appConfig.maxTurns),
  approvalMode: Option.getOrElse(flags.approvalMode, () => appConfig.approvalMode),
  systemPrompt: Option.getOrElse(flags.systemPrompt, () => appConfig.systemPrompt),
  nonInteractive: flags.nonInteractive || appConfig.nonInteractive
});

/**
 * Run a core agent invocation as a lazy, self-scoped stream of presentation
 * events.
 *
 * The stream never fails: `SessionNotFound` restarts a new run (after a
 * `notice` event), and any remaining agent or tool error is projected into an
 * `error` event before the stream ends. All per-invocation composition (system
 * prompt, profile, and agent layer) happens lazily when the returned stream is
 * consumed, so tests cross the same seam production does.
 */
export const runInvocation = (
  prompt: string,
  sessionId: Option.Option<string>,
  config: ConfigData,
  skills: readonly Skill[]
): Stream.Stream<OutputEvent, never, InvocationRequirements> => {
  const projected: Stream.Stream<OutputEvent, AgentError, InvocationRequirements> = Stream.unwrap(
    Effect.gen(function* () {
      const workspace = yield* Workspace;

      const agentsMd = yield* workspace
        .read(agentsPath)
        .pipe(Effect.catchTag("WorkspaceLookupError", () => Effect.succeed("")));

      const systemPrompt = [agentsMd.trim(), systemPromptBuilder(skills, config)].filter(Boolean).join("\n\n");

      const profile = makeDefaultAgenticProfile({
        maxTurns: PositiveInt.make(config.maxTurns),
        systemPrompt,
        needsApproval: (toolName) => needsApproval(toolName, config.approvalMode)
      });

      const agentContext = yield* Layer.build(makeProdigyAgentLayer(profile));

      const runOnce = (id: Option.Option<string>): Stream.Stream<OutputEvent, AgentError, ProdigyAgent> =>
        Stream.unwrap(
          Effect.gen(function* () {
            const agent = yield* ProdigyAgent;
            const run = Option.match(id, {
              onNone: () => agent.run({ prompt, maxTurns: config.maxTurns }),
              onSome: (sid) => agent.run({ prompt, sessionId: sid, maxTurns: config.maxTurns })
            });
            return run.pipe(Stream.flatMap((event) => Stream.fromIterable(translateAgentEvent(event))));
          })
        );

      const notice: OutputEvent = Option.isSome(sessionId)
        ? { type: "notice" as const, message: `Session ${sessionId.value} not found, starting a new session.` }
        : { type: "notice" as const, message: "Session not found, starting a new session." };

      return Stream.provide(runOnce(sessionId), agentContext).pipe(
        Stream.catchTag("SessionNotFound", () =>
          Stream.concat(Stream.succeed(notice), Stream.provide(runOnce(Option.none()), agentContext))
        )
      );
    })
  );
  return Stream.catchIf(
    projected,
    (_error): _error is AgentError => true,
    (error) => Stream.succeed({ type: "error" as const, message: coreErrorMessage(error) })
  );
};

/** Services still required after the per-invocation adapters are provided. */
type StaticRequirements =
  | Workspace
  | CommandExecutor
  | SessionStore
  | HttpClient.HttpClient
  | FileSystem.FileSystem
  | Prompt.Environment
  | Crypto.Crypto;

/**
 * Compose the effective configuration and run it with the production
 * interaction, skill, and provider adapters.
 *
 * Returns a lazy stream of presentation events. This is the single composition
 * point for one invocation: the command layer supplies parsed flags, discovered
 * skills, and the assembled configuration, and drains translated presentation
 * events. The per-invocation adapters are built into a context and provided
 * here at one site; static authorities remain requirements satisfied at the
 * program edge.
 */
export const invoke = (
  prompt: string,
  sessionId: Option.Option<string>,
  appConfig: ConfigData,
  flags: InvocationFlags,
  skills: readonly Skill[]
): Stream.Stream<OutputEvent, never, StaticRequirements> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const config = resolveConfig(appConfig, flags);
      const perRunContext = yield* Layer.build(
        Layer.mergeAll(
          buildProviderLayer(config.provider),
          makeHumanInteractionLayer(config.nonInteractive ?? false),
          makeSkillRepositoryLayer(skills)
        )
      );
      return Stream.provide(runInvocation(prompt, sessionId, config, skills), perRunContext);
    })
  );

/**
 * Static CLI authorities shared by the session, configuration, and run paths:
 * no per-invocation state and no configuration choice. `AppConfig` is provided
 * per invocation by the root command from its parsed `--config` flag.
 */
export const applicationLayer = Layer.mergeAll(
  makeFileLoggerLayer(),
  fileSessionStoreLayer(".prodigy-coder/sessions"),
  workspaceLayer("."),
  commandExecutorLayer("."),
  FetchHttpClient.layer
).pipe(Layer.provideMerge(BunServices.layer));
