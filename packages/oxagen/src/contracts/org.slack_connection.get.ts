import { z } from "zod";
import { registerCapability } from "../registry";
import { slackConnectionViewSchema } from "./org.slack_connection.shared";

/**
 * get_slack_connection: read the organization's Slack connection (#4608).
 *
 * Returns whether this deployment can connect Slack at all, which Slack
 * workspace is connected, the channel notices go to, and the last post that
 * failed for a reason only a person can fix. The bot token never leaves the
 * server, and the output schema strips anything a handler adds by mistake.
 */
export const orgSlackConnectionGet = registerCapability({
  name: "get_slack_connection",
  domain: "org",
  description:
    "Read the organization's Slack connection: whether Slack can be connected, the connected Slack workspace, the channel steering notices post to, and the last post Slack refused. Never returns the token.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "app", "unit", "docs"],
  scoped: false,
  noBillingGate: true,
  // A pure read. Declared so the app's `kernelRead` accepts it.
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({}).strict(),
  output: slackConnectionViewSchema,
});

export type OrgSlackConnectionGetInput = z.output<
  typeof orgSlackConnectionGet.input
>;
export type OrgSlackConnectionGetOutput = z.output<
  typeof orgSlackConnectionGet.output
>;
