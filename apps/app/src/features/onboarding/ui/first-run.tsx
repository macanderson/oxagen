"use client";
// The first-run banner (engine.js `obFleetBanners`, "One run so far."): the
// workspace has recorded the installer's smoke session and nothing else, so
// the list below is that one run and the tiles read off it. "Show the seeded
// fleet" puts the banner away. The gate draws it only while that run is the
// only one the workspace holds, which is what makes each sentence true, and
// is why pressing it changes nothing else on the page: the list already holds
// every run there is.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { GateBanner } from "./banner";

export function FirstRunBanner({
  runId,
  agentKey,
}: {
  runId: string;
  /** The run's agent; null when the ledger did not record one. */
  agentKey: string | null;
}) {
  const t = useTranslations("onboarding.gate.firstRun");
  const [shown, setShown] = useState(true);
  if (!shown) return null;
  return (
    <GateBanner
      testId="onboarding-first-run"
      badge={t("badge")}
      tone="quiet"
      title={t("title")}
      action={
        <button
          type="button"
          data-testid="first-run-dismiss"
          className={`${buttonSecondary} px-2.5 py-1 text-xs`}
          onClick={() => {
            setShown(false);
          }}
        >
          {t("dismiss")}
        </button>
      }
    >
      <p>
        {t.rich("body", {
          run: () => <span className={mono}>{runId}</span>,
          agent: () => (
            <span className={mono}>{agentKey ?? t("agentNotRecorded")}</span>
          ),
        })}
      </p>
    </GateBanner>
  );
}
