import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Argument, Command, Flag } from "effect/unstable/cli"
import { Console, Effect, Layer, Option, Schema } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { AppConfig, loadConfig, maskConfig } from "./config.ts"
import { SessionRepo, createSession, loadSession, type Session } from "./session.ts"
import { createFormatter, type OutputEvent } from "./output.ts"
import { runAgent as runAgentLoop } from "./agent.ts"
import type { AgentConfig } from "./agent.ts"
import { shellHandler } from "./tools/shell.ts"
import { readHandler } from "./tools/read.ts"
import { writeHandler } from "./tools/write.ts"
import { editHandler } from "./tools/edit.ts"
import { grepHandler } from "./tools/grep.ts"
import { globHandler } from "./tools/glob.ts"
import { webfetchHandler } from "./tools/webfetch.ts"
import { buildProviderLayer } from "./provider.ts"
import * as AiError from "effect/unstable/ai/AiError"

const mockContext = { preliminary: () => Effect.void } as unknown

export const createHandlers = (): Record<string, (params: unknown) => Effect.Effect<string>> => ({
  shell: (p) => shellHandler(p as Parameters<typeof shellHandler>[0], mockContext as Parameters<typeof shellHandler>[1]).pipe(Effect.provide(BunServices.layer)) as unknown as Effect.Effect<string>,
  read: (p) => readHandler(p as Parameters<typeof readHandler>[0], mockContext as Parameters<typeof readHandler>[1]).pipe(Effect.provide(BunServices.layer)) as unknown as Effect.Effect<string>,
  write: (p) => writeHandler(p as Parameters<typeof writeHandler>[0], mockContext as Parameters<typeof writeHandler>[1]).pipe(Effect.provide(BunServices.layer)) as unknown as Effect.Effect<string>,
  edit: (p) => editHandler(p as Parameters<typeof editHandler>[0], mockContext as Parameters<typeof editHandler>[1]).pipe(Effect.provide(BunServices.layer)) as unknown as Effect.Effect<string>,
  grep: (p) => grepHandler(p as Parameters<typeof grepHandler>[0], mockContext as Parameters<typeof grepHandler>[1]).pipe(Effect.provide(BunServices.layer), Effect.map((lines) => lines.join("\n"))) as unknown as Effect.Effect<string>,
  glob: (p) => globHandler(p as Parameters<typeof globHandler>[0], mockContext as Parameters<typeof globHandler>[1]).pipe(Effect.provide(BunServices.layer), Effect.map((files) => files.join("\n"))) as unknown as Effect.Effect<string>,
  webfetch: (p) => webfetchHandler(p as Parameters<typeof webfetchHandler>[0], mockContext as Parameters<typeof webfetchHandler>[1]).pipe(Effect.provide(BunServices.layer)) as unknown as Effect.Effect<string>,
})

const runAgent = (
  prompt: string,
  sessionId: Option.Option<string>,
  config: import("./config.ts").ConfigData
): Effect.Effect<OutputEvent[], AiError.AiError | Error> => {
  const sessionEffect: Effect.Effect<Session, never> = Option.match(sessionId, {
    onNone: () => createSession(config.systemPrompt) as Effect.Effect<Session, never>,
    onSome: (id) => loadSession(id) as Effect.Effect<Session, never>,
  })

  return Effect.gen(function* () {
    const session = yield* sessionEffect

    const handlers = createHandlers()
    const agentConfig: AgentConfig = { session, config, handlers }
    const providerLayer = buildProviderLayer(config.provider).pipe(
      Layer.provide(BunServices.layer),
      Layer.provide(FetchHttpClient.layer)
    )

    return yield* runAgentLoop(prompt, agentConfig, providerLayer)
  }).pipe(
    Effect.provide(
      SessionRepo.layer.pipe(
        Layer.provide(BunServices.layer)
      )
    )
  )
}

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
  Flag.withDescription("Session ID to load"),
  Flag.optional
)

const modelFlag = Flag.string("model").pipe(
  Flag.withAlias("m"),
  Flag.withDescription("Model name"),
  Flag.optional
)

const maxTurnsFlag = Flag.integer("max-turns").pipe(
  Flag.withAlias("t"),
  Flag.withDescription("Maximum number of turns"),
  Flag.optional
)

const approvalModeFlag = Flag.choice("approval-mode", ["none", "dangerous", "all"]).pipe(
  Flag.withAlias("a"),
  Flag.withDescription("Approval mode"),
  Flag.optional
)

const systemPromptFlag = Flag.string("system-prompt").pipe(
  Flag.withDescription("System prompt"),
  Flag.optional
)

const configFlag = Flag.string("config").pipe(
  Flag.withDescription("Config file path"),
  Flag.optional
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
      const appConfig = yield* AppConfig
      const sessionId = session

      const promptText = Option.getOrElse(prompt, () => "")
      if (!promptText) {
        yield* Console.log("No prompt provided. Use --prompt or pipe input.")
        return
      }

      const format = outputFormat as "text" | "stream-json"
      const formatter = createFormatter(format)
      const outputEvents = yield* runAgent(promptText, sessionId, appConfig)

      for (const event of outputEvents) {
        yield* formatter(event)
      }
    }).pipe(
      Effect.provide(
        (Option.getOrElse(config, () => "") ? loadConfig(Option.getOrElse(config, () => "")) : loadConfig()).pipe(
          Layer.merge(SessionRepo.layer)
        )
      )
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

const sessionCommand = Command.make("session", {}, () => Effect.void).pipe(
  Command.withSubcommands([listSessionsCommand, deleteSessionCommand]),
  Command.withDescription("Manage sessions")
)

const configShowCommand = Command.make(
  "show",
  {},
  () =>
    Effect.gen(function* () {
      const config = yield* AppConfig
      const masked = maskConfig(config)
      const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(masked)
      yield* Console.log(json)
    }).pipe(Effect.provide(loadConfig()))
).pipe(Command.withDescription("Show current config (masked)"))

const configCommand = Command.make("config", {}, () => Effect.void).pipe(
  Command.withSubcommands([configShowCommand]),
  Command.withDescription("Manage configuration")
)

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