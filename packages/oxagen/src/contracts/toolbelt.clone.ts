// clone_toolbelt — copy a toolbelt into a new custom belt (ADR-192, #4369).
//
// The clone holds every tool the source holds, each active as it is in the
// source. Cloning the All tools belt copies every available tool with its
// workspace default. The slug is derived from the name unless one is given;
// a slug another live belt holds is refused with `conflict`, reason
// `toolbelt_slug_taken`.
//
// A settings write, outside the metering surface: `noBillingGate: true`.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  toolbeltIdSchema,
  toolbeltRefSchema,
  toolbeltSlugSchema,
} from "./toolbelt.shared";

export const toolbeltClone = registerCapability({
  name: "clone_toolbelt",
  domain: "toolbelt",
  description:
    "Copy a toolbelt into a new belt you can edit: every tool the source holds, each active as it is in the source. The slug is derived from the name unless one is given.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "tools" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow" },
  },
  input: z
    .object({
      toolbeltId: toolbeltIdSchema,
      name: z.string().trim().min(1).max(128),
      /** Derived from `name` when absent. */
      slug: toolbeltSlugSchema.optional(),
      description: z.string().trim().max(1024).optional(),
    })
    .strict(),
  output: z
    .object({
      toolbelt: toolbeltRefSchema,
    })
    .strict(),
});
