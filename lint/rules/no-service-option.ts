import type { CreateRule, ESTree, Visitor } from "oxlint"

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect.serviceOption - services should always be present in context"
    },
    messages: {
      noServiceOption: "Do not use Effect.serviceOption. Services should always be present in context, even during testing. Yield the service directly (yield* MyService) and ensure it is provided in your layer composition."
    },
    schema: []
  },
  create(context) {
    return {
      CallExpression(node: ESTree.CallExpression) {
        const callee = node.callee
        if (
          callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Effect" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "serviceOption"
        ) {
          context.report({
            node,
            messageId: "noServiceOption"
          })
        }
      }
    } as Visitor
  }
}

export default rule
