// The pieces the Runtimes pages are drawn from (mockup `pRuntimes()`,
// `rtDetail()`, `rtHealth()` and `tierLadder()`): a titled panel with a count
// badge, a stat tile, the not-recorded value, the health badge, the platform
// and harness words, and the tier ladder. Presentational; each takes
// translated text or reads its own namespace.
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import type {
  RuntimeEnrollment,
  RuntimePlatform,
} from "@/data/contracts/runtimes";
import { Badge } from "@/ui/badge";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
  statNote,
  statTerm,
  statTile,
  statValue,
} from "@/ui/control-styles";

/**
 * Which backend gap a not-recorded value stands for. Each key is one GitHub
 * issue on macanderson/oxagen, carried as `data-gap` so a reader of the DOM
 * can find the change that fills it.
 */
const GAPS = {
  /** A host row per machine, and the host kind: enrollment is per agent. */
  host: "#3816",
  /** The tier rolled up per host from the per-run values. */
  tier: "#3817",
  /** The collector's telemetry gap count over 24 hours. */
  gaps: "#3818",
  /** The settings file the installer wrote, read back at check-in. */
  hooks: "#3818",
  /** The frame chain's last checkpoint per host. */
  checkpoint: "#3817",
  /** Starting a smoke session on a host from the console. */
  smoke: "#3819",
  /** The trace id of a failed read and the policy id that refused one. */
  decision: "#3841",
  /** A version for every harness on the host: enrollment records Claude Code's alone. */
  version: "#3919",
} as const;
type GapKey = keyof typeof GAPS;

/** A value no store records yet, with the gap that would record it. */
export function NotBacked({
  gap,
  children,
}: {
  gap: GapKey;
  /** What to say instead of the default "not recorded". */
  children?: ReactNode;
}) {
  const t = useTranslations("runtimes");
  return (
    <span
      data-not-backed={gap}
      data-gap={GAPS[gap]}
      className="text-muted-foreground"
    >
      {children ?? t("notRecorded")}
    </span>
  );
}

