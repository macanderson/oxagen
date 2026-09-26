// The Tools tab (mockup `tools.md`): every tool version the workspace
// registry holds, with the provider it came from, its classification, the kill
// switch that stops it today, the schema's origin and digest, and its 30-day
// calls. A row opens the version; its Provider cell shows the provider's icon
// and name, and opens that provider. The provider chips narrow the registry to
// the versions one provider supplied, across every page.
//
// What the record does not carry is said, not filled:
//
//  - Output schemas observed rather than declared have no store, so no version
//    waits on approval and the banner says the proposals are not recorded
//    (#3921). The tab's count is the registry's, never "N to approve".
//  - The ten categories the design groups by are not a registry attribute yet
//    (#3921). The chips and the Category column show the consequence tags the
//    classification records, which is what `list_tool_versions` filters on.
//  - Toolbelts and Agents: belts are stored (ADR-192) and listed on their own
//    tab, but no read answers which belts hold one tool version (#3852).
import { useLocale, useTranslations } from "next-intl";
import type {
  McpServerList,
  ToolVersion,
  ToolVersionPage,
} from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { cell, numericCell, Table } from "@/ui/table";
import { ImportProvider } from "./import-provider";
import { NotBacked, NotBackedValue } from "./not-backed";
import { CursorPager, NotCarried } from "./parts";
import { ProviderButton, type ProviderView } from "./provider-dialog";
import { ProviderIcon } from "@/ui/provider-icon";
import { ToolsReadFailure } from "./read-failure";
import {
  CategoryCell,
  FinancialCell,
  GateDot,
  HazardCell,
  ToolName,
} from "./registry-cells";
import { StubAction } from "./stub-action";
import { ToggleLink } from "./toggle-link";
import { ToolDialog } from "./tool-dialog";
import { type ToolNameStyle, type ToolsAt, toolsLink } from "./view";

/**
 * Every consequence tag the versions in `items` carry in their classification,
 * with its count. Not the registry's tags (the read is a page with no facet
 * aggregate), not an unfiltered tally while a tag narrows the page, and not
 * the declared tags a filter also matches: the chips say each of these.
 */
function categoryCounts(
  items: readonly ToolVersion[],
): readonly { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.classification?.consequenceTags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (a.tag < b.tag ? -1 : 1));
}

const chip =
  "inline-flex min-h-8 max-md:min-h-11 items-center gap-2 rounded-md border border-border px-3 text-[13px] text-muted-foreground hover:text-foreground aria-pressed:border-foreground aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function CategoryChips({
  at,
  names,
  category,
  provider,
  items,
  complete,
}: {
  at: ToolsAt;
  names: ToolNameStyle;
  category: string | null;
  provider: string | null;
  items: readonly ToolVersion[];
  /** False while a later page exists: the tags and counts are this page's. */
  complete: boolean;
}) {
  const t = useTranslations("tools.registry");
  const locale = useLocale();
  const counts = categoryCounts(items);
  const filtered = category !== null;
  return (
    <div
      role="group"
      aria-label={t("categories")}
      className="flex flex-wrap gap-2"
    >
      <ToggleLink
        to={toolsLink(at, { tab: "tools", names, provider })}
        pressed={category === null}
        data-category="all"
        className={chip}
      >
        {filtered || complete ? t("allCategories") : t("allOnPage")}
        {filtered ? null : (
          <span className={`${mono} text-[10.5px] text-dim`}>
            {formatCount(items.length, locale)}
          </span>
        )}
      </ToggleLink>
      {counts.map(({ tag, count }) => (
        <ToggleLink
          key={tag}
          to={
            category === tag
              ? toolsLink(at, { tab: "tools", names, provider })
              : toolsLink(at, { tab: "tools", names, provider, category: tag })
          }
          pressed={category === tag}
          data-category={tag}
          className={chip}
        >
          <span className={mono}>{tag}</span>
          <span className={`${mono} text-[10.5px] text-dim`}>
            {formatCount(count, locale)}
          </span>
        </ToggleLink>
      ))}
    </div>
  );
}

