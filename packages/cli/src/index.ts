import { BunRuntime } from "@effect/platform-bun";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { Config, Console, DateTime, Effect, Option, Schema, Stream } from "effect";
import { SessionId, SessionStore } from "@prodigy/core";
import { AppConfig, loadConfig, maskConfig } from "./config.ts";
import { applicationLayer, configFlag, invoke } from "./invocation.ts";
import type { InvocationFlags } from "./invocation.ts";
import { createFormatter } from "./output.ts";
import { parseCommand } from "./slash-commands.ts";
import { discoverSkills, formatSkillContent } from "./skills.ts";

const promptArg = Argument.string("prompt").pipe(Argument.optional, Argument.withDescription("The prompt to process"));

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

const approvalModeFlag = Flag.choice("approval-mode", ["none", "dangerous", "all"] as const).pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Approval mode"),
  Flag.optional
);

const systemPromptFlag = Flag.string("system-prompt").pipe(Flag.withDescription("System prompt"), Flag.optional);

const nonInteractiveFlag = Flag.boolean("non-interactive").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Run in non-interactive mode (deny all approvals, disable ask_user)"),
  Flag.withDefault(false)
);

const mainCommand = Command.make(
  "prodigy",
  {
    prompt: promptArg,
    outputFormat: outputFormatFlag,
    session: sessionFlag,
    continue: continueFlag,
    model: modelFlag,
    maxTurns: maxTurnsFlag,
    approvalMode: approvalModeFlag,
    systemPrompt: systemPromptFlag,
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

      const flags: InvocationFlags = { model, maxTurns, approvalMode, systemPrompt, nonInteractive };
      const formatter = createFormatter(outputFormat);
      const promptForRun = userMessages.join("\n\n");
      yield* invoke(promptForRun, sessionId, appConfig, flags, skills).pipe(Stream.runForEach(formatter));
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
  Command.withSharedFlags({ config: configFlag }),
  Command.withSubcommands([mainCommand, sessionCommand, configCommand]),
  Command.provide((input) => loadConfig(Option.getOrUndefined(input.config)))
);

const cli = Command.run(app, {
  version: "0.0.1"
}).pipe(
  // @effect-diagnostics-next-line effect/strictEffectProvide:off
  Effect.provide(applicationLayer)
);

BunRuntime.runMain(cli);
