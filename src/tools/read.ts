import * as FileSystem from "effect/FileSystem"
import { Effect, Schema } from "effect"
import { Tool } from "effect/unstable/ai"

const ReadParameters = Schema.Struct({
  filePath: Schema.String,
})

export const ReadTool = Tool.make("read", {
  description: "Read a file's contents",
  parameters: ReadParameters,
  success: Schema.String,
})

export type ReadTool = typeof ReadTool

export const readHandler = ({ filePath }: { filePath: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(filePath)
  })