/**
 * One chip per provider on the roster, each with its icon, and a chip for
 * every provider. The roster is the whole list, so each provider is offered
 * on every page, and picking one asks `list_tool_versions` for its versions
 * alone. A chip counts those versions only when the unfiltered read reached
 * its last page. `toolCount` is the pins the provider's last health check
 * found, not the registry's versions, so it is never the count here.
 */
function ProviderChips({
  at,
  names,
  category,
  provider,
  views,
}: {
  at: ToolsAt;
  names: ToolNameStyle;
  category: string | null;
  provider: string | null;
  views: ReadonlyMap<string, ProviderView>;
}) {
  const t = useTranslations("tools.registry");
  const locale = useLocale();
  // With no roster there is nothing to pick. A filter the URL still carries
  // keeps the chip that clears it.
  if (views.size === 0 && provider === null) return null;
  return (
    <div
      role="group"
      aria-label={t("providers")}
      className="flex flex-wrap gap-2"
    >
      <ToggleLink
        to={toolsLink(at, { tab: "tools", names, category })}
        pressed={provider === null}
        data-provider="all"
        className={chip}
      >
        {t("allProviders")}
      </ToggleLink>
      {[...views.values()].map(({ server, versions, complete }) => (
        <ToggleLink
          key={server.id}
          to={toolsLink(at, {
            tab: "tools",
            names,
            category,
            provider: provider === server.id ? null : server.id,
          })}
          pressed={provider === server.id}
          data-provider={server.id}
          className={chip}
        >
          <ProviderIcon name={server.name} iconUrl={server.iconUrl} size={16} />
          <span>{server.name}</span>
          {complete ? (
            <span className={`${mono} text-[10.5px] text-dim`}>
              {formatCount(versions.length, locale)}
            </span>
          ) : null}
        </ToggleLink>
      ))}
    </div>
  );
}

/**
 * The key for what an empty table says, by which filters narrowed it. A
 * literal union, so the translator's key type and the catalog-used arch test
 * both see every key it can return.
 */
function emptyKey(q: {
  category: string | null;
  provider: string | null;
  cursor: string | null;
}):
  | "emptyRegistry"
  | "emptyCategory"
  | "emptyProvider"
  | "emptyProviderCategory" {
  if (q.provider !== null) {
    return q.category === null ? "emptyProvider" : "emptyProviderCategory";
  }
  return q.category === null && q.cursor === null
    ? "emptyRegistry"
    : "emptyCategory";
}

function NamesToggle({
  at,
  names,
  category,
  provider,
}: {
  at: ToolsAt;
  names: ToolNameStyle;
  category: string | null;
  provider: string | null;
}) {
  const t = useTranslations("tools.registry");
  return (
    <div
      role="group"
      aria-label={t("names.label")}
      className="inline-flex rounded-[9px] border border-border p-0.5"
    >
      {(["labels", "api"] as const).map((style) => (
        <ToggleLink
          key={style}
          to={toolsLink(at, { tab: "tools", category, provider, names: style })}
          pressed={names === style}
          data-names={style}
          className="inline-flex min-h-7 max-md:min-h-11 items-center rounded-md px-2.5 text-[13px] text-muted-foreground hover:text-foreground aria-pressed:bg-hl aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t(`names.${style}`)}
        </ToggleLink>
      ))}
    </div>
  );
}

