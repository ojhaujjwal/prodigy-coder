import { describe, it, expect } from "@effect/vitest";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices";
import { editHandler } from "./edit.ts";

const testLayer = bunServicesLayer;

const mockContext = {
  preliminary: () => Effect.void
};

describe("edit tool", () => {
  it.effect("replaces oldString with newString in file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString("/tmp/test-edit.txt", "Hello, world!");
      const result = yield* editHandler(
        { filePath: "/tmp/test-edit.txt", oldString: "world", newString: "universe" },
        mockContext
      );
      expect(result).toBe("Edited /tmp/test-edit.txt");
      const content = yield* fs.readFileString("/tmp/test-edit.txt");
      expect(content).toBe("Hello, universe!");
    }).pipe(Effect.provide(testLayer))
  );

  it.effect("returns error when oldString not found in file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString("/tmp/test-edit2.txt", "Hello, world!");
      const result = yield* editHandler(
        { filePath: "/tmp/test-edit2.txt", oldString: "goodbye", newString: "hello" },
        mockContext
      );
      expect(result.includes("Error: oldString not found")).toBe(true);
    }).pipe(Effect.provide(testLayer))
  );

  it.effect("returns error when file doesn't exist", () =>
    Effect.gen(function* () {
      const result = yield* editHandler(
        { filePath: "/tmp/non-existent-12345.txt", oldString: "test", newString: "new" },
        mockContext
      ).pipe(Effect.catch((e) => Effect.succeed(`Error: ${e}`)));
      expect(result.includes("Error")).toBe(true);
    }).pipe(Effect.provide(testLayer))
  );
});
