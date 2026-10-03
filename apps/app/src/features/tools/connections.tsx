// Connections and the credential grants log, on the Providers tab (mockup
// `tools.md`): the workspace's stored connections, and every credential the
// broker minted for a call, with the connection it drew on, how far it was
// narrowed, its TTL and whether it is still live. No secret material is on the
// wire, and no agent ever held any of these.
//
// The log's Tool version and Agent columns have no field on the grant record,
// which carries the provider the credential was presented to and the run
// (#3923). Each says so, with the provider it does carry beneath.
//
// The mockup's Connections table above the log is here now, over
// `list_connections`. Three of its columns are not: Owner, Reviewed and Next
// review have no field on the connection record, so each renders the
// not-recorded state rather than a value nothing carries. Servers, Downscope
// and Grants 30d are properties of a use, not of a connection, and the log
// below is where the record carries them.
//
// The log pages by address under Rows per page (#4693). `list_connections`
// takes no size and no cursor, so the Connections table is drawn whole.
import { useTranslations } from "next-intl";
import type {
  Connection,
  ConnectionList,
  CredentialGrant,
  CredentialGrantPage,
} from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { mono } from "@/ui/control-styles";
import { LinkPager } from "@/ui/link-pager";
import { cell, Table } from "@/ui/table";
import { AddConnection } from "./add-connection";
import { ConnectionDrawer } from "./connection-drawer";
import {
  Chip,
  NotCarried,
  Section,
  StateDot,
  type Tone,
  useDate,
} from "./parts";
import { NotBackedValue } from "./not-backed";
import { ToolsReadFailure } from "./read-failure";
import { TOOLS_ROWS, type ToolsAt, toolsLink } from "./view";

/** A connection's lifecycle word as a tone; the word itself is what is printed. */
const CONNECTION_TONE = {
  pending_setup: "warn",
  connected: "ok",
  paused: "neutral",
  error: "deny",
  deleting: "warn",
  deleted: "neutral",
} as const satisfies Record<Connection["status"], Tone>;

const CONNECTION_HEALTH_TONE = {
  healthy: "ok",
  degraded: "warn",
  errored: "deny",
} as const satisfies Record<Connection["healthStatus"], Tone>;

const STATUS_TONE = {
  active: "ok",
  expired: "neutral",
  revoked: "deny",
} as const satisfies Record<CredentialGrant["status"], Tone>;

/** The grant's own window, in whole minutes, as the two instants it recorded. */
function ttlMinutes(issuedAt: string, expiresAt: string): number | null {
  const from = Date.parse(issuedAt);
  const to = Date.parse(expiresAt);
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return null;
  return Math.round((to - from) / 60_000);
}

function Row({ grant }: { grant: CredentialGrant }) {
  const t = useTranslations("tools.connections");
  const date = useDate();
  const ttl = ttlMinutes(grant.issuedAt, grant.expiresAt);
  return (
    <tr data-grant={grant.id}>
      <td className={cell}>
        <span className="flex flex-col gap-0.5">
          <span className={`${mono} text-sm text-foreground md:truncate`}>
            {grant.id}
          </span>
          <span className="text-sm text-muted-foreground md:truncate">
            {date(grant.issuedAt)}
          </span>
        </span>
      </td>
      <td className={cell}>
        <span className="flex flex-col gap-0.5">
          <NotBackedValue gap="grants" />
          <span className="text-sm text-muted-foreground md:truncate">
            {t("fromProvider", { provider: grant.serverName })}
          </span>
        </span>
      </td>
      <td className={cell}>
        <span className="flex flex-col gap-0.5">
          <NotBackedValue gap="grants" />
          {grant.runId === null ? (
            <span className="text-sm text-muted-foreground md:truncate">
              {t("noRun")}
            </span>
          ) : (
            <span className={`${mono} text-sm text-foreground md:truncate`}>
              {grant.runId}
            </span>
          )}
        </span>
      </td>
      <td className={cell}>
        <span className={`${mono} text-sm text-foreground`}>
          {grant.connectionId}
        </span>
      </td>
      <td className={cell}>
        <span className="flex flex-col gap-1">
          <span className={`${mono} text-sm text-foreground md:truncate`}>
            {grant.scope.endpointUrl}
          </span>
          <span className="flex gap-1 max-md:flex-wrap">
            <Chip>{t(`downscope.${grant.scope.downscope}`)}</Chip>
            <Chip>{t(`authKind.${grant.scope.authKind}`)}</Chip>
          </span>
        </span>
      </td>
      <td className={cell}>
        <span className={`${mono} text-sm text-foreground`}>
          {ttl === null ? "—" : t("ttl", { minutes: ttl })}
        </span>
      </td>
      <td className={cell}>
        <StateDot
          tone={STATUS_TONE[grant.status]}
          name={grant.status}
          label={t(`status.${grant.status}`)}
        />
      </td>
    </tr>
  );
}