/** What the categories mean (`toolcats`): the tags the chips show, and what they decide. */
function CategoriesDialog() {
  const t = useTranslations("tools.registry.categoriesDialog");
  return (
    <StubAction
      label={t("open")}
      tone="ghost"
      title={t("title")}
      gap="registry"
      note={t("note")}
      confirm={t("close")}
      wide
      testId="tools-categories"
    >
      <p className="text-[13px] text-foreground">{t("lead")}</p>
      <dl className="grid gap-x-4 gap-y-1.5 text-[13px] sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
        {(
          [
            "moves_money",
            "destroys_data",
            "alters_production",
            "communicates_externally",
            "changes_access",
            "changes_entitlement",
          ] as const
        ).map((tag) => (
          <div key={tag} className="contents">
            <dt className={mono}>{tag}</dt>
            <dd className="text-muted-foreground">{t(`tags.${tag}`)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t("decides")}</p>
    </StubAction>
  );
}

function Row({
  at,
  version,
  names,
  canClassify,
  canAdminister,
  provider,
}: {
  at: ToolsAt;
  version: ToolVersion;
  names: ToolNameStyle;
  canClassify: boolean;
  canAdminister: boolean;
  /** The provider the version came from, or null for a declared tool. */
  provider: ProviderView | null;
}) {
  const t = useTranslations("tools.registry");
  const locale = useLocale();
  return (
    <tr data-tool-version={version.id}>
      <td className={cell}>
        <ToolDialog
          at={at}
          version={version}
          canClassify={canClassify}
          provider={provider?.server ?? null}
        >
          <ToolName version={version} names={names} />
        </ToolDialog>
      </td>
      <td className={cell}>
        {provider === null ? (
          <span className="text-xs text-muted-foreground">
            {t(`declaredSource.${version.source}`)}
          </span>
        ) : (
          <ProviderButton
            at={at}
            view={provider}
            canAdminister={canAdminister}
            canClassify={canClassify}
          />
        )}
      </td>
      <td className={cell}>
        <CategoryCell version={version} />
      </td>
      <td className={cell}>
        <HazardCell version={version} />
      </td>
      <td className={cell}>
        <GateDot version={version} />
      </td>
      <td className={cell}>
        {version.classification === null ? (
          <NotCarried />
        ) : (
          <span className="text-xs text-foreground">
            {t(`egress.${version.classification.egress}`)}
          </span>
        )}
      </td>
      <td className={cell}>
        <FinancialCell version={version} />
      </td>
      <td className={cell}>
        <span className="text-xs text-foreground">
          {t(`origin.${version.schemaOrigin}`)}
        </span>
      </td>
      <td className={cell}>
        <span className={`${mono} text-xs text-muted-foreground`}>
          {version.schemaDigest.slice(0, 12)}
        </span>
      </td>
      <td className={cell}>
        <NotBackedValue gap="toolbelts" />
      </td>
      <td className={cell}>
        <NotBackedValue gap="toolbelts" />
      </td>
      <td className={numericCell}>
        {version.calls30d === null ? (
          <NotCarried />
        ) : (
          formatCount(version.calls30d, locale)
        )}
      </td>
    </tr>
  );
}

/** Each provider's view, from the roster and the versions the registry read. */
export function providerViews(
  servers: readonly McpServerList["servers"][number][],
  total: ToolVersionPage | null,
): ReadonlyMap<string, ProviderView> {
  const views = new Map<string, ProviderView>();
  for (const server of servers) {
    views.set(server.id, {
      server,
      versions:
        total?.items.filter((version) => version.serverId === server.id) ?? [],
      complete: total !== null && total.nextCursor === null,
    });
  }
  return views;
}

export function Registry({
  at,
  orgRole,
  names,
  category,
  provider,
  cursor,
  canImport,
  canClassify,
  read,
  total,
  servers,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  names: ToolNameStyle;
  category: string | null;
  /** The `mcs_…` id the page is narrowed to, or null for every provider. */
  provider: string | null;
  cursor: string | null;
  canImport: boolean;
  canClassify: boolean;
  /** The page this view shows: narrowed by the chips and the cursor. */
  read: Read<ToolVersionPage>;
  /** The registry's unfiltered first page, which the badge counts against. */
  total: ToolVersionPage | null;
  /** list_mcp_servers: each row's provider, and the import dialog's picker. */
  servers: Read<McpServerList>;
}) {
  const t = useTranslations("tools.registry");
  const locale = useLocale();
  if (!read.ok) {
    return (
      <ToolsReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={routes.tools(at.org, at.ws)}
      />
    );
  }
  const { items, nextCursor } = read.value;
  const roster = servers.ok ? servers.value.servers : [];
  const views = providerViews(roster, total);
  const totalKnown = total !== null && total.nextCursor === null;
  return (
    <div className="flex flex-col gap-4">
      <NotBacked gap="registry" testId="tools-observed-schemas">
        {t("observedNotBacked")}
      </NotBacked>
      <section aria-labelledby="tools-registry" className={panel}>
        <div className={panelHeader}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="tools-registry" className={panelTitle}>
              {t("title")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("caption")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <NamesToggle
              at={at}
              names={names}
              category={category}
              provider={provider}
            />
            <span
              data-testid="tools-shown"
              className={`${mono} rounded border border-border px-1.5 py-0.5 text-[10.5px] text-muted-foreground`}
            >
              {totalKnown
                ? t("shownOf", {
                    shown: formatCount(items.length, locale),
                    total: formatCount(total.items.length, locale),
                  })
                : t("shown", { shown: formatCount(items.length, locale) })}
            </span>
            {canImport ? (
              <ImportProvider
                at={at}
                servers={servers.ok ? servers.value.servers : null}
                compact
              />
            ) : null}
          </div>
        </div>
        <div className="flex flex-col gap-2.5 border-b border-border px-4 py-3">
          <ProviderChips
            at={at}
            names={names}
            category={category}
            provider={provider}
            views={views}
          />
          <div className="flex flex-wrap items-center gap-2.5">
            <div className="min-w-0 flex-1">
              <CategoryChips
                at={at}
                names={names}
                category={category}
                provider={provider}
                items={items}
                complete={nextCursor === null}
              />
            </div>
            <CategoriesDialog />
          </div>
        </div>
        {items.length === 0 ? (
          <p
            data-state="empty"
            className={`${panelBody} text-sm text-muted-foreground`}
          >
            {t(emptyKey({ category, provider, cursor }))}
          </p>
        ) : (
          <Table
            label={t("title")}
            columns={[
              { label: t("columns.version") },
              { label: t("columns.provider") },
              { label: t("columns.category") },
              { label: t("columns.hazard") },
              { label: t("columns.gate") },
              { label: t("columns.egress") },
              { label: t("columns.financial") },
              { label: t("columns.origin") },
              { label: t("columns.digest") },
              { label: t("columns.toolbelts") },
              { label: t("columns.agents") },
              { label: t("columns.calls"), numeric: true },
            ]}
          >
            {items.map((version) => (
              <Row
                key={version.id}
                at={at}
                version={version}
                names={names}
                canClassify={canClassify}
                canAdminister={canImport}
                provider={
                  version.serverId === null
                    ? null
                    : (views.get(version.serverId) ?? null)
                }
              />
            ))}
          </Table>
        )}
        <div className={`${panelBody} flex flex-col gap-2`}>
          {nextCursor === null ? null : (
            <CursorPager
              nextCursor={nextCursor}
              link={(next) =>
                toolsLink(at, {
                  tab: "tools",
                  names,
                  category,
                  provider,
                  cursor: next,
                })
              }
            />
          )}
          <p
            data-state="facets-declared"
            className="max-w-prose text-xs text-muted-foreground"
          >
            {category === null
              ? nextCursor === null
                ? t("categoriesDeclaredNote")
                : t("categoriesNote")
              : t("categoriesFilteredNote")}
          </p>
          <p className="max-w-prose border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
            {t("gateNote")}
          </p>
        </div>
      </section>
    </div>
  );
}
