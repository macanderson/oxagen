/**
 * `read_steering`: read one steering record, or one file from a skill's
 * folder, as the model reads it (steering-repo-spec, Agent use).
 *
 * A record comes back as a heading with its label, then the body with its
 * @tool: mentions rendered for each tool's exposure mode. The frontmatter
 * never comes back. The workspace's record wins over an organization record
 * of the same lineage. A lineage neither published version holds refuses as
 * `not_found: steering_record_not_found`, and a file the skill's folder does
 * not hold refuses as `not_found: steering_file_not_found`.
 *
 * The spec proposed the name `steering_read`. ADR-025 puts the verb first, so
 * the capability is `read_steering`, the name of the function that answers it
 * in @oxagen/steering-bundle.
 */
import { registerCapability } from "../registry";
import {
  steeringReadInputSchema,
  steeringReadOutputSchema,
} from "../steering-repo/steering-tools";

export const steeringRead = registerCapability({
  name: "read_steering",
  domain: "context",
  description:
    "Read one steering record from the workspace's or the organization's published steering: a heading with its label, then its body. With file, read that file from a skill's folder instead. The workspace's record wins over an organization record of the same lineage. Find a lineage with search_steering.",
  mode: "sync",
  surfaces: ["mcp"],
  layers: ["schema", "mcp", "unit", "docs"],
  scoped: true,
  // Every record an agent follows is read through this call. Metering it
  // would bill a customer for the steering their own workspace published.
  noBillingGate: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "context" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  // A Viewer may call it too: it reads steering the workspace already
  // published and changes nothing.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: steeringReadInputSchema,
  output: steeringReadOutputSchema,
});
