// Toolbelts (mockup `tools.md`, Toolbelts tab; ADR-192): the sets of tools
// agents are shown. Every workspace holds one All tools belt, the tools an
// admin made available, and the belts cloned from it. A toolbelt narrows what
// an agent is shown and grants nothing: every call still meets the agent's
// roles, the policy on the tool version, the kill switches and the mandates.
//
// The list comes from `list_toolbelts`, the All tools belt first. The belt the
// URL names (`?belt=tbt_…`) opens below it from `get_toolbelt`, with its tools
// grouped by server and the controls the viewer may use. New toolbelt clones
// All tools; each row can be cloned too.
import { useLocale, useTranslations } from "next-intl";
import type { ToolbeltDetail, ToolbeltList } from "@/data/contracts/toolbelts";
import type { Read } from "@/data/read";
import {
  linkText,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { BeltView } from "./belt-view";
import { CloneToolbelt } from "./clone-toolbelt";
import { type ToolsAt, toolsLink } from "./view";

function BeltList({
  at,
  list,
  openId,
  canEdit,
}: {
  at: ToolsAt;
  list: ToolbeltList;
  openId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations("tools.toolbelts");
  const locale = useLocale();
  return (
    <Table
      label={t("title")}
      columns={[
        { label: t("columns.belt") },
        { label: t("columns.tools"), numeric: true },
        { label: t("columns.active"), numeric: true },
        { label: t("columns.servers"), numeric: true },
        { label: t("columns.agents"), numeric: true },
        ...(canEdit ? [{ label: t("columns.actions"), hidden: true }] : []),
      ]}
    >
      {list.belts.map((belt) => (
        <tr
          key={belt.id}
          data-testid="toolbelt-row"
          data-belt={belt.id}
          data-kind={belt.kind}
          aria-current={belt.id === openId ? "true" : undefined}
          className="border-b border-border last:border-b-0"
        >
          <td className={cell}>
            <SafeLink
              to={toolsLink(at, { tab: "toolbelts", belt: belt.id })}
              aria-label={t("openBelt", { name: belt.name })}
              className={`${linkText} font-medium`}
            >
              {belt.name}
            </SafeLink>
            <span className="block text-xs text-muted-foreground">
              {belt.clonedFrom === null
                ? t("allTools")
                : t("clonedFrom", { name: belt.clonedFrom.name })}
            </span>
          </td>
          <td className={numericCell}>{formatCount(belt.tools, locale)}</td>
          <td className={numericCell}>
            {formatCount(belt.activeTools, locale)}
          </td>
          <td className={numericCell}>{formatCount(belt.servers, locale)}</td>
          <td className={numericCell}>{formatCount(belt.agents, locale)}</td>
          {canEdit ? (
            <td className={`${cell} text-right`}>
              <CloneToolbelt
                at={at}
                source={belt}
                label={t("clone.open")}
                testId={`toolbelt-clone-${belt.id}`}
              />
            </td>
          ) : null}
        </tr>
      ))}
    </Table>
  );
}

export function Toolbelts({
  at,
  canEdit,
  list,
  open,
}: {
  at: ToolsAt;
  /** An org Owner or Admin: who the toolbelt writes admit (see `canAdministerOrg`). */
  canEdit: boolean;
  /** `list_toolbelts`. */
  list: Read<ToolbeltList>;
  /** `get_toolbelt` for the belt the URL names, or null when none is open. */
  open: Read<ToolbeltDetail> | null;
}) {
  const t = useTranslations("tools.toolbelts");
  const allTools = list.ok
    ? list.value.belts.find((belt) => belt.kind === "all_tools")
    : undefined;
  const openId = open?.ok === true ? open.value.belt.id : null;
  return (
    <div className="flex flex-col gap-4">
      <section aria-labelledby="tools-toolbelts" className={panel}>
        <div className={panelHeader}>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <h2 id="tools-toolbelts" className={panelTitle}>
              {t("title")}
            </h2>
            <p className="text-xs text-muted-foreground">{t("caption")}</p>
          </div>
          {canEdit && allTools !== undefined ? (
            <CloneToolbelt
              at={at}
              source={allTools}
              label={t("new")}
              gold
              testId="tools-belt-new"
            />
          ) : null}
        </div>
        <div className={`${panelBody} flex flex-col gap-3`}>
          {list.ok ? (
            <BeltList
              at={at}
              list={list.value}
              openId={openId}
              canEdit={canEdit}
            />
          ) : (
            <ReadFailure read={list} section={t("title")} />
          )}
          <p className="max-w-prose border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
            {t("note")}
          </p>
        </div>
      </section>
      {open === null ? null : open.ok ? (
        <BeltView at={at} detail={open.value} canEdit={canEdit} />
      ) : (
        <section
          aria-label={t("title")}
          data-testid="tools-belt-failure"
          className={`${panel} ${panelBody}`}
        >
          <ReadFailure read={open} section={t("title")} />
          <SafeLink
            to={toolsLink(at, { tab: "toolbelts" })}
            className={`${linkText} text-[13px]`}
          >
            {t("belt.close")}
          </SafeLink>
        </section>
      )}
    </div>
  );
}
