import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { WorkspacePath } from "./workspace.ts";

describe("WorkspacePath", () => {
  it("accepts non-empty relative paths without normalizing them", () => {
    expect(Schema.decodeUnknownSync(WorkspacePath)("src/./index.ts")).toBe("src/./index.ts");
    expect(Schema.decodeUnknownSync(WorkspacePath)("src//index.ts")).toBe("src//index.ts");
  });

  it.each(["/etc/passwd", "\\\\server\\share", "C:\\workspace", "C:workspace", "../secrets", "src/../secrets"])(
    "rejects unsafe path %s",
    (path) => {
      expect(() => Schema.decodeUnknownSync(WorkspacePath)(path)).toThrow();
    }
  );
});
