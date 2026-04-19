import { ChildProcess } from "effect/unstable/process"
import { Effect, Schema, Stream } from "effect"
import { Tool } from "effect/unstable/ai"

const ShellParameters = Schema.Struct({
  command: Schema.String,
})

export const ShellTool = Tool.make("shell", {
  description: "Execute a shell command",
  parameters: ShellParameters,
  success: Schema.String,
})

export type ShellTool = typeof ShellTool

export const shellHandler = ({ command }: { command: string }) =>
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
  })