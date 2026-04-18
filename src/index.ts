import * as fs from "node:fs"
import { loadConfig, maskConfig, type Config } from "./config.ts"
import { createSession, loadSession, listSessions, deleteSession, type Session } from "./session.ts"
import { createFormatter, type OutputEvent } from "./output.ts"

const runAgent = (
  prompt: string,
  session: Session,
  config: Config,
  format: "text" | "stream-json"
): void => {
  const formatter = createFormatter(format)
  formatter({ type: "text-delta", delta: `Processing: ${prompt}\n` } as OutputEvent)
  formatter({ type: "finish", text: "Agent completed (stub)" } as OutputEvent)
}

const mainCommand = (args: {
  prompt?: string
  print?: boolean
  outputFormat: "text" | "stream-json"
  session?: string
  model?: string
  maxTurns?: number
  approvalMode?: "none" | "dangerous" | "all"
  systemPrompt?: string
  configPath?: string
}): void => {
  let config = loadConfig(args.configPath)

  if (args.model) {
    config = { ...config, provider: { ...config.provider, model: args.model } }
  }
  if (args.maxTurns) {
    config = { ...config, maxTurns: args.maxTurns }
  }
  if (args.approvalMode) {
    config = { ...config, approvalMode: args.approvalMode }
  }
  if (args.systemPrompt) {
    config = { ...config, systemPrompt: args.systemPrompt }
  }

  const sessionId = args.session
  let session: Session

  if (sessionId) {
    session = loadSession(sessionId)
  } else {
    session = createSession(config.systemPrompt)
  }

  let prompt = args.prompt
  if (!prompt) {
    prompt = fs.readFileSync("/dev/stdin", "utf-8")
  }

  const format = args.outputFormat ?? "text"
  runAgent(prompt, session, config, format)
}

const listSessionsCommand = (): void => {
  const sessions = listSessions()
  if (sessions.length === 0) {
    console.log("No sessions found")
  } else {
    for (const session of sessions) {
      console.log(`${session.id} | Created: ${session.createdAt.toISOString()} | Updated: ${session.updatedAt.toISOString()}`)
    }
  }
}

const deleteSessionCommand = (id: string): void => {
  deleteSession(id)
  console.log(`Deleted session ${id}`)
}

const configShowCommand = (): void => {
  const config = loadConfig()
  const masked = maskConfig(config)
  console.log(JSON.stringify(masked, null, 2))
}

const printUsage = (): void => {
  console.log("Usage: prodigy [--prompt <text>] [--print] [--output-format text|stream-json]")
  console.log("       [--session <id>] [--model <name>] [--max-turns <n>] [--approval-mode none|dangerous|all]")
  console.log("       [--system-prompt <text>] [--config <path>]")
  console.log("")
  console.log("Subcommands:")
  console.log("  session list                   - List all sessions")
  console.log("  session delete <id>           - Delete a session")
  console.log("  config show                   - Show current config (masked)")
}

const printSessionUsage = (): void => {
  console.log("Usage: prodigy session [list|delete <id>]")
}

const printConfigUsage = (): void => {
  console.log("Usage: prodigy config show")
}

const parseArgs = (argv: string[]): { command: string; args: Record<string, unknown> } => {
  const command = argv[2] || "main"
  const args: Record<string, unknown> = { outputFormat: "text" }

  for (let i = 3; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--prompt" || arg === "-p") {
      args.prompt = argv[++i]
    } else if (arg === "--print") {
      args.print = true
    } else if (arg === "--output-format" || arg === "-f") {
      args.outputFormat = argv[++i] as "text" | "stream-json"
    } else if (arg === "--session" || arg === "-s") {
      args.session = argv[++i]
    } else if (arg === "--model" || arg === "-m") {
      args.model = argv[++i]
    } else if (arg === "--max-turns" || arg === "-t") {
      args.maxTurns = parseInt(argv[++i], 10)
    } else if (arg === "--approval-mode" || arg === "-a") {
      args.approvalMode = argv[++i] as "none" | "dangerous" | "all"
    } else if (arg === "--system-prompt") {
      args.systemPrompt = argv[++i]
    } else if (arg === "--config") {
      args.configPath = argv[++i]
    } else if (arg === "--help" || arg === "-h") {
      printUsage()
      process.exit(0)
    }
  }

  return { command, args }
}

const main = (argv: string[]): void => {
  const { command, args } = parseArgs(argv)

  if (command === "session") {
    const subcommand = argv[3]
    if (subcommand === "list") {
      listSessionsCommand()
    } else if (subcommand === "delete") {
      const id = argv[4]
      if (!id) {
        printSessionUsage()
        process.exit(1)
      }
      deleteSessionCommand(id)
    } else {
      printSessionUsage()
      process.exit(1)
    }
  } else if (command === "config") {
    const subcommand = argv[3]
    if (subcommand === "show") {
      configShowCommand()
    } else {
      printConfigUsage()
      process.exit(1)
    }
  } else if (command === "main" || !command) {
    mainCommand(args as Parameters<typeof mainCommand>[0])
  } else {
    printUsage()
    process.exit(1)
  }
}

main(process.argv)