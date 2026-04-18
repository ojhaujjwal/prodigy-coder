import type { CreateRule, ESTree, Visitor } from "oxlint"

const rule: CreateRule = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow nested Layer.provide calls"
    },
    messages: {
      nestedProvide: "Nested Layer.provide detected. Extract the inner Layer.provide to a separate variable or use Layer.provideMerge."
    },
    schema: []
  },
  create(context) {
    function isLayerProvide(node: ESTree.Node): boolean {
      if (node.type !== "CallExpression") return false
      const callee = node.callee
      return (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "Layer" &&
        callee.property.type === "Identifier" &&
        callee.property.name === "provide"
      )
    }

    return {
      CallExpression(node: ESTree.CallExpression) {
        if (!isLayerProvide(node)) return

        for (const arg of node.arguments) {
          if (isLayerProvide(arg)) {
            context.report({
              node: arg,
              messageId: "nestedProvide"
            })
          }
        }
      }
    } as Visitor
  }
}

export default rule
