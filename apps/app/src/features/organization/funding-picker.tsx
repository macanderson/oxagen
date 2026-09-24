"use client";
// The Source select at the top of Funding source (mockup `orgKeyPanel`): the
// three sources a model call can be funded from, the one-line meaning of the
// chosen one, and that source's state beneath it. The states arrive rendered
// by the server section; this island only picks which one shows.
//
// Choosing here is a preview. No capability sets the source yet (#4005), so a
// source other than the recorded one says so and writes nothing. When the
// record names no source (Oxagen pays, on the minted key or the shared one,
// and nothing reads which), no source is chosen: the select opens on "Choose a
// source" and the panel says the source is not recorded, rather than drawing
// one of Oxagen's keys as the one that pays. The customer
// key's state carries the one write this panel has: saving a key makes
// customer_key the source, because a stored key is what decides it.
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { inputBase } from "@/ui/control-styles";
import { FUNDING_SOURCES, type FundingSource } from "./funding-sources";

export function FundingPicker({
  current,
  states,
}: {
  /** The source the record names, or null when no read can tell. */
  current: FundingSource | null;
  states: Readonly<Record<FundingSource, ReactNode>>;
}) {
  const t = useTranslations("organization.modelFunding.funding");
  const id = useId();
  const [chosen, setChosen] = useState<FundingSource | null>(current);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium text-foreground">
          {t("source")}
        </label>
        <select
          id={id}
          value={chosen ?? ""}
          aria-describedby={`${id}-about`}
          className={inputBase}
          onChange={(event) => {
            const { value } = event.currentTarget;
            setChosen(FUNDING_SOURCES.find((s) => s === value) ?? null);
          }}
        >
          {chosen === null ? <option value="">{t("choose")}</option> : null}
          {FUNDING_SOURCES.map((source) => (
            <option key={source} value={source}>
              {t(`sources.${source}.option`)}
            </option>
          ))}
        </select>
        <p id={`${id}-about`} className="text-xs text-muted-foreground">
          {chosen === null ? t("unknown") : t(`sources.${chosen}.about`)}
        </p>
      </div>
      {chosen === null || chosen === current ? null : (
        <p
          data-testid="funding-preview"
          data-issue="4005"
          className="text-[12px] text-dim"
        >
          {current === null
            ? t("unknownPreview", { source: chosen })
            : t("preview", { source: chosen, current })}
        </p>
      )}
      {chosen === null ? null : (
        <div data-funding-state={chosen}>{states[chosen]}</div>
      )}
    </div>
  );
}