/** `.panel` with a flat `.panel-h`, its title, and an optional count badge. */
export function Panel({
  id,
  title,
  titleNode,
  count,
  aside,
  children,
}: {
  /** The heading's id, unique on the page. */
  id: string;
  title: string;
  /** A header richer than the title alone (the host panel's subtitle); the h2 still carries `title`. */
  titleNode?: ReactNode;
  /** The badge: a count, or a not-recorded value where no store counts it. */
  count?: number | ReactNode;
  /** A badge or control at the header's right edge. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className={`${panel} flex flex-col`}>
      <div className={panelHeader}>
        <div className="min-w-0 flex-1">
          <h2 id={id} className={panelTitle}>
            {title}
          </h2>
          {titleNode}
        </div>
        {count === undefined ? null : (
          <Badge tone="quiet" dot={false} data-testid={`${id}-count`}>
            {typeof count === "number" ? String(count) : count}
          </Badge>
        )}
        {aside}
      </div>
      {children}
    </section>
  );
}

/** `.panel-b .note`: a fact about the section, set off by the gold rule. */
export function Note({ children }: { children: ReactNode }) {
  return (
    <div className={panelBody}>
      <p className="border-l-2 border-accent-text pl-3 text-[13px] text-muted-foreground">
        {children}
      </p>
    </div>
  );
}

export function Tile({
  term,
  value,
  basis,
  testId,
}: {
  term: string;
  value: ReactNode;
  basis: string;
  testId: string;
}) {
  return (
    <dl data-testid={testId} className={statTile}>
      <dt className={statTerm}>{term}</dt>
      <dd className={statValue}>{value}</dd>
      <dd className={statNote}>{basis}</dd>
    </dl>
  );
}

/** A key-value list (`dl.kv`), the host panel's body. */
export function Facts({
  rows,
}: {
  rows: readonly { term: string; value: ReactNode; testId: string }[];
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-[minmax(8rem,auto)_1fr]">
      {rows.map((row) => (
        <Fragment key={row.term}>
          <dt className="text-muted-foreground">{row.term}</dt>
          <dd
            data-testid={row.testId}
            className="min-w-0 break-words pb-2 sm:pb-0"
          >
            {row.value}
          </dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** A second line under a value, in the muted ink. */
export function Sub({
  children,
  monoFace = false,
}: {
  children: ReactNode;
  monoFace?: boolean;
}) {
  return (
    <span
      // Under a numeric cell the sub-line keeps its own face and wraps: the
      // cell's mono and nowrap are for the figure above it.
      className={`block whitespace-normal text-xs text-muted-foreground ${monoFace ? mono : "font-sans"}`}
    >
      {children}
    </span>
  );
}

/**
 * Whether the enrollment still stands: not revoked, and not past its expiry.
 * `tacho-host.ts` refuses a revoked host and then an expired one, so a check
 * that read only the stored word would call a host enrolled while every
 * request it makes is refused.
 */
export function isEnrolled(host: RuntimeEnrollment, now: number): boolean {
  return host.status !== "revoked" && Date.parse(host.expiresAt) > now;
}

/**
 * `rtHealth()`, in the design's three words: healthy, degraded and not
 * enrolled. A revoked or expired enrollment is not enrolled, a dot and a word
 * so the state survives greyscale. Healthy and degraded are judged from the
 * collector's telemetry gaps in 24 hours, which nothing records (#3818), so an
 * enrolled host's health is not recorded rather than a green word the record
 * cannot back.
 */
export function HealthBadge({
  host,
  now,
  children,
}: {
  host: RuntimeEnrollment;
  now: number;
  /** What to say for an enrolled host instead of the default "not recorded". */
  children?: ReactNode;
}) {
  const t = useTranslations("runtimes.health");
  if (!isEnrolled(host, now))
    return (
      <Badge tone="quiet" data-health="not_enrolled">
        {t("notEnrolled")}
      </Badge>
    );
  return (
    <span data-health="not_recorded">
      <NotBacked gap="gaps">{children}</NotBacked>
    </span>
  );
}

export function PlatformName({ platform }: { platform: RuntimePlatform }) {
  const t = useTranslations("runtimes.platform");
  return t(platform);
}

/**
 * The operating system as the host reported it at enrollment, the way the
 * design prints it: "macOS 15.6 · arm64". A host whose installer predates the
 * two fields reported neither, and the line says so rather than stopping at
 * the platform's name.
 */
export function OsLine({ host }: { host: RuntimeEnrollment }) {
  const t = useTranslations("runtimes");
  const name = t(`platform.${host.platform}`);
  const os = host.osVersion === null ? name : `${name} ${host.osVersion}`;
  if (host.osVersion === null && host.arch === null)
    return t("os.unreported", { os });
  return host.arch === null ? os : `${os} · ${host.arch}`;
}

const HARNESS_NAMES = [
  "claude-code",
  "codex",
  "cursor",
  "stella",
  "claude-agent-sdk",
  "custom",
] as const;
type HarnessName = (typeof HARNESS_NAMES)[number];

function isHarnessName(value: string): value is HarnessName {
  return HARNESS_NAMES.some((name) => name === value);
}

/** A harness by its product name; a name this build does not know, as the daemon sent it. */
export function HarnessLabel({ harness }: { harness: string }) {
  const t = useTranslations("runtimes.harness");
  return isHarnessName(harness) ? t(harness) : harness;
}

/**
 * The harnesses the daemon reported, each by its product name and its
 * version in mono, as the design draws them. Enrollment records Claude Code's
 * version alone, and only as it was at enrollment, so that version says "at
 * enrollment" and every other harness's version is not recorded (#3919).
 */
export function HarnessNames({ host }: { host: RuntimeEnrollment }) {
  const t = useTranslations("runtimes.harness");
  if (host.harnesses.length === 0)
    return <span className="text-muted-foreground">{t("none")}</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {host.harnesses.map((harness) => (
        <span key={harness} data-harness={harness}>
          <HarnessLabel harness={harness} />{" "}
          {harness === "claude-code" && host.claudeVersionAtEnroll !== null ? (
            <span className="text-muted-foreground">
              <span className={mono}>{host.claudeVersionAtEnroll}</span>{" "}
              <span className="text-xs">{t("atEnrollment")}</span>
            </span>
          ) : (
            <span className="text-xs">
              <NotBacked gap="version">{t("versionUnrecorded")}</NotBacked>
            </span>
          )}
        </span>
      ))}
    </span>
  );
}

/** Where the harness sends its model calls, as last reported, or not reported. */
export function ModelSurface({ host }: { host: RuntimeEnrollment }) {
  const t = useTranslations("runtimes.modelSurface");
  if (host.modelRoute === null)
    return <span className="text-muted-foreground">{t("unreported")}</span>;
  return (
    <span>
      {t(host.modelRoute)}
      {host.shadowedBy === null ? null : (
        <Sub monoFace>{t("shadowed", { file: host.shadowedBy })}</Sub>
      )}
    </span>
  );
}

const RUNGS = ["observe", "harness", "gateway", "contained"] as const;

/**
 * `tierLadder(null)`: the four rungs in order, each with what it needs and
 * what it earns, two to a row on a phone and four on a wide screen. No rung is
 * marked current: a tier is a run's, and this page reads no run.
 */
export function TierLadder() {
  const t = useTranslations("runtimes.ladder");
  return (
    <ol
      aria-label={t("label")}
      data-testid="tier-ladder"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-border bg-border lg:grid-cols-4"
    >
      {RUNGS.map((rung) => (
        <li
          key={rung}
          data-rung={rung}
          className="bg-card px-3.5 py-3 text-xs text-muted-foreground"
        >
          <b className={`${mono} mb-1 block text-[13px] text-foreground`}>
            {rung}
          </b>
          {t(rung)}
        </li>
      ))}
    </ol>
  );
}
