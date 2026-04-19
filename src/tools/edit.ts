import * as FileSystem from "effect/FileSystem"
import { Effect, Schema } from "effect"
import { AiError, Tool } from "effect/unstable/ai"
import { Toolkit } from "effect/unstable/ai"

const EditParameters = Schema.Struct({
  filePath: Schema.String,
  oldString: Schema.String,
  newString: Schema.String,
})

export const EditTool = Tool.make("edit", {
  description: "Edit a file by replacing text",
  parameters: EditParameters,
  success: Schema.String,
  dependencies: [FileSystem.FileSystem],
})

export type EditTool = typeof EditTool

export const editHandler = (
  { filePath, oldString, newString }: { filePath: string; oldString: string; newString: string },
  _context: Toolkit.HandlerContext<typeof EditTool>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs.readFileString(filePath)

    const index = content.indexOf(oldString)
    if (index === -1) {
      return `Error: oldString not found in file: ${oldString}`
    }

    const newContent = content.slice(0, index) + newString + content.slice(index + oldString.length)
    yield* fs.writeFileString(filePath, newContent)
    return `Edited ${filePath}`
  }).pipe(
    Effect.mapError((error) =>
      AiError.make({
        module: "EditTool",
        method: "editHandler",
        reason: new AiError.UnknownError({ description: String(error) }),
      }),
    ),
  )
