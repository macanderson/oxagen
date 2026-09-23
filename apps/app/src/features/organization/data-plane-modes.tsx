"use client";
// The Data plane tab's segmented control (mockup `orgPlaneBody` `.seg`):
// Shared, Dedicated and Behind the firewall, the organization's own mode
// marked current. Picking another mode previews what that mode's facts would
// be, under a note saying it is a preview; the facts themselves are rendered
// by the server section and handed in, so this island only chooses which to
// show.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";

export type PlaneMode = "shared" | "dedicated" | "firewall";
export const PLANE_MODES: readonly PlaneMode[] = [
  "shared",
  "dedicated",
  "firewall",
];

export function DataPlaneModes({
  current,
  details,
}: {
  /** The mode `get_data_plane` recorded for this organization. */
  current: PlaneMode;
  /** Each mode's about line and facts, rendered by the server. */
  details: Readonly<Record<PlaneMode, ReactNode>>;
}) {
  const t = useTranslations("organization.dataPlane");
  const [shown, setShown] = useState<PlaneMode>(current);
  return (
    <div className="flex flex-col gap-3">
      <div
        role="group"
        aria-label={t("modesLabel")}
        className="inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-[9px] border border-border bg-hl p-0.5"
      >
        {PLANE_MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={shown === mode}
            data-mode={mode}
            onClick={() => {
              setShown(mode);
            }}
            className="min-h-8 rounded-md px-3 text-[13px] text-muted-foreground aria-pressed:bg-card aria-pressed:text-foreground aria-pressed:shadow-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11"
          >
            {t(`modes.${mode}`)}
            {mode === current ? ` · ${t("current")}` : null}
          </button>
        ))}
      </div>
      {shown === current ? null : (
        <p
          data-plane-preview={shown}
          className="border-l-2 border-gold pl-3 text-[12.5px] text-muted-foreground"
        >
          {t("preview", {
            mode: t(`modes.${current}`),
            other: t(`modes.${shown}`),
          })}
        </p>
      )}
      <div data-plane-shown={shown}>{details[shown]}</div>
    </div>
  );
}
