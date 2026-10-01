"use client";
// A Studio server's four tabs (#4678): Tools, Connection, Test and Changes,
// each a path segment under the server. The strip is a `RouteTabs` row
// (ADR-NEW-route-tabs-are-tabs): a tablist of links with one tab stop and the
// arrow keys, scrolling in its own row on a phone. The selected tab names the
// panel the server page draws (`STUDIO_PANEL`, ./route.ts).
//
// Tools counts the tools the page lists, with a plus when the registry read
// stopped at its page bound with a page left. Changes counts the draft's
// edits, which live in this browser tab under this workspace, so the count
// appears once the draft holds one.
import { useLocale, useTranslations } from "next-intl";
import { formatCount } from "@/ui/money-format";
import { RouteTabs } from "@/ui/route-tabs";
import { draftCount } from "./draft";
import type { StudioTool } from "./model";
import {
  STUDIO_PANEL,
  STUDIO_TABS,
  type StudioAt,
  type StudioTab,
  studioHref,
} from "./route";
import { useStudioDraft } from "./use-draft";

export function StudioTabs({
  at,
  serverName,
  serverId,
  current,
  tools,
  complete,
}: {
  at: StudioAt;
  /** The folder name the draft is keyed by; null until the record names it. */
  serverName: string | null;
  serverId: string;
  current: StudioTab;
  tools: readonly Pick<StudioTool, "name" | "imported" | "tokens">[];
  /**
   * False when the registry read stopped at its page bound with a page left,
   * so the count is a floor.
   */
  complete: boolean;
}) {
  const t = useTranslations("mcpStudio.tabs");
  const locale = useLocale();
  const draft = useStudioDraft({ at, serverName, serverId });
  const edits = draftCount({ tools }, draft.ops);
  const count = (tab: StudioTab): string | null => {
    switch (tab) {
      case "tools":
        return complete
          ? formatCount(tools.length, locale)
          : t("atLeast", { count: tools.length });
      case "changes":
        return edits > 0 ? formatCount(edits, locale) : null;
      case "connection":
      case "try":
        return null;
    }
  };
  return (
    <RouteTabs
      label={t("label")}
      panel={STUDIO_PANEL}
      tabs={STUDIO_TABS.map((tab) => {
        const n = count(tab);
        return {
          to: studioHref(at, serverId, tab),
          label: t(tab),
          current: tab === current,
          name: tab,
          ...(n === null ? {} : { count: <span data-count={tab}>{n}</span> }),
        };
      })}
    />
  );
}
