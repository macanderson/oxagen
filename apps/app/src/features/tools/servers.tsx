// Tool servers (lane: connections; mockup `tools.md`, the Registry tab's
// server list): the MCP servers registered in this workspace, with the health
// the last check recorded and how many tools each one pins.
//
// It sits under the registry rather than in a tab of its own, because a server
// is where a tool version came from: the import control above takes a server's
// pins into the registry, and a tool server kill switch names a row here.
//
// Two honest notes the record forces. A server written by a plugin install
// carries transport `sse` and health `unknown`, and the page prints that word
// rather than a friendlier one. The tool count is pins discovered at the last
// health check, not versions in the registry: a pin becomes a version when it
// is imported.
import { useTranslations } from "next-intl";
import type { McpServer, McpServerList } from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { mono } from "@/ui/control-styles";
import { cell, numericCell, Table } from "@/ui/table";
import { NotCarried, Section, StateDot, type Tone, useDate } from "./parts";
import { ReadFailure } from "./read-failure";
import { RegisterServer } from "./register-server";
import { type ToolsAt, toolsLink } from "./view";

const HEALTH_TONE = {
  healthy: "ok",
  degraded: "warn",
  unreachable: "deny",
  unknown: "neutral",
} as const satisfies Record<McpServer["healthStatus"], Tone>;

function Row({ server }: { server: McpServer }) {
  const t = useTranslations("tools.servers");
  const date = useDate();
  return (
    <tr data-mcp-server={server.id}>
      <td className={cell}>
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-foreground">{server.name}</span>
          <span className={`${mono} text-xs text-muted-foreground`}>
            {server.id}
          </span>
        </span>
      </td>
      <td className={cell}>
        <span className={`${mono} text-xs text-foreground`}>
          {t(`transport.${server.transportType}`)}
        </span>
      </td>
      <td className={cell}>
        <span className={`${mono} break-all text-xs text-muted-foreground`}>
          {server.endpointUrl}
        </span>
      </td>
      <td className={cell}>
        <StateDot
          tone={HEALTH_TONE[server.healthStatus]}
          name={server.healthStatus}
          label={t(`health.${server.healthStatus}`)}
        />
      </td>
      <td className={cell}>
        {server.lastHealthcheckAt === null ? (
          <NotCarried />
        ) : (
          <span className="text-xs text-foreground">
            {date(server.lastHealthcheckAt)}
          </span>
        )}
      </td>
      <td className={numericCell}>{server.toolCount}</td>
    </tr>
  );
}

export function Servers({
  at,
  orgRole,
  canRegister,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  /** An org Owner or Admin: what `register_mcp_server` declares. */
  canRegister: boolean;
  read: Read<McpServerList>;
}) {
  const t = useTranslations("tools.servers");
  if (!read.ok) {
    return (
      <ReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={toolsLink(at, { tab: "registry" })}
      />
    );
  }
  const { servers } = read.value;
  const register = canRegister ? <RegisterServer at={at} /> : null;
  if (servers.length === 0) {
    return (
      <Section
        id="tools-servers"
        title={t("empty.title")}
        lead={t("empty.body")}
        actions={register}
        data-state="empty"
      />
    );
  }
  return (
    <Section
      id="tools-servers"
      title={t("title")}
      lead={t("lead")}
      actions={register}
    >
      <Table
        label={t("title")}
        columns={[
          { label: t("columns.server") },
          { label: t("columns.transport") },
          { label: t("columns.endpoint") },
          { label: t("columns.health") },
          { label: t("columns.checked") },
          { label: t("columns.tools"), numeric: true },
        ]}
      >
        {servers.map((server) => (
          <Row key={server.id} server={server} />
        ))}
      </Table>
      {servers.some((server) => server.healthStatus === "unknown") ? (
        <p
          data-state="health-unknown"
          className="max-w-prose text-xs text-muted-foreground"
        >
          {t("unknownNote")}
        </p>
      ) : null}
    </Section>
  );
}
