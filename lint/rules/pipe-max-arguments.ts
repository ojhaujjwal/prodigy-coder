import type { CreateRule, ESTree, Visitor } from "oxlint"

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow .pipe() with more than 20 arguments"
    },
    messages: {
      tooManyArgs: ".pipe() has {{count}} arguments. Consider splitting into multiple .pipe() calls for readability (max 20)."
    },
    schema: []
  },
  create(context) {
    return {
      CallExpression(node: ESTree.CallExpression) {
        const callee = node.callee
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "pipe"
        ) {
          if (node.arguments.length > 20) {
            context.report({
              node,
              messageId: "tooManyArgs",
              data: { count: node.arguments.length }
            })
          }
        }
      }
    } as Visitor
  }
}

export default rule
