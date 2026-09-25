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
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { cell, numericCell } from "@/ui/table";
import { buttonGhost } from "./buttons";
import { NotBackedValue } from "./not-backed";
import {
  HealthDot,
  ProviderDialog,
  type ProviderView,
  RemoveProvider,
} from "./provider-dialog";
import { ProviderIcon } from "./provider-icon";
import {
  ProviderAuthorization,
  ProviderStatusLight,
  ReconnectProvider,
} from "./provider-status";
import type { ToolsAt } from "./view";

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
          className={`${buttonGhost} -ml-2 items-start gap-2.5`}
          onClick={show}
        >
          <ProviderIcon name={server.name} iconUrl={server.iconUrl} size={24} />
          <span className="flex flex-col items-start gap-0.5">
            <span className="font-semibold">{server.name}</span>
            <span
              className={`${mono} text-xs font-normal text-muted-foreground`}
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
            className={`${mono} break-all text-[10.5px] text-muted-foreground`}
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
        <span className="flex flex-wrap gap-1.5">
          <button
            type="button"
            data-testid={`provider-open-${server.id}`}
            className={buttonSecondary}
            onClick={show}
          >
            {t("open")}
          </button>
          {canAdminister ? <ReconnectProvider at={at} server={server} /> : null}
          {canAdminister ? <RemoveProvider at={at} server={server} /> : null}
        </span>
      </td>
    </tr>
  );
}
