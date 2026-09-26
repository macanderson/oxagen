// create_runtime — name a runtime in this workspace (ADR-198, #4369). A
// runtime is a named place agents run: a laptop, a VM, a cloud workspace. It
// holds no machine facts. A host enrollment binds a machine to it later, and
// the runtime keeps its id when that machine is replaced.
//
// The slug is derived from the name by `slugFromName` unless the caller types
// one: spaces become hyphens and every other special character, apostrophes
// included, is dropped ("Mac's Laptop" becomes `macs-laptop`). A slug another
// live runtime in the workspace holds is refused with `conflict`, reason
// `runtime_slug_taken`.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner or Admin, checked by the handler (INV-29), the same bar
// `register_agent` sets, because adding a runtime is the first step of
// enrolling one.
import { z } from "zod";
import { registerCapability } from "../registry";
import { runtimeRefSchema, runtimeSlugSchema } from "./runtime.shared";

export const runtimeCreate = registerCapability({
  name: "create_runtime",
  domain: "runtime",
  description:
    "Name a runtime in this workspace: a laptop, a VM or a cloud workspace agents run on. The slug is derived from the name unless one is given. Register an agent on it next.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  // `app`: the Runtimes page's Add a runtime dialog (apps/app features/runtimes).
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "identity" },
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: {},
  },
  input: z
    .object({
      name: z.string().trim().min(1).max(128),
      /** Derived from `name` when absent. */
      slug: runtimeSlugSchema.optional(),
    })
    .strict(),
  output: z
    .object({
      runtime: runtimeRefSchema,
    })
    .strict(),
});
