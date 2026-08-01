import { layer, expect } from "@effect/vitest";
import { Effect } from "effect";
import * as FileSystem from "effect/FileSystem";
import { layer as bunServicesLayer } from "@effect/platform-bun/BunServices";
import { writeHandler } from "./write.ts";

const mockContext = {
  preliminary: () => Effect.void
};

layer(bunServicesLayer)("write tool", (it) => {
  it.effect("creates new file with correct content", () =>
    Effect.gen(function* () {
      const result = yield* writeHandler({ filePath: "/tmp/test-write.txt", content: "Test content" }, mockContext);
      expect(result).toBe("Written to /tmp/test-write.txt");
      const fs = yield* FileSystem.FileSystem;
      const content = yield* fs.readFileString("/tmp/test-write.txt");
      expect(content).toBe("Test content");
    })
  );

  it.effect("overwrites existing file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString("/tmp/test-write2.txt", "Original");
      yield* writeHandler({ filePath: "/tmp/test-write2.txt", content: "Updated" }, mockContext);
      const content = yield* fs.readFileString("/tmp/test-write2.txt");
      expect(content).toBe("Updated");
    })
  );

  it.effect("creates parent directories", () =>
    Effect.gen(function* () {
      const result = yield* writeHandler({ filePath: "/tmp/test-dir/nested/file.txt", content: "Nested" }, mockContext);
      expect(result.includes("Written to")).toBe(true);
      const fs = yield* FileSystem.FileSystem;
      const content = yield* fs.readFileString("/tmp/test-dir/nested/file.txt");
      expect(content).toBe("Nested");
    })
  );
});
