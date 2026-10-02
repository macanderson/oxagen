import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * start_slack_connection: begin connecting the organization's Slack workspace
 * (#4608).
 *
 * The handler stores a one-time state nonce bound to the organization and the
 * acting person, then returns Slack's authorize URL. The app sends the
 * browser there. Slack sends it back to `/api/slack/oauth/callback`, which
 * calls authorize_slack_connection with the state and the code.
 *
 * Organization-level (`scoped: false`) and Owner or Admin only. The app is its
 * only surface: a connection needs a browser to consent in Slack.
 */
export const orgSlackConnectionStart = registerCapability({
  name: "start_slack_connection",
  domain: "org",
  description:
    "Start connecting the organization's Slack workspace, so steering repo health changes post to a Slack channel. Returns the Slack URL where an Owner or Admin approves the Oxagen app.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "app", "unit", "docs"],
  scoped: false,
  orgLevel: true,
  // Connecting Slack is governance, not AI usage. It consumes no credits.
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({}).strict(),
  output: z.object({ authorizeUrl: z.string().url().max(2048) }),
});

export type OrgSlackConnectionStartInput = z.output<
  typeof orgSlackConnectionStart.input
>;
export type OrgSlackConnectionStartOutput = z.output<
  typeof orgSlackConnectionStart.output
>;
