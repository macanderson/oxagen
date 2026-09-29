import { z } from "zod";
import { registerCapability } from "../registry";
import { slackChannelViewSchema } from "./org.slack_connection.shared";

/**
 * list_slack_channels: list the channels the connected Slack workspace offers
 * for notices (#4608).
 *
 * The handler calls `conversations.list` with the stored bot token and returns
 * public and private channels that are not archived, sorted by name. A private
 * channel appears only when the Oxagen bot is already a member. The handler
 * stops after a fixed number of pages and says so with `truncated`.
 */
export const orgSlackChannelsList = registerCapability({
  name: "list_slack_channels",
  domain: "org",
  description:
    "List the channels in the organization's connected Slack workspace that steering notices can post to, sorted by name.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "app", "unit", "docs"],
  scoped: false,
  noBillingGate: true,
  // A read of Slack, not of Oxagen state. Declared so `kernelRead` accepts it.
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z.object({}).strict(),
  output: z.object({
    channels: z.array(slackChannelViewSchema).max(2000),
    /** True when the workspace has more channels than the handler read. */
    truncated: z.boolean(),
  }),
});

export type OrgSlackChannelsListInput = z.output<
  typeof orgSlackChannelsList.input
>;
export type OrgSlackChannelsListOutput = z.output<
  typeof orgSlackChannelsList.output
>;
