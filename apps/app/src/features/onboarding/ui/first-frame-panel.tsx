"use client";
// Step 3: wait for the first frame (mockup `regRun` + `regSchedule` @
// mc-baseline-w1). The installer's smoke session reports line by line; the
// moment the first frame lands the card flips to connected and the app opens,
// automatically after a short countdown or at once from the button. There is no
// Done button: the frame is the completion.
//
// The script comes from the read port; outside fixture mode it is NotBacked (G15)
// and the page renders that state instead of this island.
import Link from "next/link";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { buttonPrimary, mono, panel } from "@/ui/control-styles";
import type { FirstFrameScript } from "../model";
import type { FlowMode } from "../steps";
import { TierBadge } from "@/ui/tier-badge";

export const AUTO_OPEN_SECONDS = 6;

export type FirstFramePanelProps = {
  mode: FlowMode;
  script: FirstFrameScript;
  agentKey: string;
  harnessLabel: string;
  openHref: string;
};

/** How many log lines show after `ticks` polls; the first-frame line lands last. */
export function linesShown(ticks: number, total: number): number {
  return Math.max(0, Math.min(ticks, total));
}

export function FirstFramePanel({
  mode,
  script,
  agentKey,
  harnessLabel,
  openHref,
}: FirstFramePanelProps) {
  const t = useTranslations("onboarding.run");
  const router = useRouter();
  const [ticks, setTicks] = useState(0);
  const [countdown, setCountdown] = useState(AUTO_OPEN_SECONDS);
  const total = script.log.length;
  const connected = ticks >= total;

  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => {
      setTicks((n) => n + 1);
    }, script.paceMs);
    return () => {
      clearTimeout(timer);
    };
  }, [ticks, connected, script.paceMs]);

  useEffect(() => {
    if (!connected) return;
    if (countdown <= 0) {
      router.push(openHref);
      return;
    }
    const timer = setTimeout(() => {
      setCountdown((n) => n - 1);
    }, 1000);
    return () => {
      clearTimeout(timer);
    };
  }, [connected, countdown, openHref, router]);

  if (connected) {
    return (
      <div className="flex min-w-0 flex-col">
        <section
          aria-labelledby="first-frame-connected-title"
          data-testid="first-frame-connected"
          className={`${panel} mt-5 min-w-0 overflow-hidden`}
        >
          <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
            <span className="inline-flex items-center gap-1.5 rounded border border-success/50 bg-success/10 px-2 py-0.5 text-xs font-semibold text-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-success" />
              {t("connected")}
            </span>
            <h2
              id="first-frame-connected-title"
              className="text-sm font-semibold text-foreground"
            >
              {t("received")}
            </h2>
            <span className={`${mono} ml-auto text-xs text-muted-foreground`}>
              {script.frames[0]?.at}
            </span>
          </div>
          <div className="flex flex-col gap-3 p-4">
            <ol
              className={`${mono} overflow-hidden rounded-lg border border-border text-xs`}
            >
              {script.frames.map((frame) => (
                <li
                  key={frame.seq}
                  className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-3 py-2 last:border-b-0"
                >
                  <span className="w-4 flex-none text-muted-foreground">
                    {frame.seq}
                  </span>
                  <span className="flex-none text-muted-foreground">
                    {frame.at}
                  </span>
                  <span className="flex-none text-foreground">
                    {frame.kind}
                  </span>
                  <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
                    {frame.body}
                  </span>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <TierBadge tier={script.tier} />
              <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
                {t("chain")}
              </span>
            </div>
            <p className="text-sm text-muted-foreground">
              {t("tierNote", { tier: script.tier })}
            </p>
          </div>
        </section>
        <div className="mt-5 flex flex-wrap items-center gap-2.5 sm:justify-end">
          <span
            role="status"
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >
            {t("autoOpen", { seconds: countdown })}
          </span>
          <Link
            href={openHref}
            className={buttonPrimary}
            data-testid="first-frame-open"
          >
            {mode === "gate" ? t("openGate") : t("openRegister")}
          </Link>
        </div>
      </div>
    );
  }

  const shown = script.log.slice(0, linesShown(ticks, total - 1));
  return (
    <div className="flex min-w-0 flex-col">
      <section
        aria-labelledby="first-frame-waiting-title"
        data-testid="first-frame-waiting"
        className={`${panel} mt-5 min-w-0 overflow-hidden`}
      >
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
          <span
            aria-hidden
            className="size-3.5 flex-none animate-spin rounded-full border-2 border-border border-t-primary motion-reduce:animate-none"
          />
          <h2
            id="first-frame-waiting-title"
            className="text-sm font-semibold text-foreground"
          >
            {t("waiting")}
          </h2>
          <span className={`${mono} ml-auto text-xs text-muted-foreground`}>
            {t("polling")}
          </span>
        </div>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap gap-2">
            <span
              className={`${mono} rounded border border-border px-1.5 py-0.5 text-xs text-foreground [overflow-wrap:anywhere]`}
            >
              {agentKey}
            </span>
            <span className="rounded border border-border px-1.5 py-0.5 text-xs text-foreground">
              {harnessLabel}
            </span>
            <span
              className={`${mono} rounded border border-border px-1.5 py-0.5 text-xs text-foreground`}
            >
              {script.host}
            </span>
          </div>
          <ol
            aria-live="polite"
            className={`${mono} grid text-xs leading-7 text-muted-foreground`}
          >
            {shown.map((line) => (
              <li key={line.at} className="flex min-w-0 gap-3">
                <span className="flex-none">{line.at}</span>
                <span className="min-w-0 text-foreground [overflow-wrap:anywhere]">
                  {line.text}
                </span>
              </li>
            ))}
            <li className="flex gap-3">
              <span className="w-[4.5em] flex-none" />
              <span>{t("waitingLine")}</span>
            </li>
          </ol>
          <p className="text-sm text-muted-foreground">
            {t("waitingHint", { harness: harnessLabel, host: script.host })}
          </p>
        </div>
      </section>
      <p className="mt-5 text-xs text-muted-foreground sm:text-right">
        {t("noDone")}
      </p>
    </div>
  );
}
