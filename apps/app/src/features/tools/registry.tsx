// Registry (#2958; spec §14, mockup `mockups/pages/tools.md`): the workspace's
// active tool versions with the classification the mandate gate reads, the
// kill switch that stops each one today, the schema's origin and digest, and
// the calls it took in the last 30 days.
//
// Two columns the mockup draws are not here, because no capability carries
// them: the ten-category "what it acts on" taxonomy (the mockup derives it
// from a hard-coded name table) and "On belts". The Category column is the
// registry attribute `list_tool_versions` does carry and filter on — the
// version's consequence tags.
import { useLocale, useTranslations } from "next-intl";
import type { ToolVersion, ToolVersionPage } from "@/data/contracts/tools";
import { MONEY_TAG } from "@/data/contracts/tools";
import type { Read } from "@/data/read";
import type { OrgRole } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { ImportControls } from "./import-controls";
import {
  Chip,
  CursorPager,
  NotCarried,
  Section,
  StateDot,
  type Tone,
} from "./parts";
import { ReadFailure } from "./read-failure";
import { ToolDialog } from "./tool-dialog";
import {
  type ToolNameStyle,
  type ToolsAt,
  toolsLink,
  versionLabel,
} from "./view";

const GATE_TONE = {
  open: "ok",
  killed_version: "deny",
  killed_server: "deny",
  killed_class: "deny",
} as const satisfies Record<ToolVersion["gate"]["kind"], Tone>;

const RISK_TONE = {
  low: "neutral",
  medium: "neutral",
  high: "warn",
  critical: "deny",
} as const satisfies Record<ToolVersion["riskGrade"], Tone>;

/** The version's identity everywhere: `name@version`, label over the API name or the other way round. */
function ToolName({
  version,
  names,
}: {
  version: ToolVersion;
  names: ToolNameStyle;
}) {
  const api = versionLabel(version);
  const primary = names === "api" ? api : version.name;
  const secondary = names === "api" ? version.name : api;
  return (
    <span className="flex flex-col gap-0.5">
      <span
        className={`font-medium text-foreground ${names === "api" ? mono : ""}`}
      >
        {primary}
      </span>
      <span
        className={`text-xs text-muted-foreground ${names === "api" ? "" : mono}`}
      >
        {secondary}
      </span>
    </span>
  );
}

/** Every consequence tag the classified versions on this page carry, with its count. */
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
  "inline-flex min-h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground";

function CategoryChips({
  at,
  names,
  category,
  items,
}: {
  at: ToolsAt;
  names: ToolNameStyle;
  category: string | null;
  items: readonly ToolVersion[];
}) {
  const t = useTranslations("tools.registry");
  const locale = useLocale();
  const counts = categoryCounts(items);
  return (
    <nav aria-label={t("categories")} className="flex flex-wrap gap-2">
      <SafeLink
        to={toolsLink(at, { tab: "registry", names })}
        data-category="all"
        aria-current={category === null ? "page" : undefined}
        className={chip}
      >
        {t("allCategories")}
        <span className="text-xs tabular-nums">
          {formatCount(items.length, locale)}
        </span>
      </SafeLink>
      {counts.map(({ tag, count }) => (
        <SafeLink
          key={tag}
          to={toolsLink(at, { tab: "registry", names, category: tag })}
          data-category={tag}
          aria-current={category === tag ? "page" : undefined}
          className={chip}
        >
          <span className={mono}>{tag}</span>
          <span className="text-xs tabular-nums">
            {formatCount(count, locale)}
          </span>
        </SafeLink>
      ))}
    </nav>
  );
}

function NamesToggle({
  at,
  names,
  category,
}: {
  at: ToolsAt;
  names: ToolNameStyle;
  category: string | null;
}) {
  const t = useTranslations("tools.registry");
  return (
    <nav aria-label={t("names.label")} className="flex gap-1">
      {(["labels", "api"] as const).map((style) => (
        <SafeLink
          key={style}
          to={toolsLink(at, { tab: "registry", category, names: style })}
          data-names={style}
          aria-current={names === style ? "page" : undefined}
          className="inline-flex min-h-9 items-center rounded-md border border-transparent px-3 text-sm text-muted-foreground hover:text-foreground aria-[current=page]:border-border aria-[current=page]:text-foreground"
        >
          {t(`names.${style}`)}
        </SafeLink>
      ))}
    </nav>
  );
}

