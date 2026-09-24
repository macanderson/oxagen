"use client";
// The signed installer package's own screens (mockup `obInstaller`): Download,
// Installing and Connected, in the auth shell's wide card, with the switch row
// under it. They are shown so the path from sign-up to the first frame can be
// walked; the package renders them, and nothing here writes from the browser.
//
// - Download names the organization and workspace the host enrols to. No
//   signed package is published, so its name, size, signature and checksum say
//   so; the one-time token is embedded by the package and shown once on the
//   wrap step, never carried in this page's URL.
// - Installing walks the package's eight documented steps.
// - Connected reads the record: the gate's first frame and the run it opened.
//   Until that frame lands it says the host is not connected, rather than
//   drawing a frame that does not exist.
// - The rejected-token screen is the package's answer when `enroll_host`
//   refuses a used token. The browser has no record of that refusal yet, so
//   the page passes `rejected` only when one is read.
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  mono,
  panel,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";

const STEPS = [
  "collector",
  "hook",
  "login",
  "hooks",
  "policy",
  "mcp",
  "enroll",
  "smoke",
] as const;
const SCREENS = ["download", "installing", "connected"] as const;
type Screen = (typeof SCREENS)[number];

/** Milliseconds between two install steps, as the package paces them. */
export const INSTALL_STEP_MS = 380;

function monoChunk(chunks: ReactNode) {
  return <span className={mono}>{chunks}</span>;
}

function bold(chunks: ReactNode) {
  return <b className="font-semibold text-foreground">{chunks}</b>;
}

