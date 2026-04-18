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

export default {
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
    "no-void-expression": noVoidExpression
  }
}
