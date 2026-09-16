// Connections (#2958): the credential grants log — every credential the broker
// put to use for a tool server on behalf of a run, with the connection it drew
// on, how far it was narrowed, its TTL and whether it is still live. No secret
// material is on the wire, and no agent ever held any of these.
//
// The mockup's Connections table above the log (Connection · Kind · Owner ·
// Servers · Downscope · Grants 30d · Reviewed · Next review · Status) is not
// here: no capability lists the workspace's connections, so every column of it
// would be invented. The log is what `list_credential_grants` records.
import { useTranslations } from "next-intl";
import type {
  CredentialGrant,
  CredentialGrantPage,
} from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { mono } from "@/ui/control-styles";
import { cell, Table } from "@/ui/table";
import {
  Chip,
  CursorPager,
  Section,
  StateDot,
  type Tone,
  useDate,
} from "./parts";
import { ReadFailure } from "./read-failure";
import { type ToolsAt, toolsLink } from "./view";

const STATUS_TONE = {
  active: "ok",
  expired: "neutral",
  revoked: "deny",
} as const satisfies Record<CredentialGrant["status"], Tone>;

/** The grant's own window, in whole minutes, as the two instants it recorded. */
export function ttlMinutes(issuedAt: string, expiresAt: string): number | null {
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
          <span className={`${mono} text-xs text-foreground`}>{grant.id}</span>
          <span className="text-xs text-muted-foreground">
            {date(grant.issuedAt)}
          </span>
        </span>
      </td>
      <td className={cell}>
        <span className="flex flex-col gap-0.5">
          <span className="text-sm text-foreground">{grant.serverName}</span>
          <span className={`${mono} text-xs text-muted-foreground`}>
            {grant.serverId}
          </span>
        </span>
      </td>
      <td className={cell}>
        {grant.runId === null ? (
          <span className="text-xs text-muted-foreground">{t("noRun")}</span>
        ) : (
          <span className={`${mono} text-xs text-foreground`}>
            {grant.runId}
          </span>
        )}
      </td>
      <td className={cell}>
        <span className={`${mono} text-xs text-foreground`}>
          {grant.connectionId}
        </span>
      </td>
      <td className={cell}>
        <span className="flex flex-col gap-1">
          <span className={`${mono} break-all text-xs text-foreground`}>
            {grant.scope.endpointUrl}
          </span>
          <span className="flex flex-wrap gap-1">
            <Chip>{t(`downscope.${grant.scope.downscope}`)}</Chip>
            <Chip>{t(`authKind.${grant.scope.authKind}`)}</Chip>
          </span>
        </span>
      </td>
      <td className={cell}>
        <span className={`${mono} text-xs text-foreground`}>
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

export function Connections({
  at,
  orgRole,
  cursor,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  cursor: string | null;
  read: Read<CredentialGrantPage>;
}) {
  const t = useTranslations("tools.connections");
  if (!read.ok) {
    return (
      <ReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={toolsLink(at, { tab: "connections" })}
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
          { label: t("columns.server") },
          { label: t("columns.run") },
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
      <CursorPager
        nextCursor={nextCursor}
        link={(next) => toolsLink(at, { tab: "connections", cursor: next })}
      />
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("brokerNote")}
      </p>
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("notCarriedNote")}
      </p>
    </Section>
  );
}
