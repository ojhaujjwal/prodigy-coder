import type { CreateRule, ESTree, Visitor } from "oxlint"

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect.catchAllCause - it catches defects which should not be caught"
    },
    messages: {
      noEffectCatchAllCause: "Do not use Effect.catchAllCause. It catches defects (bugs) which should crash the program. Use Effect.catchAll or Effect.catchTag to handle expected errors only."
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
          node.property.name === "catchAllCause"
        ) {
          context.report({
            node,
            messageId: "noEffectCatchAllCause"
          })
        }
      }
    } as Visitor
  }
}

export default rule
