import { definePlugin } from "@oxlint/plugins"
import noEffectIgnore from "./rules/no-effect-ignore.ts"
import noEffectCatchallcause from "./rules/no-effect-catchallcause.ts"
import noEffectAsvoid from "./rules/no-effect-asvoid.ts"
import noSilentErrorSwallow from "./rules/no-silent-error-swallow.ts"
import noServiceOption from "./rules/no-service-option.ts"
import noNestedLayerProvide from "./rules/no-nested-layer-provide.ts"
import pipeMaxArguments from "./rules/pipe-max-arguments.ts"
import preferOptionFromNullable from "./rules/prefer-option-from-nullable.ts"
import importExtensions from "./rules/import-extensions.ts"
import noDisableValidation from "./rules/no-disable-validation.ts"
import noVoidExpression from "./rules/no-void-expression.ts"
import noNodeImports from "./rules/no-node-imports.ts"
import noProcess from "./rules/no-process.ts"
import noBunGlobals from "./rules/no-bun-globals.ts"
import noConsole from "./rules/no-console.ts"
import noPlainItWithEffect from "./rules/no-plain-it-with-effect.ts"
import noVitestModifiers from "./rules/no-vitest-modifiers.ts"

export default definePlugin({
  meta: { name: "prodigy" },
  rules: {
    "no-effect-ignore": noEffectIgnore,
    "no-effect-catchallcause": noEffectCatchallcause,
    "no-effect-asvoid": noEffectAsvoid,
    "no-silent-error-swallow": noSilentErrorSwallow,
    "no-service-option": noServiceOption,
    "no-nested-layer-provide": noNestedLayerProvide,
    "pipe-max-arguments": pipeMaxArguments,
    "prefer-option-from-nullable": preferOptionFromNullable,
    "import-extensions": importExtensions,
    "no-disable-validation": noDisableValidation,
    "no-void-expression": noVoidExpression,
    "no-node-imports": noNodeImports,
    "no-process": noProcess,
    "no-bun-globals": noBunGlobals,
    "no-console": noConsole,
    "no-plain-it-with-effect": noPlainItWithEffect,
    "no-vitest-modifiers": noVitestModifiers
  }
})