export function GrantsLog({
  at,
  orgRole,
  cursor,
  rows,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  /** The page the address names, by its cursor; null on the newest page. */
  cursor: string | null;
  /** The grants a page holds, one of `TOOLS_ROWS` (#4693). */
  rows: number;
  read: Read<CredentialGrantPage>;
}) {
  const t = useTranslations("tools.connections");
  const pager = useTranslations("tools.pager");
  const list = useTranslations("ui.list");
  if (!read.ok) {
    return (
      <ToolsReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={toolsLink(at, { tab: "providers" })}
      />
    );
  }
  const { items, nextCursor } = read.value;
  if (items.length === 0 && cursor === null) {
    return (
      <Section
        id="tools-connections"
        title={t("empty.title")}
        lead={t("empty.body")}
        data-state="empty"
      />
    );
  }
  return (
    <Section id="tools-connections" title={t("title")} lead={t("lead")}>
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.grant") },
          { label: t("columns.toolVersion") },
          { label: t("columns.agentRun") },
          { label: t("columns.connection") },
          { label: t("columns.scope") },
          { label: t("columns.ttl") },
          { label: t("columns.state") },
        ]}
      >
        {items.map((grant) => (
          <Row key={grant.id} grant={grant} />
        ))}
      </Table>
      {/* The cursor only walks forward, so the step back is the newest
          page. Both steps keep the size, and a new size starts over at the
          newest page (#4693). */}
      <LinkPager
        label={pager("grants")}
        rowsLabel={list("rows")}
        previousLabel={pager("first")}
        nextLabel={pager("next")}
        perPage={rows}
        sizes={TOOLS_ROWS.map((size) => ({
          size,
          first: toolsLink(at, { tab: "providers", rows: size }),
        }))}
        previous={
          cursor === null ? null : toolsLink(at, { tab: "providers", rows })
        }
        next={
          nextCursor === null
            ? null
            : toolsLink(at, { tab: "providers", rows, cursor: nextCursor })
        }
        className="px-0"
      />
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("brokerNote")}
      </p>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("notCarriedNote")}
      </p>
    </Section>
  );
}

function ConnectionRow({ at, item }: { at: ToolsAt; item: Connection }) {
  const t = useTranslations("tools.connections.list");
  const date = useDate();
  return (
    <tr data-connection={item.id}>
      <td className={cell}>
        <ConnectionDrawer
          at={at}
          connectionId={item.id}
          title={item.displayName}
        >
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-foreground md:truncate">
              {item.displayName}
            </span>
            <span
              className={`${mono} text-sm text-muted-foreground md:truncate`}
            >
              {item.id}
            </span>
          </span>
        </ConnectionDrawer>
      </td>
      <td className={cell}>
        <Chip>{item.connector}</Chip>
      </td>
      <td className={cell}>
        <span className="flex gap-1 max-md:flex-wrap">
          <Chip>{item.authScheme}</Chip>
          <Chip>{item.deliveryMethod}</Chip>
        </span>
      </td>
      <td className={cell}>
        <StateDot
          tone={CONNECTION_HEALTH_TONE[item.healthStatus]}
          name={item.healthStatus}
          label={t(`health.${item.healthStatus}`)}
        />
      </td>
      <td className={cell}>
        <span className="text-sm tabular-nums text-foreground">
          {item.entityCount}
        </span>
      </td>
      <td className={cell}>
        {item.lastSyncAt === null ? (
          <NotCarried />
        ) : (
          <span className="text-sm text-foreground">
            {date(item.lastSyncAt)}
          </span>
        )}
      </td>
      {/* Owner, Reviewed and Next review: the mockup's review columns, which
          `list_connections` carries no field for. The cell says so rather
          than standing in a name or a date nothing recorded (INV-10). */}
      <td className={cell}>
        <NotBackedValue gap="oauth" />
      </td>
      <td className={cell}>
        <NotBackedValue gap="oauth" />
      </td>
      <td className={cell}>
        <NotBackedValue gap="oauth" />
      </td>
      <td className={cell}>
        <StateDot
          tone={CONNECTION_TONE[item.status]}
          name={item.status}
          label={t(`status.${item.status}`)}
        />
      </td>
    </tr>
  );
}

export function ConnectionsTable({
  at,
  orgRole,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  read: Read<ConnectionList>;
}) {
  const t = useTranslations("tools.connections.list");
  if (!read.ok) {
    return (
      <ToolsReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={toolsLink(at, { tab: "providers" })}
      />
    );
  }
  const { connections } = read.value;
  // Every connector already in use, as the add dialog's suggestions. It is
  // what this workspace has reached for, not what this deployment ships: no
  // capability lists the connectors, and inventing that list here would offer
  // a slug the handler may refuse.
  const connectors = [
    ...new Set(connections.map((item) => item.connector)),
  ].sort();
  const add = <AddConnection at={at} connectors={connectors} />;
  if (connections.length === 0) {
    return (
      <Section
        id="tools-connection-list"
        title={t("empty.title")}
        lead={t("empty.body")}
        actions={add}
        data-state="empty"
      />
    );
  }
  return (
    <Section
      id="tools-connection-list"
      title={t("title")}
      lead={t("lead")}
      actions={add}
    >
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.connection") },
          { label: t("columns.connector") },
          { label: t("columns.auth") },
          { label: t("columns.health") },
          { label: t("columns.entities") },
          { label: t("columns.lastSync") },
          { label: t("columns.owner") },
          { label: t("columns.reviewed") },
          { label: t("columns.nextReview") },
          { label: t("columns.status") },
        ]}
      >
        {connections.map((item) => (
          <ConnectionRow key={item.id} at={at} item={item} />
        ))}
      </Table>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t("notCarriedNote")}
      </p>
    </Section>
  );
}
