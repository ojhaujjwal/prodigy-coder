import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Effect, Schema, Stream } from "effect"
import { AiError, Tool } from "effect/unstable/ai"
import { Toolkit } from "effect/unstable/ai"

const GrepParameters = Schema.Struct({
  pattern: Schema.String,
  path: Schema.String,
})

export const GrepTool = Tool.make("grep", {
  description: "Search for text patterns in files",
  parameters: GrepParameters,
  success: Schema.Array(Schema.String),
  dependencies: [ChildProcessSpawner],
})

export type GrepTool = typeof GrepTool

export const grepHandler = (
  { pattern, path }: { pattern: string; path: string },
  _context: Toolkit.HandlerContext<typeof GrepTool>,
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make`rg --hidden --no-heading --line-number ${pattern} ${path}`
    const exitCode = yield* handle.exitCode

    const chunks: string[] = []
    const stdoutStream = handle.stdout
    if (stdoutStream) {
      const output = yield* stdoutStream.pipe(
        Stream.map((chunk) => new TextDecoder().decode(chunk)),
        Stream.runCollect
      )
      chunks.push(...output)
    }

    const combined = chunks.join("")
    const lines = combined.split("\n").filter((line) => line.length > 0)

    if (exitCode === 0 || lines.length > 0) {
      return lines
    }

    return []
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      AiError.make({
        module: "GrepTool",
        method: "grepHandler",
        reason: new AiError.UnknownError({ description: String(error) }),
      }),
    ),
  )
