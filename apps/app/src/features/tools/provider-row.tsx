"use client";
// One row of the Providers table. It is a client component because the row and
// its Open button open the same drill-down, and the drill-down's state has to
// live somewhere both reach.
//
// The row prints what the roster and the registry carry: the system, the
// transport (every roster row is reached over `mcp`) over the wire and the
// endpoint, the versions the registry holds from it, and the recorded health.
// Connection is the provider's status light and Authorization how it
// authenticates, with an OAuth token's expiry (#4132). Toolbelts, Agents and
// Last import have no field on any read yet (#3852, #3917), and each cell
// says so.
//
// Weekly price is what the provider's tool definitions cost the workspace over
// the last 7 days, sent on every model call (#4537). The server prices it from
// the book at each call's rate, and the row prints the figure it returns: the
// app never multiplies a rate by tokens (ADR-060). The figure prints to the
// micro, because a small provider can cost less than half a cent a week, and
// rounding that to $0.00 would show a charged provider as free (#4572). The
// cell says not recorded when no listing names the provider, and not priced
// when the tokens are known and the server priced no quote: the week had no
// call, a call with no rate in the book, or rates in two currencies.
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import type { McpServer } from "@/data/contracts/tools";
import { pathOf } from "@/shared/safe-path";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ProviderIcon } from "@/ui/provider-icon";
import { cell, numericCell } from "@/ui/table";
import { buttonGhost } from "./buttons";
import { NotBackedValue } from "./not-backed";
import {
  HealthDot,
  ProviderDialog,
  type ProviderView,
  RemoveProvider,
} from "./provider-dialog";
import {
  ProviderAuthorization,
  ProviderStatusLight,
  ReconnectProvider,
} from "./provider-status";
import type { ToolsAt } from "./view";

/** A provider's weekly price as the server priced it, with the tokens it priced. */
function ProviderWeeklyPrice({ server }: { server: McpServer }) {
  const t = useTranslations("tools.providers");
  const locale = useLocale();
  const { contextTokens: tokens, weeklyPrice } = server;
  if (tokens === null) {
    return (
      <span
        data-testid={`provider-weekly-${server.id}`}
        data-state="absent"
        className="text-xs text-muted-foreground"
      >
        {t("weeklyAbsent")}
      </span>
    );
  }
  const count = formatCount(tokens, locale);
  if (weeklyPrice === null) {
    return (
      <span
        data-testid={`provider-weekly-${server.id}`}
        data-state="unpriced"
        className="flex flex-col items-end gap-0.5 text-xs text-muted-foreground"
      >
        <span title={t("weeklyUnpricedTitle")}>{t("weeklyUnpriced")}</span>
        <span className="text-[10.5px]">
          {t("weeklyTokenCount", { tokens: count })}
        </span>
      </span>
    );
  }
  return (
    <span
      data-testid={`provider-weekly-${server.id}`}
      className="flex flex-col items-end gap-0.5"
      title={t("weeklyTitle", { tokens: count })}
    >
      <Money value={weeklyPrice} precision="exact" />
      <span className="text-[10.5px] text-muted-foreground">
        {t("weeklyTokens", { tokens: count })}
      </span>
    </span>
  );
}

export function ProviderRow({
  at,
  view,
  canAdminister,
}: {
  at: ToolsAt;
  view: ProviderView;
  canAdminister: boolean;
}) {
  const t = useTranslations("tools.providers");
  const studio = useTranslations("mcpStudio");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const { server, versions, complete } = view;
  const show = () => {
    setOpen(true);
  };
  return (
    <tr data-provider={server.id}>
      <td className={cell}>
        <button
          type="button"
          data-provider-open={server.id}
          aria-label={t("openNamed", { name: server.name })}
          className={`${buttonGhost} -ml-2 max-w-full items-start gap-2.5`}
          onClick={show}
        >
          <ProviderIcon name={server.name} iconUrl={server.iconUrl} size={24} />
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="font-semibold md:truncate">{server.name}</span>
            <span
              className={`${mono} text-xs font-normal text-muted-foreground md:truncate`}
            >
              {server.id}
            </span>
          </span>
        </button>
        <ProviderDialog
          at={at}
          view={view}
          canAdminister={canAdminister}
          canClassify={canAdminister}
          open={open}
          onOpenChange={setOpen}
        />
      </td>
      <td className={cell}>
        <span className="flex flex-col gap-1">
          <span
            className={`${mono} w-fit rounded border border-border px-1.5 py-0.5 text-[11px]`}
          >
            {t("transportMcp")}
          </span>
          <span
            className={`${mono} text-[10.5px] text-muted-foreground md:truncate`}
          >
            {t("wireLine", {
              wire: server.transportType,
              endpoint: server.endpointUrl,
            })}
          </span>
        </span>
      </td>
      <td className={numericCell}>
        <span className="flex flex-col items-end gap-0.5">
          <span>
            {complete
              ? formatCount(versions.length, locale)
              : t("atLeast", { count: versions.length })}
          </span>
          <span className="text-[10.5px] text-muted-foreground">
            {t("pinned", { count: server.toolCount })}
          </span>
        </span>
      </td>
      <td className={numericCell}>
        <ProviderWeeklyPrice server={server} />
      </td>
      <td className={cell}>
        <NotBackedValue gap="toolbelts" />
      </td>
      <td className={cell}>
        <NotBackedValue gap="toolbelts" />
      </td>
      <td className={cell}>
        <HealthDot health={server.healthStatus} />
      </td>
      <td className={cell}>
        <ProviderStatusLight server={server} />
      </td>
      <td className={cell}>
        <ProviderAuthorization server={server} />
      </td>
      <td className={cell}>
        <NotBackedValue gap="providers" />
      </td>
      <td className={cell}>
        <span data-actions="" className="flex gap-1.5 max-md:flex-wrap">
          <button
            type="button"
            data-testid={`provider-open-${server.id}`}
            className={buttonSecondary}
            onClick={show}
          >
            {t("open")}
          </button>
          <SafeLink
            to={pathOf(at.org, at.ws, "tools", "servers", server.id)}
            data-testid={`provider-studio-${server.id}`}
            className={buttonSecondary}
          >
            {studio("providerLink")}
          </SafeLink>
          {canAdminister ? <ReconnectProvider at={at} server={server} /> : null}
          {canAdminister ? <RemoveProvider at={at} server={server} /> : null}
        </span>
      </td>
    </tr>
  );
}
