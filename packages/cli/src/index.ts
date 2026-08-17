import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Config, Console, DateTime, Effect, Layer, Option, Schema } from "effect";
import * as Stdio from "effect/Stdio";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { SessionId, SessionStore, fileSessionStoreLayer } from "@prodigy/core";
import { AppConfig, loadConfig, maskConfig, type ConfigData } from "./config.ts";
import { SessionRepo } from "./session.ts";
import { createFormatter } from "./output.ts";
import { runAgent as runAgentLoop } from "./agent.ts";
import type { AgentConfig } from "./agent.ts";
import { makeToolkitLayer } from "./tools/index.ts";
import { buildProviderLayer } from "./provider.ts";
import { makeApprovalGateLayer } from "./approval-gate.ts";
import { makeFileLoggerLayer } from "./logger.ts";
import { parseCommand } from "./slash-commands.ts";
import { discoverSkills, SkillsRepo, formatSkillsIndex, formatSkillContent } from "./skills.ts";
import type { Skill } from "./skills.ts";
import { layer as workspaceLayer } from "./adapters/workspace.ts";
import { layer as commandExecutorLayer } from "./adapters/command-executor.ts";

const systemPromptBuilder = (skills: Skill[], config: ConfigData) => {
  const explicitPrompt = config.systemPrompt ?? "";
  const autoInvokable = skills.filter((s) => !s.disableModelInvocation);

  const skillsIndex = autoInvokable.length > 0 ? formatSkillsIndex(autoInvokable) : "";

  return [skillsIndex, explicitPrompt].filter(Boolean).join("\n\n");
};

const configPathFromArgs = (args: readonly string[]): string | undefined => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg?.startsWith("--config=")) {
      return arg.slice("--config=".length);
    }
    if (arg === "--config") {
      return args[index + 1];
    }
  }
  return undefined;
};

const runAgent = (
  userMessages: readonly string[],
  sessionId: Option.Option<string>,
  config: ConfigData,
  skills: Skill[]
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const sessionRepo = yield* SessionRepo;

      const combinedSystemPrompt = systemPromptBuilder(skills, config);

      const sessionEffect = Option.match(sessionId, {
        onNone: () => sessionRepo.create(combinedSystemPrompt),
        onSome: (id) =>
          sessionRepo
            .load(id)
            .pipe(
              Effect.catchTag("SessionNotFound", () =>
                Effect.andThen(Console.log(`Session ${id} not found, starting a new session.`), () =>
                  sessionRepo.create(combinedSystemPrompt)
                )
              )
            )
      });

      const session = yield* sessionEffect;

      const agentConfig: AgentConfig = { session, config: { ...config, systemPrompt: combinedSystemPrompt } };
      const skillsRepoLayer = SkillsRepo.layer(skills);
      const providerLayer = buildProviderLayer(config.provider).pipe(Layer.provideMerge(FetchHttpClient.layer));
      const agentLayer = Layer.mergeAll(
        providerLayer,
        makeToolkitLayer({
          nonInteractive: config.nonInteractive ?? false,
          skillsRepoLayer
        }),
        skillsRepoLayer
      ).pipe(Layer.provide(makeApprovalGateLayer(config)));

      const outputEvents = yield* runAgentLoop(userMessages, agentConfig).pipe(
        // @effect-diagnostics-next-line effect/strictEffectProvide:off
        Effect.provide(agentLayer)
      );
      yield* sessionRepo.save(session);
      return { outputEvents, sessionId: session.id };
    })
  );

const promptArg = Argument.string("prompt").pipe(Argument.optional, Argument.withDescription("The prompt to process"));

const printFlag = Flag.boolean("print").pipe(Flag.withAlias("p"), Flag.withDescription("Print output"));

const outputFormatFlag = Flag.choice("output-format", ["text", "stream-json"] as const).pipe(
  Flag.withAlias("f"),
  Flag.withDefault("text"),
  Flag.withDescription("Output format")
);

const sessionFlag = Flag.string("session").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Session ID to load"),
  Flag.optional
);

const continueFlag = Flag.boolean("continue").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Continue previous session (reads PRODIGY_SESSION_ID env var, or starts new if not set)"),
  Flag.withDefault(false)
);

const modelFlag = Flag.string("model").pipe(Flag.withAlias("m"), Flag.withDescription("Model name"), Flag.optional);

const maxTurnsFlag = Flag.integer("max-turns").pipe(
  Flag.withAlias("t"),
  Flag.withDescription("Maximum number of turns"),
  Flag.optional
);

const approvalModeFlag = Flag.choice("approval-mode", ["none", "dangerous", "all"]).pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Approval mode"),
  Flag.optional
);

const systemPromptFlag = Flag.string("system-prompt").pipe(Flag.withDescription("System prompt"), Flag.optional);

const configFlag = Flag.string("config").pipe(Flag.withDescription("Config file path"), Flag.optional);

const nonInteractiveFlag = Flag.boolean("non-interactive").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Run in non-interactive mode (deny all approvals, disable ask_user)"),
  Flag.withDefault(false)
);

