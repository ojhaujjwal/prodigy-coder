import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Effect, Schema, Stream } from "effect"
import { AiError, Tool } from "effect/unstable/ai"
import { Toolkit } from "effect/unstable/ai"

const GlobParameters = Schema.Struct({
  pattern: Schema.String,
  path: Schema.String,
})

export const GlobTool = Tool.make("glob", {
  description: "Find files matching a glob pattern",
  parameters: GlobParameters,
  success: Schema.Array(Schema.String),
  dependencies: [ChildProcessSpawner],
})

export type GlobTool = typeof GlobTool

export const globHandler = (
  { pattern, path }: { pattern: string; path: string },
  _context: Toolkit.HandlerContext<typeof GlobTool>,
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make`find ${path} -name ${pattern} -type f`

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
    const files = combined.split("\n").filter((line) => line.length > 0)

    return files
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      AiError.make({
        module: "GlobTool",
        method: "globHandler",
        reason: new AiError.UnknownError({ description: String(error) }),
      }),
    ),
  )
