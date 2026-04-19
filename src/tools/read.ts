import * as FileSystem from "effect/FileSystem"
import { Effect, Schema } from "effect"
import { AiError, Tool } from "effect/unstable/ai"
import { Toolkit } from "effect/unstable/ai"

const ReadParameters = Schema.Struct({
  filePath: Schema.String,
})

export const ReadTool = Tool.make("read", {
  description: "Read a file's contents",
  parameters: ReadParameters,
  success: Schema.String,
  dependencies: [FileSystem.FileSystem],
})

export type ReadTool = typeof ReadTool

export const readHandler = (
  { filePath }: { filePath: string },
  _context: Toolkit.HandlerContext<typeof ReadTool>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(filePath)
  }).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "ReadTool",
        method: "readHandler",
        reason: new AiError.UnknownError({ description: String(error) }),
      }),
    ),
  )
