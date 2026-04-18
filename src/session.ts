import { Schema } from "effect"

export const Message = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String,
})
export type Message = typeof Message.Type

export const SessionSchema = Schema.Struct({
  id: Schema.String,
  messages: Schema.Array(Message),
  createdAt: Schema.Date,
  updatedAt: Schema.Date,
})
export type Session = typeof SessionSchema.Type

const SESSION_DIR = ".prodigy-coder/sessions"

const dirExists = (path: string): boolean => {
  const result = Bun.spawnSync(["test", "-d", path])
  return result.exitCode === 0
}

const fileExists = (path: string): boolean => {
  const result = Bun.spawnSync(["test", "-f", path])
  return result.exitCode === 0
}

const readFileSync = (path: string): string => {
  const result = Bun.spawnSync(["cat", path])
  return new TextDecoder().decode(result.stdout)
}

const writeFileSync = (path: string, content: string): void => {
  Bun.write(path, content)
}

const listJsonFilesSync = (dir: string): string[] => {
  const result = Bun.spawnSync(["find", dir, "-name", "*.json", "-type", "f"])
  if (result.exitCode !== 0) {
    return []
  }
  const output = new TextDecoder().decode(result.stdout).trim()
  if (!output) return []
  return output.split("\n").filter((f: string) => f.endsWith(".json"))
}

const ensureSessionDirSync = (): void => {
  if (!dirExists(SESSION_DIR)) {
    const proc = Bun.spawnSync(["mkdir", "-p", SESSION_DIR])
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to create session directory: ${SESSION_DIR}`)
    }
  }
}

export const createSession = (systemPrompt?: string): Session => {
  ensureSessionDirSync()

  const id = crypto.randomUUID()
  const now = new Date()

  const messages: Message[] = []
  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt })
  }

  return {
    id,
    messages,
    createdAt: now,
    updatedAt: now,
  }
}

export const saveSession = (session: Session): void => {
  const filePath = `${process.cwd()}/${SESSION_DIR}/${session.id}.json`
  const updated = { ...session, updatedAt: new Date() }
  const encoded = Schema.encodeSync(SessionSchema)(updated)
  const json = JSON.stringify(encoded, null, 2)
  writeFileSync(filePath, json)
}

export const loadSession = (id: string): Session => {
  const filePath = `${process.cwd()}/${SESSION_DIR}/${id}.json`
  const content = readFileSync(filePath)
  const parsed = JSON.parse(content) as unknown
  return Schema.decodeUnknownSync(SessionSchema)(parsed)
}

export const listSessions = (): ReadonlyArray<{ id: string; createdAt: Date; updatedAt: Date }> => {
  ensureSessionDirSync()

  const entries = listJsonFilesSync(SESSION_DIR)

  const sessions: { id: string; createdAt: Date; updatedAt: Date }[] = []

  for (const entry of entries) {
    if (entry.endsWith(".json")) {
      const id = entry.replace(`${SESSION_DIR}/`, "").replace(".json", "")
      try {
        const session = loadSession(id)
        sessions.push({
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        })
      } catch {
        // skip invalid session files
      }
    }
  }

  return sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
}

export const deleteSession = (id: string): void => {
  const filePath = `${process.cwd()}/${SESSION_DIR}/${id}.json`
  if (fileExists(filePath)) {
    const proc = Bun.spawnSync(["rm", filePath])
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to delete session: ${id}`)
    }
  }
}