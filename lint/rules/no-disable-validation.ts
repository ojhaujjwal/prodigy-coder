import type { CreateRule, ESTree, Visitor } from "oxlint"

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow disableValidation: true in Schema operations"
    },
    messages: {
      noDisableValidation: "Do not use { disableValidation: true }. Schema validation should always be enabled to catch invalid data. If you're seeing validation errors, fix the data or schema instead of disabling validation."
    },
    schema: []
  },
  create(context) {
    return {
      Property(node: ESTree.Property) {
        if (
          node.key &&
          ((node.key.type === "Identifier" && node.key.name === "disableValidation") ||
           (node.key.type === "Literal" && node.key.value === "disableValidation")) &&
          node.value &&
          node.value.type === "Literal" &&
          node.value.value === true
        ) {
          context.report({
            node,
            messageId: "noDisableValidation"
          })
        }
      }
    } as Visitor
  }
}

export default rule