const mainCommand = Command.make(
  "prodigy",
  {
    prompt: promptArg,
    print: printFlag,
    outputFormat: outputFormatFlag,
    session: sessionFlag,
    continue: continueFlag,
    model: modelFlag,
    maxTurns: maxTurnsFlag,
    approvalMode: approvalModeFlag,
    systemPrompt: systemPromptFlag,
    config: configFlag,
    nonInteractive: nonInteractiveFlag
  },
  ({ prompt, outputFormat, session, continue: cont, model, maxTurns, approvalMode, systemPrompt, nonInteractive }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfig;

      const envSessionId = cont ? yield* Config.option(Config.string("PRODIGY_SESSION_ID")) : Option.none<string>();
      const sessionId = Option.orElse(session, () => envSessionId);

      const promptText = Option.getOrElse(prompt, () => "");
      if (!promptText) {
        yield* Console.log("No prompt provided. Use --prompt or pipe input.");
        return;
      }

      const skills = yield* discoverSkills(yield* Config.string("HOME"));

      let userMessages: readonly string[];
      const command = parseCommand(promptText);

      if (command._tag === "SkillPrefixed") {
        const skill = skills.find((s) => s.name === command.name);
        if (!skill) {
          yield* Console.log(`Skill '${command.name}' not found.`);
          return;
        }
        if (!command.prompt) {
          yield* Console.log("Usage: /skill <name> <prompt> — Load a skill and run the agent.");
          return;
        }
        userMessages = [formatSkillContent(skill), command.prompt];
      } else {
        userMessages = [promptText];
      }

      const finalConfig: ConfigData = {
        ...appConfig,
        provider: {
          ...appConfig.provider,
          model: Option.getOrElse(model, () => appConfig.provider.model)
        },
        maxTurns: Option.getOrElse(maxTurns, () => appConfig.maxTurns),
        approvalMode: Option.getOrElse(approvalMode, () => appConfig.approvalMode),
        systemPrompt: Option.getOrElse(systemPrompt, () => appConfig.systemPrompt),
        nonInteractive: nonInteractive || appConfig.nonInteractive
      };

      const formatter = createFormatter(outputFormat);
      const { outputEvents, sessionId: resultingSessionId } = yield* runAgent(
        userMessages,
        sessionId,
        finalConfig,
        skills
      );

      for (const event of outputEvents) {
        yield* formatter(event);
      }

      yield* formatter({ type: "session-info", sessionId: resultingSessionId });
    })
).pipe(Command.withDescription("Run the AI coder"));

const listSessionsCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const sessions = yield* store.list();

    if (sessions.length === 0) {
      yield* Console.log("No sessions found");
    } else {
      for (const session of sessions) {
        yield* Console.log(
          `${session.id} | Created: ${DateTime.formatIso(session.createdAt)} | Updated: ${DateTime.formatIso(session.updatedAt)}`
        );
      }
    }
  })
).pipe(Command.withDescription("List all sessions"));

const deleteSessionArg = Argument.string("id").pipe(Argument.withDescription("Session ID to delete"));

const deleteSessionCommand = Command.make("delete", { id: deleteSessionArg }, ({ id }) =>
  Effect.gen(function* () {
    const store = yield* SessionStore;
    const sessionId = Schema.decodeUnknownOption(SessionId)(id);
    if (Option.isNone(sessionId)) {
      yield* Console.log(`Invalid session ID: ${id}`);
      return;
    }
    yield* store.delete(sessionId.value);
    yield* Console.log(`Deleted session ${id}`);
  })
).pipe(Command.withDescription("Delete a session"));

const sessionCommand = Command.make("session", {}, () => Effect.void).pipe(
  Command.withSubcommands([listSessionsCommand, deleteSessionCommand]),
  Command.withDescription("Manage sessions")
);

const configShowCommand = Command.make("show", {}, () =>
  Effect.gen(function* () {
    const config = yield* AppConfig;
    const masked = maskConfig(config);
    const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(masked);
    yield* Console.log(json);
  })
).pipe(Command.withDescription("Show current config (masked)"));

const configCommand = Command.make("config", {}, () => Effect.void).pipe(
  Command.withSubcommands([configShowCommand]),
  Command.withDescription("Manage configuration")
);

export const app = Command.make("prodigy", {}).pipe(
  Command.withDescription("AI coding assistant"),
  Command.withSubcommands([mainCommand, sessionCommand, configCommand])
);

const appConfigLayer = Layer.unwrap(
  Stdio.Stdio.pipe(
    Effect.flatMap((stdio) => stdio.args),
    Effect.map((args) => loadConfig(configPathFromArgs(args)))
  )
);

const applicationLayer = Layer.mergeAll(
  appConfigLayer,
  makeFileLoggerLayer(),
  SessionRepo.layer(".prodigy-coder/sessions"),
  fileSessionStoreLayer(".prodigy-coder/sessions"),
  workspaceLayer("."),
  commandExecutorLayer,
  SkillsRepo.layer([])
).pipe(Layer.provideMerge(BunServices.layer));

const cli = Command.run(app, {
  version: "0.0.1"
}).pipe(
  // @effect-diagnostics-next-line effect/strictEffectProvide:off
  Effect.provide(applicationLayer)
);

BunRuntime.runMain(cli);
