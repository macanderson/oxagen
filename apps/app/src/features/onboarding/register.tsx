// Register an agent (#2967, ADR-065 decision 1; register-name, register-wrap
// and register-run specs in the roadmap's mockups/pages): name the agent, wrap
// it, and wait for the first frame, one step per `[step]` segment over
// `register_agent`, `create_enrollment_token` and `get_first_frame`.
//
// The page is a gate: the brandmark, the signed-in email and Cancel, the
// three-step rail, the step, and the caption under it. The shell and the rail
// render before any step read, and the step renders inside the route's
// <Suspense>, so the loading state keeps the operator's bearings.
//
// The identity the name step mints is carried forward as `?agent=`, so a
// reload lands back on the same registration. The run step's wait is the
// contract's own long poll (§3.5): the handler waits inside one invoke, and
// the page re-reads only while a host is enrolled, so an open page costs one
// call per wait rather than one per tick.
//
// Every step is read-gated on the permission `register_agent` enforces, an
// organization Owner or Admin (INV-29). A viewer without it sees the denied
// state naming what is missing, and every write is refused in its handler too.
import "server-only";
import { randomUUID } from "node:crypto";
import { OxagenWordmark } from "@oxagen/ui";
import { Lock } from "lucide-react";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import type { FirstFrame, OnboardingGate } from "@/data/contracts/onboarding";
import type { RunChain, RunDetail } from "@/data/contracts/run";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { getAuthUser } from "@/server/session";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonSecondary,
  eyebrow,
  linkText,
  mono,
  panel,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import type { Harness } from "./agent-form";
import type { OnboardingFailure } from "./failure";
import { useOnboardingFailure } from "./failure";
import { StepRail, type RailStep } from "./rail";
import { type RegisterPlace, readRegisterPlace } from "./register-actions";
import { type RegisterStep, registerRail, stepNumber } from "./steps";
import { CancelRegistration } from "./ui/cancel-registration";
import { CheckAgain, FirstFramePoll, OpenInFleet } from "./ui/first-frame";
import { RegisterAgentForm, type ReservedAgent } from "./ui/register-form";
import { RequestAccess } from "./ui/request-access";
import { WrapAgent } from "./ui/wrap-agent";

/**
 * The server-side wait for one read of `get_first_frame`, inside the budget the
 * contract allows (`WAIT_MS_MAX`, packages/oxagen/src/contracts/run.get.ts).
 * The handler returns as soon as a frame lands, so this is the longest a page
 * render blocks and the shortest interval between two invokes while it waits.
 */
const FIRST_FRAME_WAIT_MS = 20_000;

/** The organization roles `register_agent` admits (its `defaultRoles`, checked in the handler). */
const REGISTERING_ROLES: ReadonlySet<WsCtx["orgRole"]> = new Set([
  "owner",
  "admin",
]);

/** Where each hook-based harness writes its hooks, for the log line the collector's report backs. */
const HOOK_FILE: Partial<Record<Harness, string>> = {
  "claude-code": "~/.claude/settings.json",
  codex: "~/.codex/config.toml",
  cursor: "~/.cursor/hooks.json",
};

type Place = { org: string; ws: string };

const column = "mx-auto flex w-full max-w-[772px] flex-col";
const footer = "flex flex-col gap-2 md:flex-row md:items-center";
const phoneWide = "max-md:w-full";

/** A viewer the page lets register: the same rule the handler applies to every write. */
function mayRegister(ctx: WsCtx): boolean {
  return REGISTERING_ROLES.has(ctx.orgRole);
}

function Rail({
  step,
  place,
  agent,
}: {
  step: RegisterStep;
  place: Place;
  agent: string | null;
}) {
  const t = useTranslations("onboarding.register");
  const steps: RailStep[] = registerRail(step, place, agent).map((item) => ({
    key: item.step,
    label: t(`steps.${item.step}`),
    state: item.state,
    stateLabel: t(`state.${item.state}`),
    to: item.to,
  }));
  return <StepRail label={t("railLabel")} steps={steps} />;
}

