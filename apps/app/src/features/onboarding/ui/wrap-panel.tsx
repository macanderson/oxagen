"use client";
// Step 2 of both flows: wrap Claude Code or Codex with the one-click installer,
// or an SDK agent with five lines (mockup `regWrap` @ mc-baseline-w1).
//
// Feedback 2 (docs/feedback-mockups.md @ mc-baseline-w1): in the mockup the
// content drifted right when switching between Claude Code, Codex and the SDK
// agent, because the card sized itself to whichever panel was showing (long
// unbroken token and code lines widened the grid track). Here the card's width
// comes from its container only: every grid track is minmax(0, …), every column
// is min-w-0, tokens break anywhere and code scrolls inside its own box. The
// e2e spec asserts the card's box does not move across the three tabs.
import Link from "next/link";
import type { Route } from "next";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { EnforcementTier } from "@/data/contracts/common";
import {
  buttonPrimary,
  buttonSecondary,
  eyebrow,
  mono,
  panel,
} from "@/ui/control-styles";
import { enrollCommand, sdkSnippet } from "../agent-key";
import type { InstallerOffer } from "../model";
import {
  type Harness,
  type Platform,
  type SdkLanguage,
  type WrapMethod,
  WRAP_METHODS,
} from "../steps";
import { TabList, TabPanel } from "@/ui/tabs";
import { TierBadge } from "@/ui/tier-badge";

export type WrapPanelProps = {
  agentKey: string;
  initialMethod: WrapMethod;
  initialHarness: Harness;
  /** The installer offer when backed; null renders `installerNotice` instead. */
  installer: InstallerOffer | null;
  installerNotice?: ReactNode;
  /** The run step's path and the query it keeps; the chosen harness is added on the way. */
  runPath: string;
  runQuery: Record<string, string>;
  backHref: string;
};

const PLATFORMS: readonly Platform[] = ["macos", "windows", "linux"];
const LANGUAGES: readonly SdkLanguage[] = ["ts", "py", "go"];

export function harnessFor(method: WrapMethod, current: Harness): Harness {
  if (method !== "sdk") return method;
  return current === "claude-code" || current === "codex-cli"
    ? "custom"
    : current;
}

