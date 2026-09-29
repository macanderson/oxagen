/**
 * @oxagen/notifications/slack: the Oxagen Slack app's side of notices.
 *
 *   notifyOrgSlack(input)       post one notice to the organization's channel
 *   slackOauthAccess(...)       exchange an OAuth code for a bot install
 *   slackListChannels(token)    the channels the picker offers
 *   slackChannelInfo(token, id) one channel, to check a pick
 *   slackRevokeToken(token)     revoke a bot token on disconnect
 *   *SlackConnection            load, save, and delete the stored connection
 *
 * The root export re-exports `notifyOrgSlack` and its types. The rest is for
 * the handlers that connect Slack, so it stays on this subpath.
 */
export {
  notifyOrgSlack,
  slackNoticeMessage,
  slackDeepLink,
  escapeSlackText,
} from "./notify-org-slack";
export type {
  NotifyOrgSlackInput,
  NotifyOrgSlackResult,
  SlackSkipReason,
} from "./notify-org-slack";
export {
  SLACK_BOT_SCOPES,
  SlackApiError,
  isPermanentSlackError,
  slackOauthAccess,
  slackListChannels,
  slackChannelInfo,
  slackPostMessage,
  slackRevokeToken,
} from "./slack-api";
export type { SlackBotInstall, SlackChannel } from "./slack-api";
export {
  SLACK_NOTICES_PROVIDER,
  SLACK_NOTICES_SETTING,
  loadSlackConnection,
  openSlackToken,
  saveSlackConnection,
  setSlackChannel,
  recordSlackFailure,
  deleteSlackConnection,
} from "./slack-connection";
export type {
  SlackConnection,
  SlackNoticeChannel,
  SlackNoticeFailure,
} from "./slack-connection";
