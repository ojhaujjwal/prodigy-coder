import type { ESTree } from "@oxlint/plugins";
import { defineRule } from "@oxlint/plugins";

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow node: imports since this project uses @effect/platform for platform-agnostic code"
    },
    messages: {
      noNodeImport: "Do not use 'node:' imports. Use @effect/platform instead for platform-agnostic code."
    },
    schema: []
  },
  create(context) {
    function checkImportSource(node: ESTree.Node, source: string | null | undefined) {
      if (!source || typeof source !== "string") return;

      if (source.startsWith("node:")) {
        context.report({
          node,
          messageId: "noNodeImport"
        });
      }
    }

    return {
      ImportDeclaration(node) {
        checkImportSource(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) {
          checkImportSource(node, node.source.value);
        }
      },
      ExportAllDeclaration(node) {
        checkImportSource(node, node.source.value);
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === "Identifier" && callee.name === "require") {
          const arg = node.arguments[0];
          if (arg && arg.type === "Literal" && typeof arg.value === "string") {
            checkImportSource(node, arg.value);
          }
        }
      }
    };
  }
});
