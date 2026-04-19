import { ChildProcess } from "effect/unstable/process"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Effect, Schema, Stream } from "effect"
import { AiError, Tool } from "effect/unstable/ai"
import { Toolkit } from "effect/unstable/ai"

const ShellParameters = Schema.Struct({
  command: Schema.String,
})

export const ShellTool = Tool.make("shell", {
  description: "Execute a shell command",
  parameters: ShellParameters,
  success: Schema.String,
  dependencies: [ChildProcessSpawner],
})

export type ShellTool = typeof ShellTool

export const shellHandler = (
  { command }: { command: string },
  _context: Toolkit.HandlerContext<typeof ShellTool>,
) =>
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make`bash -c ${command}`
    const exitCode = yield* handle.exitCode

    const outputChunks: string[] = []
    const errorChunks: string[] = []

    const stdoutStream = handle.stdout
    if (stdoutStream) {
      const chunks = yield* stdoutStream.pipe(
        Stream.map((chunk) => new TextDecoder().decode(chunk)),
        Stream.runCollect
      )
      outputChunks.push(...chunks)
    }

    const stderrStream = handle.stderr
    if (stderrStream) {
      const chunks = yield* stderrStream.pipe(
        Stream.map((chunk) => new TextDecoder().decode(chunk)),
        Stream.runCollect
      )
      errorChunks.push(...chunks)
    }

    const combined = outputChunks.join("") + errorChunks.join("")

    if (exitCode === 0) {
      return combined || ""
    }

    return `Command failed with exit code ${exitCode}: ${combined}`
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) =>
      AiError.make({
        module: "ShellTool",
        method: "shellHandler",
        reason: new AiError.UnknownError({ description: String(error) }),
      }),
    ),
  )
