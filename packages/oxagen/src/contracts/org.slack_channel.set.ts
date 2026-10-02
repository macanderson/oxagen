import { z } from "zod";
import { registerCapability } from "../registry";
import {
  slackChannelIdSchema,
  slackConnectionViewSchema,
} from "./org.slack_connection.shared";

/**
 * set_slack_channel: pick the channel steering notices post to (#4608).
 *
 * The handler asks Slack for the channel with `conversations.info`, refuses an
 * archived or unknown channel, and stores its id, name and privacy with the
 * connection. Picking a channel clears the last failure on record.
 */
export const orgSlackChannelSet = registerCapability({
  name: "set_slack_channel",
  domain: "org",
  description:
    "Pick the Slack channel steering repo health notices post to. Refuses an archived or unknown channel.",
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
  input: z.object({ channelId: slackChannelIdSchema }).strict(),
  output: slackConnectionViewSchema,
});

export type OrgSlackChannelSetInput = z.output<typeof orgSlackChannelSet.input>;
export type OrgSlackChannelSetOutput = z.output<
  typeof orgSlackChannelSet.output
>;
