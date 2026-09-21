import { z } from "zod";
import { registerCapability } from "../registry";
import {
  configurationCloneDraftSchema,
  configurationKindSchema,
} from "../configuration-clone";

export const configurationCloneGet = registerCapability({
  name: "get_clone_draft",
  domain: "configuration",
  mode: "sync",
  description:
    "Read a configuration into an editable clone draft with a new suggested name and slug. Copies no identity-bound access and changes nothing.",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z
    .object({
      kind: configurationKindSchema,
      sourceId: z.string().min(1).max(200),
    })
    .strict(),
  output: configurationCloneDraftSchema,
});
