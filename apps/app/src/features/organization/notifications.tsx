// Organization › Notifications (#4608): the Slack connection that steering
// repo health notices post through. An Owner or Admin connects a Slack
// workspace, picks the channel, and disconnects. The tab renders inside the
// Organization frame, which refuses anyone below Owner or Admin before any
// read, so a viewer who reaches this panel may change Slack. Each handler
// checks the role again (INV-29).
//
// The panel reads `get_slack_connection` once. It shows the Slack workspace,
// the channel, when the connection was made, and the last post Slack refused
// with what to do about it. It never shows the bot token: no contract carries
// it. `outcome` is how a connection attempt ended, the one word the OAuth
// callback put on the URL. The writes are `notifications-controls.tsx`.
import { useTranslations } from "next-intl";
import type { SlackConnection, SlackFailure } from "@/data/contracts/org";
import type { Read } from "@/data/read";
import type { SlackConnectOutcome } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";
import { ReadFailure } from "@/ui/read-failure";
import { NotificationsControls } from "./notifications-controls";
import { DateCell, emptyLine, NotRecordedValue, note, warn } from "./parts";
import { lastFailureKey, OUTCOME_KEYS } from "./slack-failure";

const term = "text-muted-foreground";
const facts = "grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm";

export function NotificationsTab({
  org,
  read,
  outcome,
}: {
  org: string;
  read: Read<SlackConnection>;
  outcome: SlackConnectOutcome | null;
}) {
  const t = useTranslations("organization.notifications");
  return (
    <section
      aria-labelledby="org-slack"
      className={panel}
      data-testid="org-slack"
    >
      <div className={panelHeader}>
        <h2 id="org-slack" className={panelTitle}>
          {t("title")}
        </h2>
        {read.ok ? <SlackStatus connection={read.value} /> : null}
      </div>
      <div className={`${panelBody} flex flex-col gap-3.5`}>
        <p className={note}>{t("about")}</p>
        {outcome === null ? null : (
          <p
            role="status"
            className="text-sm"
            data-testid="slack-outcome"
            data-outcome={outcome}
          >
            {t(OUTCOME_KEYS[outcome])}
          </p>
        )}
        {read.ok ? (
          <Connection org={org} connection={read.value} />
        ) : (
          <ReadFailure read={read} section={t("title")} />
        )}
      </div>
    </section>
  );
}

/**
 * The header badge: connected, not connected, or no Slack app here. A stored
 * connection reads connected even on a deployment that lost its Slack app
 * settings, because posting needs only the stored bot token.
 */
function SlackStatus({ connection }: { connection: SlackConnection }) {
  const t = useTranslations("organization.notifications.status");
  if (connection.connected)
    return (
      <Badge tone="allowed" data-slack="connected">
        {t("connected")}
      </Badge>
    );
  if (!connection.configured)
    return (
      <Badge tone="quiet" dot={false} data-slack="unavailable">
        {t("unavailable")}
      </Badge>
    );
  return (
    <Badge tone="quiet" dot={false} data-slack="not-connected">
      {t("notConnected")}
    </Badge>
  );
}

function Connection({
  org,
  connection,
}: {
  org: string;
  connection: SlackConnection;
}) {
  const t = useTranslations("organization.notifications");
  if (!connection.connected) {
    // A deployment with no Slack app credentials cannot start a connection,
    // so it offers no Connect Slack.
    if (!connection.configured)
      return (
        <p className={emptyLine} data-testid="slack-unavailable">
          {t("unavailable")}
        </p>
      );
    return (
      <div className="flex flex-col gap-3">
        <p className={emptyLine} data-testid="slack-not-connected">
          {t("notConnected")}
        </p>
        <NotificationsControls org={org} connected={false} channel={null} />
      </div>
    );
  }
  // A stored connection stays manageable whatever `configured` says. The
  // channel picker, the post, and Disconnect use the stored bot token, not
  // the Slack app's OAuth settings, so an owner can still see where notices
  // go, change the channel, and stop them.
  const { channel, lastFailure } = connection;
  return (
    <div className="flex flex-col gap-3.5">
      <dl className={facts} data-testid="slack-facts">
        <dt className={term}>{t("facts.workspace")}</dt>
        <dd>{connection.teamName ?? <NotRecordedValue />}</dd>
        <dt className={term}>{t("facts.channel")}</dt>
        <dd data-testid="slack-channel">
          {channel === null ? (
            <span className="text-dim">{t("noChannel")}</span>
          ) : (
            t(channel.isPrivate ? "channelNamePrivate" : "channelName", {
              name: channel.name,
            })
          )}
        </dd>
        <dt className={term}>{t("facts.connectedAt")}</dt>
        <dd>
          {connection.connectedAt === null ? (
            <NotRecordedValue />
          ) : (
            <DateCell iso={connection.connectedAt} />
          )}
        </dd>
        {lastFailure === null ? null : (
          <>
            <dt className={term}>{t("lastFailure.label")}</dt>
            <dd>
              <DateCell iso={lastFailure.at} />
            </dd>
          </>
        )}
      </dl>
      {lastFailure === null ? null : <LastFailure failure={lastFailure} />}
      <NotificationsControls org={org} connected channel={channel} />
    </div>
  );
}

/**
 * The last post Slack refused, as the sentence that says what to do. A code
 * with no sentence of its own is printed as Slack recorded it.
 */
function LastFailure({ failure }: { failure: SlackFailure }) {
  const t = useTranslations("organization.notifications");
  const key = lastFailureKey(failure.code);
  return (
    <p
      className={warn}
      data-testid="slack-last-failure"
      data-code={failure.code}
    >
      {key === null
        ? t("lastFailure.other", { code: failure.code })
        : t(key)}
    </p>
  );
}