function Earns({
  rows,
}: {
  rows: ReadonlyArray<{ label: string; tier: EnforcementTier; extra?: string }>;
}) {
  return (
    <ul className="grid overflow-hidden rounded-lg border border-border text-sm">
      {rows.map((row) => (
        <li
          key={row.label}
          className="flex min-w-0 flex-wrap items-center gap-2.5 border-b border-border px-3 py-2 last:border-b-0"
        >
          <span className="min-w-0 flex-1 text-foreground">{row.label}</span>
          <TierBadge tier={row.tier} />
          {row.extra ? (
            <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">
              {row.extra}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function WrapPanel(props: WrapPanelProps) {
  const t = useTranslations("onboarding.wrap");
  const [method, setMethod] = useState<WrapMethod>(props.initialMethod);
  const [platform, setPlatform] = useState<Platform>("macos");
  const [language, setLanguage] = useState<SdkLanguage>("ts");
  const [copied, setCopied] = useState(false);
  const harness = harnessFor(method, props.initialHarness);
  const runHref =
    `${props.runPath}?${new URLSearchParams({ ...props.runQuery, harness }).toString()}` as Route;
  const installer = props.installer;
  const snippet = sdkSnippet(language, props.agentKey);

  const earns =
    method === "claude-code"
      ? [
          { label: t("earns.modelCalls"), tier: "gateway" as const },
          { label: t("earns.mcpToolCalls"), tier: "gateway" as const },
          { label: t("earns.nativeTools"), tier: "harness" as const },
        ]
      : method === "codex-cli"
        ? [
            { label: t("earns.modelCalls"), tier: "gateway" as const },
            { label: t("earns.mcpToolCalls"), tier: "gateway" as const },
            {
              label: t("earns.nativeShell"),
              tier: "harness" as const,
              extra: t("orObserve"),
            },
          ]
        : [
            { label: t("earns.modelCalls"), tier: "gateway" as const },
            { label: t("earns.toolCalls"), tier: "gateway" as const },
          ];

  const tabClass = (selected: boolean) =>
    `flex min-w-0 flex-col items-start gap-0.5 border-r border-b-2 border-r-border px-3.5 py-3 text-left last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
      selected
        ? "border-b-tab-border-active bg-accent text-foreground"
        : "border-b-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
    }`;
  const segmentClass = (selected: boolean) =>
    `flex-1 rounded px-1 py-1.5 text-xs focus-visible:outline-2 focus-visible:outline-ring ${selected ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`;

  return (
    <div className="flex min-w-0 flex-col">
      <div
        data-testid="wrap-card"
        className={`${panel} mt-5 w-full min-w-0 overflow-hidden`}
      >
        <TabList
          label={t("methodsLabel")}
          idPrefix="wrap-method"
          value={method}
          onChange={setMethod}
          className="grid grid-cols-3 border-b border-border"
          tabClassName={tabClass}
          items={WRAP_METHODS.map((m) => ({
            id: m,
            label: (
              <>
                <span className="text-sm font-semibold whitespace-nowrap">
                  {t(`methods.${m}.name`)}
                </span>
                <span className="hidden max-w-full truncate font-mono text-[11px] sm:block">
                  {t(`methods.${m}.sub`)}
                </span>
              </>
            ),
          }))}
        />
        <TabPanel
          idPrefix="wrap-method"
          value={method}
          className="grid grid-cols-1 items-start gap-4 p-4 sm:p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,21.5rem)]"
        >
          <div className="flex min-w-0 flex-col gap-3">
            <h2 className="flex flex-wrap items-center gap-2 text-base font-semibold text-foreground">
              {t(`methods.${method}.name`)}
              {method === "claude-code" ? (
                <span className="rounded border border-success/50 bg-success/10 px-1.5 py-0.5 text-xs font-medium text-foreground">
                  {t("recommended")}
                </span>
              ) : null}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {method === "claude-code"
                ? t("claudeCode")
                : method === "codex-cli"
                  ? t("codex")
                  : t("sdk")}
            </p>
            <p className="sr-only">{t("earnsLabel")}</p>
            <Earns rows={earns} />
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t("tierNote")}
            </p>
          </div>

          <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-border bg-background p-3.5">
            {method === "sdk" ? (
              <>
                <p className={eyebrow}>{t("credentialLabel")}</p>
                {installer ? (
                  <>
                    <p
                      className={`${mono} rounded-lg border border-dashed border-border bg-muted px-2.5 py-2 text-xs leading-relaxed [overflow-wrap:anywhere]`}
                    >
                      {t("credentialIssued")}
                      <br />
                      <b className="break-all text-foreground">
                        {installer.sdkCredentialMasked}
                      </b>
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {t("credentialNote")}
                    </p>
                  </>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    {t("credentialNotBacked")}
                  </p>
                )}
                <pre
                  tabIndex={0}
                  className="max-w-full overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs"
                >
                  <code>$ {snippet.install}</code>
                </pre>
              </>
            ) : (
              <>
                <p className={eyebrow}>{t("download")}</p>
                {installer ? (
                  <>
                    <TabList
                      label={t("platformsLabel")}
                      idPrefix="wrap-platform"
                      value={platform}
                      onChange={setPlatform}
                      className="flex gap-1 rounded-lg border border-border bg-muted p-0.5"
                      tabClassName={segmentClass}
                      items={PLATFORMS.map((p) => ({
                        id: p,
                        label: t(`platforms.${p}`),
                      }))}
                    />
                    <TabPanel
                      idPrefix="wrap-platform"
                      value={platform}
                      className="flex min-w-0 flex-col gap-2.5"
                    >
                      <Link
                        href={runHref}
                        className={buttonPrimary}
                        data-testid="wrap-download"
                      >
                        {t("downloadFor", {
                          platform: t(`platforms.${platform}`),
                        })}
                      </Link>
                      <p
                        className={`${mono} text-[11px] leading-relaxed text-muted-foreground [overflow-wrap:anywhere]`}
                      >
                        {installer.builds[platform].file}
                        <br />
                        {installer.builds[platform].size} ·{" "}
                        {installer.builds[platform].signature}
                        <br />
                        {installer.builds[platform].digest}
                      </p>
                    </TabPanel>
                    <p
                      className={`${mono} rounded-lg border border-dashed border-border bg-muted px-2.5 py-2 text-xs leading-relaxed`}
                    >
                      {t("tokenLabel")}
                      <br />
                      <b className="break-all text-foreground">
                        {installer.token}
                      </b>
                      <br />
                      <span className="text-muted-foreground">
                        {t("tokenExpires", {
                          minutes: installer.tokenExpiresInMinutes,
                        })}
                      </span>
                    </p>
                  </>
                ) : (
                  props.installerNotice
                )}
                <span className="text-xs text-muted-foreground">
                  {t("orRun")}
                </span>
                <pre
                  tabIndex={0}
                  className="max-w-full overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs"
                >
                  <code>{enrollCommand(method, installer?.token ?? null)}</code>
                </pre>
              </>
            )}
          </div>

          {method === "sdk" ? (
            <div className="flex min-w-0 flex-col gap-2.5 md:col-span-2">
              <div className="flex flex-wrap items-center gap-2">
                <TabList
                  label={t("languagesLabel")}
                  idPrefix="wrap-language"
                  value={language}
                  onChange={setLanguage}
                  className="flex w-full max-w-xs gap-1 rounded-lg border border-border bg-muted p-0.5"
                  tabClassName={segmentClass}
                  items={LANGUAGES.map((l) => ({
                    id: l,
                    label: t(`languages.${l}`),
                  }))}
                />
                <button
                  type="button"
                  className={`${buttonSecondary} ml-auto min-h-8 px-3 py-1 text-xs`}
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(snippet.code)
                      .then(() => {
                        setCopied(true);
                      })
                      .catch(() => {
                        setCopied(false);
                      });
                  }}
                >
                  {copied ? t("copied") : t("copy")}
                </button>
              </div>
              <TabPanel idPrefix="wrap-language" value={language}>
                <pre
                  tabIndex={0}
                  data-testid="sdk-snippet"
                  className="max-w-full overflow-x-auto rounded-lg border border-border bg-muted px-3.5 py-3 font-mono text-xs leading-relaxed"
                >
                  <code>{snippet.code}</code>
                </pre>
              </TabPanel>
            </div>
          ) : null}
        </TabPanel>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2.5">
        <Link href={props.backHref} className={buttonSecondary}>
          {t("back")}
        </Link>
        <div className="flex flex-wrap items-center gap-2.5 sm:ml-auto">
          <span className="text-xs text-muted-foreground">{t("noDone")}</span>
          <Link
            href={runHref}
            className={buttonSecondary}
            data-testid="wrap-continue"
          >
            {t("alreadyInstalled")}
          </Link>
        </div>
      </div>
    </div>
  );
}