function TopBar({
  email,
  place,
  agent,
}: {
  email: string | null;
  place: Place;
  agent: string | null;
}) {
  const brand = useTranslations("ui.brand");
  const fleet = routes.fleet(place.org, place.ws);
  return (
    <header className="flex items-center gap-3 py-[18px]">
      <SafeLink
        to={fleet}
        aria-label={brand("home")}
        className="inline-flex items-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        <OxagenWordmark className="h-6" />
      </SafeLink>
      {email === null ? null : (
        <span
          data-testid="register-email"
          className={`${mono} ml-auto truncate text-xs text-muted-foreground max-md:sr-only`}
        >
          {email}
        </span>
      )}
      <CancelRegistration
        org={place.org}
        ws={place.ws}
        agentId={agent}
        fleet={fleet}
        testId="register-cancel-top"
        className={email === null ? "ml-auto" : "max-md:ml-auto"}
      />
    </header>
  );
}

function Caption() {
  const t = useTranslations("onboarding.register");
  return (
    <p className="mx-auto mt-[22px] max-w-[772px] text-center text-xs text-muted-foreground">
      {t("caption")}
    </p>
  );
}

/**
 * The gate every register step sits in (mockup `regShell`): top bar, rail, the
 * step, and the caption. There is no sidebar and no top bar of the app in the
 * design; the organization layout still draws them around this route until the
 * shell carries a gate frame, so this is the page body inside it.
 */
export async function RegisterGate({
  ctx,
  step,
  agent,
  children,
}: {
  ctx: WsCtx;
  step: RegisterStep;
  agent: string | null;
  children: ReactNode;
}) {
  const user = await getAuthUser();
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug };
  return (
    <main
      id="main"
      data-testid="register-gate"
      className="flex w-full flex-col bg-app-canvas px-4 pb-14"
    >
      <div className={column}>
        <TopBar
          email={user === null ? null : user.email}
          place={place}
          agent={mayRegister(ctx) ? agent : null}
        />
        <Rail step={step} place={place} agent={agent} />
        <div className="flex flex-col gap-[18px] pt-7">{children}</div>
      </div>
      <Caption />
    </main>
  );
}

