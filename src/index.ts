import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Console, Effect, Layer, Option, Schema } from "effect";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { AppConfig, loadConfig, maskConfig, type ConfigData } from "./config.ts";
import { SessionRepo, createSession, loadSession } from "./session.ts";
import { createFormatter } from "./output.ts";
import { runAgent as runAgentLoop } from "./agent.ts";
import type { AgentConfig } from "./agent.ts";
import { makeToolkitLayer } from "./tools/index.ts";
import { buildProviderLayer } from "./provider.ts";
import { makeFileLoggerLayer } from "./logger.ts";

const runAgent = (prompt: string, sessionId: Option.Option<string>, config: import("./config.ts").ConfigData) => {
  const sessionEffect = Option.match(sessionId, {
    onNone: () => createSession(config.systemPrompt),
    onSome: (id) => loadSession(id).pipe(Effect.orDie)
  });

  return Effect.gen(function* () {
    const session = yield* sessionEffect;

    const agentConfig: AgentConfig = { session, config };
    const providerLayer = Layer.merge(
      buildProviderLayer(config.provider),
      makeToolkitLayer({ approvalMode: config.approvalMode, nonInteractive: config.nonInteractive ?? false })
    ).pipe(Layer.provide(FetchHttpClient.layer));

    return yield* runAgentLoop(prompt, agentConfig, providerLayer);
  }).pipe(Effect.provide(SessionRepo.layer.pipe(Layer.provide(BunServices.layer))));
};

const promptArg = Argument.string("prompt").pipe(Argument.optional, Argument.withDescription("The prompt to process"));

const printFlag = Flag.boolean("print").pipe(Flag.withAlias("p"), Flag.withDescription("Print output"));

const outputFormatFlag = Flag.choice("output-format", ["text", "stream-json"]).pipe(
  Flag.withAlias("f"),
  Flag.withDefault("text"),
  Flag.withDescription("Output format")
);

const sessionFlag = Flag.string("session").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Session ID to load"),
  Flag.optional
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
    model: modelFlag,
    maxTurns: maxTurnsFlag,
    approvalMode: approvalModeFlag,
    systemPrompt: systemPromptFlag,
    config: configFlag,
    nonInteractive: nonInteractiveFlag
  },
  ({ prompt, outputFormat, session, model, maxTurns, approvalMode, systemPrompt, nonInteractive, config }) =>
    Effect.gen(function* () {
      const appConfig = yield* AppConfig;
      const sessionId = session;

      const promptText = Option.getOrElse(prompt, () => "");
      if (!promptText) {
        yield* Console.log("No prompt provided. Use --prompt or pipe input.");
        return;
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

      const format: "text" | "stream-json" = outputFormat satisfies "text" | "stream-json";
      const formatter = createFormatter(format);
      const outputEvents = yield* runAgent(promptText, sessionId, finalConfig);

      for (const event of outputEvents) {
        yield* formatter(event);
      }
    }).pipe(
      Effect.provide(
        (Option.getOrElse(config, () => "") ? loadConfig(Option.getOrElse(config, () => "")) : loadConfig()).pipe(
          Layer.merge(SessionRepo.layer)
        )
      )
    )
).pipe(Command.withDescription("Run the AI coder"));

const listSessionsCommand = Command.make("list", {}, () =>
  Effect.gen(function* () {
    const repo = yield* SessionRepo;
    const sessions = yield* repo.list();

    if (sessions.length === 0) {
      yield* Console.log("No sessions found");
    } else {
      for (const session of sessions) {
        yield* Console.log(
          `${session.id} | Created: ${session.createdAt.toISOString()} | Updated: ${session.updatedAt.toISOString()}`
        );
      }
    }
  }).pipe(Effect.provide(SessionRepo.layer))
).pipe(Command.withDescription("List all sessions"));

const deleteSessionArg = Argument.string("id").pipe(Argument.withDescription("Session ID to delete"));

const deleteSessionCommand = Command.make("delete", { id: deleteSessionArg }, ({ id }) =>
  Effect.gen(function* () {
    const repo = yield* SessionRepo;
    yield* repo.delete(id);
    yield* Console.log(`Deleted session ${id}`);
  }).pipe(Effect.provide(SessionRepo.layer))
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
  }).pipe(Effect.provide(loadConfig()))
).pipe(Command.withDescription("Show current config (masked)"));

const configCommand = Command.make("config", {}, () => Effect.void).pipe(
  Command.withSubcommands([configShowCommand]),
  Command.withDescription("Manage configuration")
);

export const app = Command.make("prodigy", {}).pipe(
  Command.withDescription("AI coding assistant"),
  Command.withSubcommands([mainCommand, sessionCommand, configCommand])
);

const cli = Command.run(app, {
  version: "0.0.1"
}).pipe(
  Effect.provide(Layer.mergeAll(BunServices.layer, makeFileLoggerLayer().pipe(Layer.provide(BunServices.layer))))
);

BunRuntime.runMain(cli);
