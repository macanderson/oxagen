import { z } from "zod";
import { registerCapability } from "../registry";
import { slackConnectionViewSchema } from "./org.slack_connection.shared";

/**
 * delete_slack_connection: disconnect the organization's Slack workspace
 * (#4608).
 *
 * The handler removes the stored bot token and the picked channel, then asks
 * Slack to revoke the token. A failed revoke does not undo the disconnect:
 * Oxagen no longer holds the token either way. Deleting when nothing is
 * connected succeeds and changes nothing.
 */
export const orgSlackConnectionDelete = registerCapability({
  name: "delete_slack_connection",
  domain: "org",
  description:
    "Disconnect the organization's Slack workspace. Removes the stored bot token and the picked channel, and asks Slack to revoke the token.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "app", "unit", "docs"],
  scoped: false,
  orgLevel: true,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({}).strict(),
  output: slackConnectionViewSchema,
});

export type OrgSlackConnectionDeleteInput = z.output<
  typeof orgSlackConnectionDelete.input
>;
export type OrgSlackConnectionDeleteOutput = z.output<
  typeof orgSlackConnectionDelete.output
>;
