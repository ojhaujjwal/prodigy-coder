import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    typecheck: {
      enabled: true,
      include: ["src/**/*.test-d.ts"]
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["src/**/*.test.ts"],
          exclude: ["src/__integration__/**"]
        }
      },
      {
        test: {
          name: "integration",
          include: ["src/__integration__/**/*.test.ts"]
        }
      }
    ]
  }
});
