import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect, Option } from "effect"
import { AppConfig, loadConfig, maskConfig } from "./config.ts"
import { SessionRepo, createSession, loadSession, saveSession } from "./session.ts"
import { createFormatter, type OutputEvent } from "./output.ts"

const runAgent = (
  prompt: string,
  sessionId: Option.Option<string>,
  format: "text" | "stream-json"
): Effect.Effect<void, unknown, AppConfig | SessionRepo> =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    const formatter = createFormatter(format)

    const session = yield* Option.match(sessionId, {
      onNone: () => createSession(config.systemPrompt),
      onSome: (id) => loadSession(id),
    })

    yield* formatter({ type: "text-delta", delta: `Processing: ${prompt}\n` } as OutputEvent)
    yield* formatter({ type: "finish", text: "Agent completed (stub)" } as OutputEvent)

    yield* saveSession(session)
  })

const promptArg = Argument.string("prompt").pipe(
  Argument.optional,
  Argument.withDescription("The prompt to process")
)

const printFlag = Flag.boolean("print").pipe(
  Flag.withAlias("p"),
  Flag.withDescription("Print output")
)

const outputFormatFlag = Flag.choice("output-format", ["text", "stream-json"]).pipe(
  Flag.withAlias("f"),
  Flag.withDefault("text"),
  Flag.withDescription("Output format")
)

const sessionFlag = Flag.string("session").pipe(
  Flag.withAlias("s"),
  Flag.withDescription("Session ID to load")
)

const modelFlag = Flag.string("model").pipe(
  Flag.withAlias("m"),
  Flag.withDescription("Model name")
)

const maxTurnsFlag = Flag.integer("max-turns").pipe(
  Flag.withAlias("t"),
  Flag.withDescription("Maximum number of turns")
)

const approvalModeFlag = Flag.choice("approval-mode", ["none", "dangerous", "all"]).pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Approval mode")
)

const systemPromptFlag = Flag.string("system-prompt").pipe(
  Flag.withDescription("System prompt")
)

const configFlag = Flag.string("config").pipe(
  Flag.withDescription("Config file path")
)

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
  },
  ({ prompt, outputFormat, session, model: _model, maxTurns: _maxTurns, approvalMode: _approvalMode, systemPrompt: _systemPrompt, config }) =>
    Effect.gen(function* () {
      const sessionId = session ? Option.some(session) : Option.none<string>()

      const promptText = Option.getOrElse(prompt, () => "")
      if (!promptText) {
        yield* Console.log("No prompt provided. Use --prompt or pipe input.")
        return
      }

      const format = outputFormat as "text" | "stream-json"
      yield* runAgent(promptText, sessionId, format)
    }).pipe(
      Effect.provide(config ? loadConfig(config) : loadConfig()),
      Effect.provide(SessionRepo.layer)
    )
).pipe(Command.withDescription("Run the AI coder"))

const listSessionsCommand = Command.make(
  "list",
  {},
  () =>
    Effect.gen(function* () {
      const repo = yield* SessionRepo
      const sessions = yield* repo.list()

      if (sessions.length === 0) {
        yield* Console.log("No sessions found")
      } else {
        for (const session of sessions) {
          yield* Console.log(`${session.id} | Created: ${session.createdAt.toISOString()} | Updated: ${session.updatedAt.toISOString()}`)
        }
      }
    }).pipe(Effect.provide(SessionRepo.layer))
).pipe(Command.withDescription("List all sessions"))

const deleteSessionArg = Argument.string("id").pipe(
  Argument.withDescription("Session ID to delete")
)

const deleteSessionCommand = Command.make(
  "delete",
  { id: deleteSessionArg },
  ({ id }) =>
    Effect.gen(function* () {
      const repo = yield* SessionRepo
      yield* repo.delete(id)
      yield* Console.log(`Deleted session ${id}`)
    }).pipe(Effect.provide(SessionRepo.layer))
).pipe(Command.withDescription("Delete a session"))

const sessionCommand = Command.make("session", {}).pipe(
  Command.withSubcommands([listSessionsCommand, deleteSessionCommand])
).pipe(Command.withDescription("Manage sessions"))

const configShowCommand = Command.make(
  "show",
  {},
  () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      const masked = maskConfig(config)
      yield* Console.log(JSON.stringify(masked, null, 2))
    }).pipe(Effect.provide(loadConfig()))
).pipe(Command.withDescription("Show current config (masked)"))

const configCommand = Command.make("config", {}).pipe(
  Command.withSubcommands([configShowCommand])
).pipe(Command.withDescription("Manage configuration"))

const app = Command.make("prodigy", {}).pipe(
  Command.withDescription("AI coding assistant"),
  Command.withSubcommands([mainCommand, sessionCommand, configCommand])
)

const cli = Command.run(app, {
  version: "0.0.1"
}).pipe(
  Effect.provide(BunServices.layer)
)

BunRuntime.runMain(cli)