import { expect, it } from "vitest";
import { packageName, type CorePackage } from "@prodigy/core";

it("exposes an import-safe public package boundary", () => {
  const packageInfo: CorePackage = { packageName, status: "scaffold" };

  expect(packageInfo).toEqual({ packageName: "@prodigy/core", status: "scaffold" });
});