/** The loading state (register specs, States): four tile blocks and a panel of seven rows under the rail. */
export function RegisterSkeleton() {
  const t = useTranslations("onboarding.register");
  const block = "animate-pulse bg-hl motion-reduce:animate-none";
  return (
    <div
      data-testid="register-loading"
      role="status"
      className="flex flex-col gap-4"
    >
      <span className="sr-only">{t("loading")}</span>
      <div
        aria-hidden="true"
        className="grid grid-cols-2 gap-3.5 md:grid-cols-4"
      >
        {[0, 1, 2, 3].map((n) => (
          <div
            key={n}
            className={`${block} h-16 rounded-xl border border-border`}
          />
        ))}
      </div>
      <div aria-hidden="true" className={`${panel} flex flex-col`}>
        <div className="border-b border-border bg-hl px-4 py-3">
          <div className={`${block} h-4 w-44 rounded`} />
        </div>
        <div className="flex flex-col gap-2 p-4">
          {[0, 1, 2, 3, 4, 5, 6].map((n) => (
            <div key={n} className={`${block} h-9 rounded-lg`} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StepHeader({
  step,
  lead = null,
}: {
  step: RegisterStep;
  /** Null when the sentence needs an agent key the step could not read. */
  lead?: ReactNode;
}) {
  const t = useTranslations("onboarding.register");
  return (
    <div className="flex flex-col gap-2">
      <p className={eyebrow}>{t("eyebrow", { n: stepNumber(step) })}</p>
      <h1 className="text-[26px] font-bold tracking-tight text-foreground">
        {t(`${step}.title`)}
      </h1>
      {lead === null ? null : (
        <p className="max-w-xl text-[14.5px] text-muted-foreground">{lead}</p>
      )}
    </div>
  );
}

/** The step's lead with the agent key in monospace, or the bare sentence when the key cannot be read. */
function KeyLead({
  step,
  agentKey,
}: {
  step: "wrap" | "run";
  agentKey: string;
}) {
  const t = useTranslations("onboarding.register");
  return (
    <>
      {t.rich(`${step}.lead`, {
        key: agentKey,
        mono: (chunks) => <span className={mono}>{chunks}</span>,
      })}
    </>
  );
}

function Denied({ ctx, viewer }: { ctx: WsCtx; viewer: string }) {
  const t = useTranslations("onboarding.register.denied");
  const permission = t("permission", { ws: ctx.wsSlug });
  return (
    <section
      data-testid="register-denied"
      className="flex flex-col items-center gap-3 py-10 text-center"
    >
      <span className="inline-flex size-11 items-center justify-center rounded-xl border border-error/40 text-error-ink">
        <Lock aria-hidden className="size-4" />
      </span>
      <h1 className="text-lg font-semibold text-foreground">{t("title")}</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        {t.rich("body", {
          org: ctx.orgName,
          b: (chunks) => (
            <b className="font-semibold text-foreground">{chunks}</b>
          ),
          code: (chunks) => (
            <span className={`${mono} rounded bg-hl px-1`}>{chunks}</span>
          ),
          permission,
        })}
      </p>
      <div className={`${footer} justify-center max-md:w-full`}>
        <RequestAccess permission={permission} />
        <SafeLink
          to={routes.fleet(ctx.orgSlug, ctx.wsSlug)}
          className={`${buttonSecondary} ${phoneWide}`}
        >
          {t("back")}
        </SafeLink>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-5 gap-y-1.5 pt-3 text-left text-[13px]">
        <dt className="text-muted-foreground">{t("signedIn")}</dt>
        <dd>
          {viewer} · <span className={mono}>{ctx.orgRole}</span> ·{" "}
          <span className={mono}>{ctx.wsSlug}</span>
        </dd>
        <dt className="text-muted-foreground">{t("needed")}</dt>
        <dd className={mono}>{permission}</dd>
        <dt className="text-muted-foreground">{t("decidedBy")}</dt>
        <dd>{t("decidedByValue")}</dd>
      </dl>
    </section>
  );
}

function NoAgent({ place }: { place: Place }) {
  const t = useTranslations("onboarding.register.noAgent");
  return (
    <section data-testid="register-no-agent" className={`${panel} p-4`}>
      <h2 className="text-sm font-semibold">{t("title")}</h2>
      <p className="max-w-prose pt-1 text-sm text-muted-foreground">
        {t("body")}
      </p>
      <p className="pt-2">
        <SafeLink
          to={routes.register(place.org, place.ws, "name")}
          className={linkText}
        >
          {t("start")}
        </SafeLink>
      </p>
    </section>
  );
}

function StepFailure({ read }: { read: Exclude<Read<unknown>, { ok: true }> }) {
  const t = useTranslations("pages");
  return (
    <div className={`${panel} p-4`}>
      <ReadFailure read={read} section={t("register")} />
    </div>
  );
}

function PlaceFailure({ failure }: { failure: OnboardingFailure }) {
  const failureText = useOnboardingFailure();
  return (
    <div data-testid="register-place-failure" className={`${panel} p-4`}>
      <p className="text-sm text-muted-foreground">{failureText(failure)}</p>
    </div>
  );
}

/** The live credential the SDK tab names by its prefix; the secret is never read back. */
function livePrefix(detail: AgentDetail): string | null {
  return detail.credentials.find((c) => c.revokedAt === null)?.prefix ?? null;
}

type LogLine = { at: string; text: string };

/** The lines of the collector's report Oxagen holds, oldest first. A line nothing recorded is not drawn. */
function useLogLines(
  host: NonNullable<FirstFrame["host"]>,
  enrolled: AgentDetail["hosts"][number] | null,
  harness: Harness | null,
): LogLine[] {
  const t = useTranslations("onboarding.register.run.log");
  const format = useFormatter();
  const clock = (instant: string) =>
    format.dateTime(new Date(instant), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  const lines: LogLine[] = [
    {
      at: clock(host.enrolledAt),
      text:
        enrolled === null || enrolled.deviceKeyFingerprint === ""
          ? t("enrolledNoKey")
          : t("enrolled", { fingerprint: enrolled.deviceKeyFingerprint }),
    },
  ];
  const heartbeat = host.lastHeartbeatAt;
  if (heartbeat !== null) {
    const version = enrolled?.collectorVersion ?? null;
    lines.push({
      at: clock(heartbeat),
      text:
        version === null
          ? t("collectorNoVersion")
          : t("collector", { version }),
    });
  }
  const reportedAt = heartbeat ?? host.enrolledAt;
  if (host.hooksOk === true) {
    const file = harness === null ? undefined : HOOK_FILE[harness];
    lines.push({
      at: clock(reportedAt),
      text: file === undefined ? t("hooksOkNoFile") : t("hooksOk", { file }),
    });
  } else if (host.hooksOk === false) {
    lines.push({ at: clock(reportedAt), text: t("hooksMissing") });
  }
  const bundle = enrolled?.bundleVersionServed ?? null;
  if (bundle !== null) {
    lines.push({
      at: clock(enrolled?.lastSeenAt ?? reportedAt),
      text: t("bundle", { version: bundle }),
    });
  }
  return lines;
}

function Waiting({
  frame,
  detail,
  pollRevision,
}: {
  frame: FirstFrame;
  detail: AgentDetail | null;
  pollRevision: string;
}) {
  const t = useTranslations("onboarding.register.run.waiting");
  const logT = useTranslations("onboarding.register.run.log");
  const harnessT = useTranslations("agents.harness");
  const harness = detail?.identity.harness ?? null;
  const host = frame.host;
  const enrolled =
    host === null || detail === null
      ? null
      : (detail.hosts.find(
          (h) => h.hostEnrollmentId === host.hostEnrollmentId,
        ) ?? null);
  return (
    <section
      data-testid="first-frame-waiting"
      className={`${panel} flex flex-col`}
    >
      <FirstFramePoll revision={pollRevision} />
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span
          aria-hidden="true"
          className="size-3.5 flex-none animate-spin rounded-full border-2 border-border border-t-accent-text motion-reduce:animate-none"
        />
        <h2 className="text-[13.5px] font-semibold">{t("title")}</h2>
        <span className={`${mono} ml-auto text-[11px] text-muted-foreground`}>
          {t("polling")}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        <div data-testid="first-frame-chips" className="flex flex-wrap gap-2">
          {frame.agentKey === null ? null : (
            <Badge tone="quiet" dot={false} mono>
              {frame.agentKey}
            </Badge>
          )}
          {harness === null ? null : (
            <Badge tone="quiet" dot={false}>
              {harnessT(harness)}
            </Badge>
          )}
          <Badge tone="quiet" dot={false}>
            {enrolled === null
              ? t("noHost")
              : t("host", { hostname: enrolled.hostname })}
          </Badge>
        </div>
        {host === null ? (
          <LogBlock lines={[]} waiting={t("line")} />
        ) : (
          <HostLog
            host={host}
            enrolled={enrolled}
            harness={harness}
            waiting={t("line")}
          />
        )}
        <p className="text-[12.5px] text-muted-foreground">
          {enrolled === null || harness === null
            ? t("none")
            : t.rich("start", {
                harness: harnessT(harness),
                hostname: enrolled.hostname,
                host: (chunks) => <span className={mono}>{chunks}</span>,
              })}
        </p>
        {/* Not backed until #3901 lands. */}
        <p
          data-testid="not-backed"
          data-element="collector-log"
          className="text-xs text-muted-foreground"
        >
          {logT("notRecorded")}
        </p>
      </div>
    </section>
  );
}

function HostLog({
  host,
  enrolled,
  harness,
  waiting,
}: {
  host: NonNullable<FirstFrame["host"]>;
  enrolled: AgentDetail["hosts"][number] | null;
  harness: Harness | null;
  waiting: string;
}) {
  const lines = useLogLines(host, enrolled, harness);
  return <LogBlock lines={lines} waiting={waiting} />;
}

function LogBlock({ lines, waiting }: { lines: LogLine[]; waiting: string }) {
  return (
    <ol
      data-testid="first-frame-log"
      className={`${mono} flex flex-col gap-1 overflow-x-auto text-[11.5px]`}
    >
      {lines.map((line) => (
        <li
          key={`${line.at}-${line.text}`}
          className="flex gap-3 whitespace-nowrap"
        >
          <span className="w-16 flex-none text-muted-foreground">
            {line.at}
          </span>
          <span>{line.text}</span>
        </li>
      ))}
      <li className="flex gap-3 whitespace-nowrap">
        <span aria-hidden="true" className="w-16 flex-none" />
        <span className="text-muted-foreground">{waiting}</span>
      </li>
    </ol>
  );
}

function Received({
  receivedAt,
  run,
  chain,
}: {
  receivedAt: string;
  run: Read<RunDetail>;
  chain: Read<RunChain>;
}) {
  const t = useTranslations("onboarding.register.run.received");
  const format = useFormatter();
  const precise = (instant: string) =>
    format.dateTime(new Date(instant), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    });
  const chainIntact =
    chain.ok &&
    chain.value.complete &&
    chain.value.gaps.missingFrameCount === 0 &&
    chain.value.gaps.missingSequences.length === 0;
  return (
    <section
      data-testid="first-frame-received"
      className={`${panel} flex flex-col`}
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Badge tone="allowed">{t("connected")}</Badge>
        <h2 className="text-[13.5px] font-semibold">{t("title")}</h2>
        <span className={`${mono} ml-auto text-[11px] text-muted-foreground`}>
          {precise(receivedAt)}
        </span>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3.5">
        {run.ok ? (
          <ol
            data-testid="first-frames"
            className={`${mono} divide-y divide-border overflow-x-auto rounded-lg border border-border text-[11.5px]`}
          >
            {run.value.frames.frames.slice(0, 2).map((frame) => (
              <li
                key={frame.seq}
                className="flex gap-3 whitespace-nowrap px-3 py-2"
              >
                <span className="text-muted-foreground">{frame.seq}</span>
                <span className="text-muted-foreground">
                  {precise(frame.observedAt)}
                </span>
                <span className="text-foreground">{frame.type}</span>
                <span className="text-muted-foreground">{frame.summary}</span>
              </li>
            ))}
          </ol>
        ) : (
          <ReadFailure read={run} section={t("framesUnread")} />
        )}
        {chain.ok ? (
          <div
            data-testid="first-frame-badges"
            className="flex flex-wrap gap-2"
          >
            <Badge
              tone="quiet"
              dot={false}
              mono
              data-tier={chain.value.enforcementTier}
            >
              {chain.value.enforcementTier}
            </Badge>
            {chain.value.recordedGrade === null ? null : (
              <Badge tone="quiet" dot={false}>
                {t("grade", { grade: chain.value.recordedGrade })}
              </Badge>
            )}
            <Badge tone="quiet" dot={false}>
              {chainIntact
                ? t("chainIntact")
                : t("chainGaps", {
                    count: chain.value.gaps.missingFrameCount,
                  })}
            </Badge>
          </div>
        ) : (
          <ReadFailure read={chain} section={t("framesUnread")} />
        )}
        <p className="text-[12.5px] text-muted-foreground">
          {t("routed")}{" "}
          {chain.ok && chain.value.enforcementTier === "harness"
            ? t.rich("harness", { b: (chunks) => <b>{chunks}</b> })
            : null}
        </p>
      </div>
    </section>
  );
}

function ReadError({ read }: { read: Exclude<Read<unknown>, { ok: true }> }) {
  const t = useTranslations("onboarding.register.run");
  return (
    <section
      data-testid="first-frame-error"
      className={`${panel} flex flex-col items-center gap-3 px-6 py-7 text-center`}
    >
      <h2 className="text-base font-semibold">{t("error.title")}</h2>
      <ReadFailure read={read} section={t("waiting.title")} />
      <CheckAgain />
    </section>
  );
}

function WaitFooter({ place, agent }: { place: Place; agent: string }) {
  const t = useTranslations("onboarding.register");
  return (
    <div className={footer}>
      <CancelRegistration
        org={place.org}
        ws={place.ws}
        agentId={agent}
        fleet={routes.fleet(place.org, place.ws)}
        testId="register-cancel"
        className={phoneWide}
      />
      <SafeLink
        to={routes.register(place.org, place.ws, "wrap", { agent })}
        className={`${buttonSecondary} ${phoneWide}`}
      >
        {t("back")}
      </SafeLink>
      <span className="text-xs text-muted-foreground md:ml-auto">
        {t("run.caption")}
      </span>
    </div>
  );
}

function ErrorFooter({ place, agent }: { place: Place; agent: string }) {
  const t = useTranslations("onboarding.register");
  return (
    <div className={footer}>
      <CancelRegistration
        org={place.org}
        ws={place.ws}
        agentId={agent}
        fleet={routes.fleet(place.org, place.ws)}
        testId="register-cancel"
        className={phoneWide}
      />
      <SafeLink
        to={routes.register(place.org, place.ws, "wrap", { agent })}
        className={`${buttonSecondary} ${phoneWide}`}
      >
        {t("back")}
      </SafeLink>
    </div>
  );
}

function ReceivedFooter({ place, agent }: { place: Place; agent: string }) {
  const fleet = routes.fleet(place.org, place.ws);
  return (
    <OpenInFleet fleet={fleet}>
      <CancelRegistration
        org={place.org}
        ws={place.ws}
        agentId={agent}
        fleet={fleet}
        testId="register-cancel"
        className={phoneWide}
      />
    </OpenInFleet>
  );
}

function NameLead() {
  const t = useTranslations("onboarding.register.name");
  return <>{t("lead")}</>;
}

/**
 * The name step. It reads the namespaces the key is built from and the main
 * repository; with `?agent=` it reads the identity already reserved and shows
 * its key read-only.
 */
async function nameStep({
  ctx,
  source,
  agent,
  place,
}: {
  ctx: WsCtx;
  source: DataSource;
  agent: string | null;
  place: Place;
}): Promise<ReactNode> {
  const [placeRead, reservedRead] = await Promise.all([
    readRegisterPlace(place.org, place.ws),
    agent === null ? Promise.resolve(null) : source.agents.get(ctx, agent),
  ]);
  if (reservedRead !== null && !reservedRead.ok) {
    if (reservedRead.reason === "error" && reservedRead.status === 404)
      notFound();
    return (
      <>
        <StepHeader step="name" lead={<NameLead />} />
        <StepFailure read={reservedRead} />
      </>
    );
  }
  const reserved: ReservedAgent | null =
    reservedRead === null
      ? null
      : {
          id: reservedRead.value.identity.id,
          slug: reservedRead.value.identity.slug,
          harness: reservedRead.value.identity.harness,
        };
  const body = placeRead.ok ? (
    <NameForm
      ctx={ctx}
      place={place}
      registerPlace={placeRead.value}
      reserved={reserved}
    />
  ) : (
    <PlaceFailure failure={placeRead} />
  );
  return (
    <>
      <StepHeader step="name" lead={<NameLead />} />
      {body}
    </>
  );
}

function NameForm({
  ctx,
  place,
  registerPlace,
  reserved,
}: {
  ctx: WsCtx;
  place: Place;
  registerPlace: RegisterPlace;
  reserved: ReservedAgent | null;
}) {
  return (
    <RegisterAgentForm
      org={place.org}
      ws={place.ws}
      workspace={ctx.wsName}
      place={registerPlace}
      reserved={reserved}
      wrap={
        reserved === null
          ? null
          : routes.register(place.org, place.ws, "wrap", { agent: reserved.id })
      }
      fleet={routes.fleet(place.org, place.ws)}
    />
  );
}

async function wrapStep({
  ctx,
  source,
  agent,
  place,
}: {
  ctx: WsCtx;
  source: DataSource;
  agent: string;
  place: Place;
}): Promise<ReactNode> {
  const [read, gateRead] = await Promise.all([
    source.agents.get(ctx, agent),
    source.onboarding.state(ctx),
  ]);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return <StepFailure read={read} />;
  }
  const gate: OnboardingGate | null = gateRead.ok ? gateRead.value : null;
  const { identity } = read.value;
  return (
    <>
      <StepHeader
        step="wrap"
        lead={
          identity.agentKey === null ? null : (
            <KeyLead step="wrap" agentKey={identity.agentKey} />
          )
        }
      />
      <WrapAgent
        org={place.org}
        ws={place.ws}
        agentId={identity.id}
        harness={identity.harness}
        credentialPrefix={livePrefix(read.value)}
        gated={gate !== null && gate.step !== "unlocked"}
        back={routes.register(place.org, place.ws, "name", {
          agent: identity.id,
        })}
        next={routes.register(place.org, place.ws, "run", {
          agent: identity.id,
        })}
        fleet={routes.fleet(place.org, place.ws)}
      />
    </>
  );
}

async function runStep({
  ctx,
  source,
  agent,
  place,
}: {
  ctx: WsCtx;
  source: DataSource;
  agent: string;
  place: Place;
}): Promise<ReactNode> {
  const [read, detailRead] = await Promise.all([
    source.onboarding.firstFrame(ctx, agent, { waitMs: FIRST_FRAME_WAIT_MS }),
    source.agents.get(ctx, agent),
  ]);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return (
      <>
        <StepHeader step="run" />
        <ReadError read={read} />
        <ErrorFooter place={place} agent={agent} />
      </>
    );
  }
  const frame = read.value;
  const detail = detailRead.ok ? detailRead.value : null;
  const header = (
    <StepHeader
      step="run"
      lead={
        frame.agentKey === null ? null : (
          <KeyLead step="run" agentKey={frame.agentKey} />
        )
      }
    />
  );
  if (frame.firstFrame !== null) {
    const runId = frame.firstFrame.runId;
    const [run, chain] = await Promise.all([
      source.runs.get(ctx, runId, { framesAfter: null }),
      source.runs.chain(ctx, runId),
    ]);
    return (
      <>
        {header}
        <Received
          receivedAt={frame.firstFrame.receivedAt}
          run={run}
          chain={chain}
        />
        <ReceivedFooter place={place} agent={agent} />
      </>
    );
  }
  return (
    <>
      {header}
      <Waiting frame={frame} detail={detail} pollRevision={randomUUID()} />
      <WaitFooter place={place} agent={agent} />
    </>
  );
}

/**
 * One step of the register flow, inside the gate. The step bodies are awaited
 * here rather than rendered as async components, so the whole step resolves
 * before React sees it and a component test renders the finished tree.
 */
export async function RegisterAgent({
  ctx,
  source,
  step,
  agent,
}: {
  ctx: WsCtx;
  source: DataSource;
  step: RegisterStep;
  /** `?agent=`, the identity the name step minted; null on the first step. */
  agent: string | null;
}) {
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug };
  if (!mayRegister(ctx)) {
    const user = await getAuthUser();
    return (
      <Denied ctx={ctx} viewer={user?.name || user?.email || ctx.userId} />
    );
  }
  if (step === "name") return nameStep({ ctx, source, agent, place });
  if (agent === null) {
    return (
      <>
        <StepHeader step={step} />
        <NoAgent place={place} />
      </>
    );
  }
  return step === "wrap"
    ? wrapStep({ ctx, source, agent, place })
    : runStep({ ctx, source, agent, place });
}
