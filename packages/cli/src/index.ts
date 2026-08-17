import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Config, Console, DateTime, Effect, Layer, Option, Predicate, Schema, Stream } from "effect";
import * as Stdio from "effect/Stdio";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
  PositiveInt,
  ProdigyAgent,
  SessionId,
  SessionStore,
  Workspace,
  WorkspacePath,
  fileSessionStoreLayer,
  makeDefaultAgenticProfile,
  makeProdigyAgentLayer
} from "@prodigy/core";
import type { AgentError, AgentEvent, JsonValue } from "@prodigy/core";
import { AppConfig, loadConfig, maskConfig, type ConfigData } from "./config.ts";
import { createFormatter } from "./output.ts";
import type { OutputEvent } from "./output.ts";
import { buildProviderLayer } from "./provider.ts";
import { makeFileLoggerLayer } from "./logger.ts";
import { parseCommand } from "./slash-commands.ts";
import { discoverSkills, formatSkillsIndex, formatSkillContent, makeSkillRepositoryLayer } from "./skills.ts";
import type { Skill } from "./skills.ts";
import { layer as workspaceLayer } from "./adapters/workspace.ts";
import { layer as commandExecutorLayer } from "./adapters/command-executor.ts";
import { makeHumanInteractionLayer } from "./human-interaction.ts";
import { needsApproval } from "./approval.ts";

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

const agentsPath = Schema.decodeUnknownSync(WorkspacePath)("AGENTS.md");

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

const mapAgentEvent = (event: AgentEvent): OutputEvent | undefined => {
  switch (event.type) {
    case "text-delta":
      return { type: "text-delta", delta: event.delta };
    case "tool-call":
      return { type: "tool-call", id: event.callId, name: event.toolName, params: event.input };
    case "tool-result":
      return event.outcome._tag === "Success"
        ? {
            type: "tool-result",
            id: event.callId,
            name: event.toolName,
            result: formatCoreToolOutput(event.outcome.output),
            isError: false
          }
        : {
            type: "tool-result",
            id: event.callId,
            name: event.toolName,
            result: event.outcome.error,
            isError: true
          };
    case "run-ended":
      return event.result._tag === "Finished"
        ? { type: "finish", text: event.result.finishReason }
        : { type: "error", message: `Max turns exceeded (${event.result.limit})` };
    default:
      return undefined;
  }
};

const formatCoreToolOutput = (output: JsonValue): string => {
  if (Array.isArray(output)) return output.join("\n");
  return Predicate.isString(output) ? output : JSON.stringify(output);
};

const errorOutput = (message: string): OutputEvent[] => [{ type: "error", message }];

const runCoreAgent = (prompt: string, sessionId: Option.Option<string>, config: ConfigData, skills: Skill[]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const profile = makeDefaultAgenticProfile({
        maxTurns: PositiveInt.make(config.maxTurns),
        systemPrompt: "",
        needsApproval: (toolName) => needsApproval(toolName, config.approvalMode)
      });
      const providerLayer = buildProviderLayer(config.provider).pipe(Layer.provideMerge(FetchHttpClient.layer));
      const capabilityLayer = Layer.mergeAll(
        fileSessionStoreLayer(".prodigy-coder/sessions"),
        workspaceLayer("."),
        commandExecutorLayer,
        makeHumanInteractionLayer(config.nonInteractive ?? false),
        makeSkillRepositoryLayer(skills)
      ).pipe(Layer.provideMerge(BunServices.layer));
      const handlerLayer = profile.toolkitHandlerLayer.pipe(
        Layer.provide(Layer.merge(capabilityLayer, FetchHttpClient.layer))
      );
      const runtimeLayer = Layer.mergeAll(providerLayer, handlerLayer).pipe(Layer.provideMerge(capabilityLayer));
      const program = Effect.gen(function* () {
        const workspace = yield* Workspace;
        const agentsMd = yield* workspace
          .read(agentsPath)
          .pipe(Effect.catchTag("WorkspaceLookupError", () => Effect.succeed("")));
        const systemPrompt = [agentsMd.trim(), systemPromptBuilder(skills, config)].filter(Boolean).join("\n\n");
        const configuredProfile = { ...profile, systemPrompt };
        const agentLayer = makeProdigyAgentLayer(configuredProfile).pipe(Layer.provide(runtimeLayer));
        const events = yield* Effect.gen(function* () {
          const agent = yield* ProdigyAgent;
          const run = Option.match(sessionId, {
            onNone: () => agent.run({ prompt, maxTurns: config.maxTurns }),
            onSome: (id) => agent.run({ prompt, sessionId: id, maxTurns: config.maxTurns })
          });
          return yield* run.pipe(Stream.runCollect);
        }).pipe(
          // @effect-diagnostics-next-line effect/strictEffectProvide:off
          Effect.provide(agentLayer)
        );
        const outputEvents: OutputEvent[] = [];
        let resultingSessionId: string | undefined;
        for (const event of events) {
          if (event.type === "run-started") resultingSessionId = event.sessionId;
          const mapped = mapAgentEvent(event);
          if (mapped !== undefined) outputEvents.push(mapped);
        }
        return { outputEvents, sessionId: resultingSessionId };
      });
      // @effect-diagnostics-next-line effect/strictEffectProvide:off
      return yield* program.pipe(Effect.provide(runtimeLayer));
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
      const promptForRun = userMessages.join("\n\n");
      const run = runCoreAgent(promptForRun, sessionId, finalConfig, skills);
      const { outputEvents, sessionId: resultingSessionId } = yield* run.pipe(
        Effect.catchTag("SessionNotFound", () =>
          Effect.gen(function* () {
            if (Option.isSome(sessionId)) {
              yield* Console.log(`Session ${sessionId.value} not found, starting a new session.`);
            }
            return yield* runCoreAgent(promptForRun, Option.none(), finalConfig, skills);
          })
        ),
        Effect.catch((error) =>
          Effect.succeed({
            outputEvents: errorOutput(coreErrorMessage(error)),
            sessionId: undefined
          })
        )
      );

      for (const event of outputEvents) {
        yield* formatter(event);
      }

      if (resultingSessionId !== undefined) {
        yield* formatter({ type: "session-info", sessionId: resultingSessionId });
      }
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
  fileSessionStoreLayer(".prodigy-coder/sessions"),
  workspaceLayer("."),
  commandExecutorLayer
).pipe(Layer.provideMerge(BunServices.layer));

const cli = Command.run(app, {
  version: "0.0.1"
}).pipe(
  // @effect-diagnostics-next-line effect/strictEffectProvide:off
  Effect.provide(applicationLayer)
);

BunRuntime.runMain(cli);
