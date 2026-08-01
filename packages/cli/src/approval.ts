import type { ApprovalMode } from "./config.ts";

const DANGEROUS_TOOLS = new Set(["shell"]);

export const needsApproval = (toolName: string, mode: ApprovalMode): boolean => {
  switch (mode) {
    case "none":
      return false;
    case "dangerous":
      return DANGEROUS_TOOLS.has(toolName);
    case "all":
      return true;
  }
};