export function InstallerScreens({
  org,
  workspace,
  agentKey,
  connected,
  rejected,
  wrap,
  run,
}: {
  org: string;
  workspace: string;
  agentKey: string | null;
  /** The gate's first frame and its run; null until it lands. */
  connected: { at: string; runId: string } | null;
  /** A refused token as the record holds it; null when none is read. */
  rejected: { token: string; at: string; host: string } | null;
  wrap: SafePath;
  run: SafePath;
}) {
  const t = useTranslations("onboarding.welcome.installer");
  const format = useFormatter();
  const [screen, setScreen] = useState<Screen>("download");
  const [done, setDone] = useState(0);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!installing) return;
    const timer = setTimeout(() => {
      if (done + 1 >= STEPS.length) {
        setDone(STEPS.length);
        setInstalling(false);
        setScreen("connected");
      } else setDone(done + 1);
    }, INSTALL_STEP_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [installing, done]);

  function show(next: Screen) {
    setInstalling(false);
    setDone(next === "connected" ? STEPS.length : 0);
    setScreen(next);
  }

  const time = (instant: string) =>
    format.dateTime(new Date(instant), { timeStyle: "medium" });
  const notPublished = (
    <span className="text-muted-foreground">{t("notPublished")}</span>
  );

  let body: ReactNode;
  if (rejected !== null) {
    body = (
      <div data-testid="installer-rejected" className="flex flex-col gap-2">
        <h2 className="text-[19px] font-semibold">{t("rejectedTitle")}</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t.rich("rejectedBody", {
            token: rejected.token,
            at: format.dateTime(new Date(rejected.at), {
              dateStyle: "medium",
              timeStyle: "short",
            }),
            host: rejected.host,
            mono: monoChunk,
          })}
        </p>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t("rejectedNext")}
        </p>
        <SafeLink
          to={wrap}
          className={`${buttonSecondary} mt-2 self-start max-md:w-full`}
        >
          {t("backToWrap")}
        </SafeLink>
      </div>
    );
  } else if (screen === "download") {
    body = (
      <div data-testid="installer-download" className="flex flex-col gap-3">
        <h2 className="text-[19px] font-semibold">{t("downloadTitle")}</h2>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t.rich("downloadBody", { org, workspace, b: bold })}
        </p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-2 text-[13px] max-sm:grid-cols-1 max-sm:gap-y-0.5 max-sm:[&>dd]:mb-2">
          <dt className="text-muted-foreground">{t("facts.package")}</dt>
          <dd data-testid="installer-package">{notPublished}</dd>
          <dt className="text-muted-foreground">{t("facts.size")}</dt>
          <dd>{notPublished}</dd>
          <dt className="text-muted-foreground">{t("facts.signature")}</dt>
          <dd>{notPublished}</dd>
          <dt className="text-muted-foreground">{t("facts.checksum")}</dt>
          <dd>{notPublished}</dd>
          <dt className="text-muted-foreground">{t("facts.token")}</dt>
          <dd className="text-muted-foreground">{t("tokenOnWrap")}</dd>
        </dl>
        <div className="mt-1 flex flex-wrap gap-2.5 max-md:flex-col">
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => {
              setScreen("installing");
              setDone(0);
              setInstalling(true);
            }}
          >
            {t("install")}
          </button>
          <SafeLink to={wrap} className={buttonSecondary}>
            {t("cancel")}
          </SafeLink>
        </div>
        <p className="text-xs text-muted-foreground">{t("userOnly")}</p>
      </div>
    );
  } else if (screen === "installing") {
    const n = Math.min(done + 1, STEPS.length);
    body = (
      <div data-testid="installer-installing" className="flex flex-col gap-3">
        <h2 className="text-[19px] font-semibold">{t("installingTitle")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("stepOf", { n, total: STEPS.length })}
        </p>
        <div
          role="progressbar"
          aria-label={t("progress")}
          aria-valuemin={0}
          aria-valuemax={STEPS.length}
          aria-valuenow={done}
          className="h-1.5 overflow-hidden rounded-full bg-hl"
        >
          <i
            className="block h-full bg-accent-text transition-[width]"
            style={{
              width: `${String(Math.round((done / STEPS.length) * 100))}%`,
            }}
          />
        </div>
        <ol className="flex flex-col gap-1.5 font-mono text-[12px]">
          {STEPS.map((step, index) => {
            const state =
              index < done ? "done" : index === done ? "now" : "pending";
            return (
              <li
                key={step}
                data-state={state}
                className={`flex gap-2.5 ${state === "pending" ? "text-muted-foreground" : "text-foreground"}`}
              >
                <span aria-hidden="true" className="w-3 flex-none">
                  {state === "done" ? "✓" : state === "now" ? "›" : "·"}
                </span>
                <span>{t(`steps.${step}`)}</span>
                <span className="sr-only">{t(`stepState.${state}`)}</span>
              </li>
            );
          })}
        </ol>
      </div>
    );
  } else {
    body = (
      <div data-testid="installer-connected" className="flex flex-col gap-3">
        {connected === null ? (
          <>
            <h2 className="text-[19px] font-semibold">
              {t("notConnectedTitle")}
            </h2>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t("notConnectedBody")}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Badge tone="allowed">{t("connected")}</Badge>
              <span className="ml-auto font-mono text-[11.5px] text-muted-foreground">
                {time(connected.at)}
              </span>
            </div>
            <h2 className="text-[19px] font-semibold">
              {t("connectedTitle", { org })}
            </h2>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {agentKey === null
                ? t("connectedBodyNoKey")
                : t.rich("connectedBody", { key: agentKey, k: monoChunk })}
            </p>
            <div className="flex gap-3 overflow-x-auto whitespace-nowrap rounded-lg border border-border px-3 py-2 font-mono text-[12px]">
              <span className="text-muted-foreground">0</span>
              <span className="text-muted-foreground">
                {time(connected.at)}
              </span>
              <span>{t("frameBody", { run: connected.runId })}</span>
            </div>
          </>
        )}
        <p className="text-[12.5px] leading-relaxed text-muted-foreground">
          {t("rollback")}
        </p>
        <pre className="overflow-x-auto rounded-lg border border-border bg-hl px-3 py-2.5 font-mono text-[12px]">
          {t("rollbackCommand")}
        </pre>
        <div className="flex flex-wrap items-center gap-2.5 max-md:flex-col max-md:items-stretch">
          <SafeLink to={run} className={buttonPrimary}>
            {t("backToOxagen")}
          </SafeLink>
          <span className="text-xs text-muted-foreground">
            {t("unlocking")}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 max-w-xl flex-col gap-3.5">
      <section className={panel}>
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <h3 className="text-[14px] font-semibold">{t("title")}</h3>
          <span className="ml-auto truncate font-mono text-[11.5px] text-muted-foreground">
            {t("notPublished")}
          </span>
        </div>
        <div className="px-[18px] py-4">{body}</div>
      </section>
      {rejected !== null ? null : (
        <div
          role="group"
          aria-label={t("screenLabel")}
          className="flex flex-wrap items-center justify-center gap-2"
        >
          <span className="text-xs text-muted-foreground">
            {t("screenLabel")}
          </span>
          {SCREENS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={screen === s}
              onClick={() => {
                show(s);
              }}
              className={`${buttonSecondary} text-xs ${screen === s ? "font-semibold" : "border-transparent bg-transparent"}`}
            >
              {t(`screens.${s}`)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
