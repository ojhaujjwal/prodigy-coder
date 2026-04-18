import { Schema } from "effect"
import * as fs from "node:fs"
import * as path from "node:path"

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

export const createSession = (systemPrompt?: string): Session => {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }

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
  const filePath = path.join(process.cwd(), SESSION_DIR, `${session.id}.json`)
  const updated = { ...session, updatedAt: new Date() }
  const encoded = Schema.encodeSync(SessionSchema)(updated)
  const json = JSON.stringify(encoded, null, 2)
  fs.writeFileSync(filePath, json, "utf-8")
}

export const loadSession = (id: string): Session => {
  const filePath = path.join(process.cwd(), SESSION_DIR, `${id}.json`)
  const content = fs.readFileSync(filePath, "utf-8")
  const parsed = JSON.parse(content)
  return Schema.decodeUnknownSync(SessionSchema)(parsed)
}

export const listSessions = (): ReadonlyArray<{ id: string; createdAt: Date; updatedAt: Date }> => {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true })
  }

  const dir = path.join(process.cwd(), SESSION_DIR)
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const sessions: { id: string; createdAt: Date; updatedAt: Date }[] = []

  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const id = entry.name.replace(".json", "")
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
  const filePath = path.join(process.cwd(), SESSION_DIR, `${id}.json`)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}