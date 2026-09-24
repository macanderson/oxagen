// Providers (mockup `tools.md`, Providers tab): the systems the registry's
// tools belong to, each with the transport Oxagen reaches it over, then the
// connections that hold a credential for one, then the credential grants log.
// A provider is named by the system it is, never by its transport: `mcp` is a
// value in the Transport column, not the name of the collection.
//
// The roster is `list_mcp_servers`, so every row is reached over MCP today; a
// provider reached over `http`, `sdk` or a harness hook has nowhere to live
// until providers are stored apart from their transport (#3917).
//
// The warning the design draws under the table counts connections with an
// expired token or a passed review date. Neither is recorded on a connection
// (#3918), so the page says it cannot count them rather than printing none.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ConnectionList,
  CredentialGrantPage,
  McpServerList,
  ToolVersionPage,
} from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { panel, panelBody, panelHeader, panelTitle } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { Table } from "@/ui/table";
import { ConnectionsTable, GrantsLog } from "./connections";
import { ImportProvider } from "./import-provider";
import { NotBacked } from "./not-backed";
import { ProviderRow } from "./provider-row";
import { ToolsReadFailure } from "./read-failure";
import { providerViews } from "./registry";
import { type ToolsAt, toolsLink } from "./view";

export function Providers({
  at,
  orgRole,
  canAdminister,
  servers,
  versions,
  connections,
  grants,
  cursor,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  /** An org Owner or Admin: who `register_mcp_server` and `delete_mcp_server` admit. */
  canAdminister: boolean;
  servers: Read<McpServerList>;
  /** The registry's unfiltered first page, which each provider's versions come from. */
  versions: Read<ToolVersionPage>;
  connections: Read<ConnectionList>;
  grants: Read<CredentialGrantPage>;
  cursor: string | null;
}) {
  const t = useTranslations("tools.providers");
  const locale = useLocale();
  const add = canAdminister ? (
    <ImportProvider
      at={at}
      servers={servers.ok ? servers.value.servers : null}
      primary
      label="add"
    />
  ) : null;
  let roster: ReactNode;
  if (!servers.ok) {
    roster = (
      <ToolsReadFailure
        at={at}
        orgRole={orgRole}
        read={servers}
        retry={toolsLink(at, { tab: "providers" })}
      />
    );
  } else {
    const total = versions.ok ? versions.value : null;
    const views = providerViews(servers.value.servers, total);
    const complete = total !== null && total.nextCursor === null;
    const held = [...views.values()].reduce(
      (sum, view) => sum + view.versions.length,
      0,
    );
    roster = (
      <section aria-labelledby="tools-providers" className={panel}>
        <div className={panelHeader}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="tools-providers" className={panelTitle}>
              {t("title")}
            </h2>
            <p
              data-testid="tools-providers-caption"
              className="text-xs text-muted-foreground"
            >
              {complete
                ? t("caption", {
                    providers: formatCount(
                      servers.value.servers.length,
                      locale,
                    ),
                    versions: formatCount(held, locale),
                  })
                : t("captionPartial", {
                    providers: formatCount(
                      servers.value.servers.length,
                      locale,
                    ),
                  })}
            </p>
          </div>
          {add}
        </div>
        {servers.value.servers.length === 0 ? (
          <p
            data-state="empty"
            className={`${panelBody} text-sm text-muted-foreground`}
          >
            {t("empty")}
          </p>
        ) : (
          <Table
            label={t("title")}
            columns={[
              { label: t("columns.provider") },
              { label: t("columns.transport") },
              { label: t("columns.tools"), numeric: true },
              { label: t("columns.toolbelts") },
              { label: t("columns.agents") },
              { label: t("columns.health") },
              { label: t("columns.connection") },
              { label: t("columns.authorization") },
              { label: t("columns.lastImport") },
              { label: t("columns.actions") },
            ]}
          >
            {[...views.values()].map((view) => (
              <ProviderRow
                key={view.server.id}
                at={at}
                view={view}
                canAdminister={canAdminister}
              />
            ))}
          </Table>
        )}
        <div className={`${panelBody} flex flex-col gap-3`}>
          <p className="max-w-prose border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
            {t("transportNote")}
          </p>
          <NotBacked gap="oauth" testId="tools-providers-attention">
            {t("attentionNotBacked")}
          </NotBacked>
        </div>
      </section>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {roster}
      <ConnectionsTable at={at} orgRole={orgRole} read={connections} />
      <GrantsLog at={at} orgRole={orgRole} cursor={cursor} read={grants} />
    </div>
  );
}
