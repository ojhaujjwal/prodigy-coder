import { definePlugin } from "@oxlint/plugins";
import importExtensions from "./rules/import-extensions.ts";

export default definePlugin({
  meta: { name: "prodigy" },
  rules: {
    "import-extensions": importExtensions
  }
});
