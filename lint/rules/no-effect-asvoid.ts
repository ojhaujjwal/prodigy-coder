import type { CreateRule, ESTree, Visitor } from "oxlint"

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect.asVoid - it is usually unnecessary"
    },
    messages: {
      noEffectAsVoid: "Effect.asVoid is usually unnecessary. The `void` return type already allows any value to be returned from an effect. Remove it."
    },
    schema: []
  },
  create(context) {
    return {
      MemberExpression(node: ESTree.MemberExpression) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "Effect" &&
          node.property.type === "Identifier" &&
          node.property.name === "asVoid"
        ) {
          context.report({
            node,
            messageId: "noEffectAsVoid"
          })
        }
      }
    } as Visitor
  }
}

export default rule
