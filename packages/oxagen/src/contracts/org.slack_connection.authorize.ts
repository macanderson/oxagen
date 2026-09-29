import { z } from "zod";
import { registerCapability } from "../registry";
import {
  slackConnectionViewSchema,
  slackOAuthStateSchema,
} from "./org.slack_connection.shared";

/**
 * authorize_slack_connection: finish connecting Slack with the code Slack
 * returned (#4608).
 *
 * The handler consumes the state nonce start_slack_connection stored, and
 * refuses a state that expired, was used, or belongs to another organization
 * or person. It exchanges the code with `oauth.v2.access` and stores the bot
 * token as an encrypted organization credential. The output is the redacted
 * connection. It never carries the token.
 */
export const orgSlackConnectionAuthorize = registerCapability({
  name: "authorize_slack_connection",
  domain: "org",
  description:
    "Finish connecting the organization's Slack workspace with the code Slack returned. Stores the Oxagen bot token encrypted and returns the connection without the token.",
  mode: "sync",
  surfaces: [],
  layers: ["schema", "app", "unit", "docs"],
  scoped: false,
  noBillingGate: true,
  mutates: true,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  input: z
    .object({
      state: slackOAuthStateSchema,
      code: z.string().min(1).max(512),
    })
    .strict(),
  output: slackConnectionViewSchema,
});

export type OrgSlackConnectionAuthorizeInput = z.output<
  typeof orgSlackConnectionAuthorize.input
>;
export type OrgSlackConnectionAuthorizeOutput = z.output<
  typeof orgSlackConnectionAuthorize.output
>;
