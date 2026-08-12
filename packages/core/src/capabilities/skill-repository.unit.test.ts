import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { SkillName } from "./skill-repository.ts";

describe("SkillName", () => {
  it.each(["Grill-Me", "my_skill", "my skill", "... "])("accepts directory name %s", (name) => {
    expect(Schema.decodeUnknownSync(SkillName)(name)).toBe(name);
  });

  it.each(["", ".", "..", "tools/read", "tools\\read"])("rejects path-like name %s", (name) => {
    expect(() => Schema.decodeUnknownSync(SkillName)(name)).toThrow();
  });
});