function Row({
  at,
  version,
  names,
  canClassify,
}: {
  at: ToolsAt;
  version: ToolVersion;
  names: ToolNameStyle;
  canClassify: boolean;
}) {
  const t = useTranslations("tools.registry");
  const gates = useTranslations("tools.gate");
  const locale = useLocale();
  const financial =
    version.classification?.consequenceTags.includes(MONEY_TAG) === true;
  return (
    <tr data-tool-version={version.id}>
      <td className={cell}>
        <ToolDialog at={at} version={version} canClassify={canClassify}>
          <ToolName version={version} names={names} />
        </ToolDialog>
      </td>
      <td className={cell}>
        {version.classification === null ? (
          <span className="text-xs text-muted-foreground">
            {t("unclassified")}
          </span>
        ) : version.classification.consequenceTags.length === 0 ? (
          <span className="text-xs text-muted-foreground">{t("noTags")}</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {version.classification.consequenceTags.map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
          </span>
        )}
      </td>
      <td className={cell}>
        <span className="flex flex-col gap-1">
          <StateDot
            tone={RISK_TONE[version.riskGrade]}
            name={version.riskGrade}
            label={t(`risk.${version.riskGrade}`)}
          />
          {version.classification === null ? null : (
            <span className="text-xs text-muted-foreground">
              {t(`sideEffect.${version.classification.sideEffect}`)}
            </span>
          )}
        </span>
      </td>
      <td className={cell}>
        <StateDot
          tone={GATE_TONE[version.gate.kind]}
          name={version.gate.kind}
          label={gates(version.gate.kind)}
        />
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
        {financial ? (
          <StateDot tone="deny" name="financial" label={t("financial.yes")} />
        ) : (
          <span className="text-xs text-muted-foreground">
            {t("financial.no")}
          </span>
        )}
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

export function Registry({
  at,
  orgRole,
  names,
  category,
  cursor,
  canImport,
  canClassify,
  read,
}: {
  at: ToolsAt;
  orgRole: OrgRole;
  names: ToolNameStyle;
  category: string | null;
  cursor: string | null;
  canImport: boolean;
  canClassify: boolean;
  read: Read<ToolVersionPage>;
}) {
  const t = useTranslations("tools.registry");
  if (!read.ok) {
    return (
      <ReadFailure
        at={at}
        orgRole={orgRole}
        read={read}
        retry={routes.tools(at.org, at.ws)}
      />
    );
  }
  const { items, nextCursor } = read.value;
  const importAction = canImport ? <ImportControls at={at} /> : null;

  if (items.length === 0 && category === null && cursor === null) {
    return (
      <Section
        id="tools-registry"
        title={t("empty.title")}
        lead={t("empty.body")}
        actions={importAction}
        data-state="empty"
      />
    );
  }
  return (
    <Section
      id="tools-registry"
      title={t("title")}
      lead={t("lead")}
      actions={importAction}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CategoryChips
          at={at}
          names={names}
          category={category}
          items={items}
        />
        <NamesToggle at={at} names={names} category={category} />
      </div>
      {items.length === 0 ? (
        <p data-state="empty" className="text-sm text-muted-foreground">
          {t("emptyCategory")}
        </p>
      ) : (
        <Table
          label={t("title")}
          columns={[
            { label: t("columns.version") },
            { label: t("columns.category") },
            { label: t("columns.hazard") },
            { label: t("columns.gate") },
            { label: t("columns.egress") },
            { label: t("columns.financial") },
            { label: t("columns.origin") },
            { label: t("columns.digest") },
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
            />
          ))}
        </Table>
      )}
      <CursorPager
        nextCursor={nextCursor}
        link={(next) =>
          toolsLink(at, { tab: "registry", names, category, cursor: next })
        }
      />
      <p className="max-w-prose text-xs text-muted-foreground">
        {t("gateNote")}
      </p>
    </Section>
  );
}
