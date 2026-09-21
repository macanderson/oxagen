// Register an agent (#2967, ADR-065 decision 1): name the agent, wrap it, and
// wait for the first frame, one step per `[step]` segment over `register_agent`,
// `create_enrollment_token` and `get_first_frame`.
//
// The identity the name step mints is carried forward as `?agent=`, so a
// reload lands back on the same registration. The run step's wait is the
// contract's own long poll (§3.5): the handler waits inside one invoke, and
// the page re-reads only while a host is enrolled, so an open page costs one
// call per wait rather than one per tick.
import "server-only";
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { AgentDetail } from "@/data/contracts/agents";
import type {
  FirstFrame as Frame,
  OnboardingGate as Gate,
} from "@/data/contracts/onboarding";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Rail, type RailStep } from "./rail";
import { type RegisterStep, registerRail, stepNumber } from "./steps";
import { FirstFrameStep } from "./ui/first-frame";
import { RegisterAgentForm } from "./ui/register-form";
import { WrapAgent } from "./ui/wrap-agent";
import { useFormatter } from "@/ui/formatter";

/**
 * The server-side wait for one read of `get_first_frame`, inside the budget the
 * contract allows (`WAIT_MS_MAX`, packages/oxagen/src/contracts/run.get.ts).
 * The handler returns as soon as a frame lands, so this is the longest a page
 * render blocks and the shortest interval between two invokes while it waits.
 */
const FIRST_FRAME_WAIT_MS = 20_000;

type Place = { org: string; ws: string };

function Stepper({
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
  return <Rail label={t("railLabel")} steps={steps} />;
}

function StepHeading({ step }: { step: RegisterStep }) {
  const t = useTranslations("onboarding.register");
  const key = step === "name" ? "name" : step === "wrap" ? "wrap" : "run";
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {t("eyebrow", { n: stepNumber(step) })}
      </p>
      <h2 className="text-lg font-semibold text-foreground">
        {t(`${key}.title`)}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t(`${key}.lead`)}
      </p>
    </div>
  );
}

function Caption() {
  const t = useTranslations("onboarding.register");
  return (
    <p className="max-w-prose text-xs text-muted-foreground">{t("caption")}</p>
  );
}

function NoAgent({ place }: { place: Place }) {
  const t = useTranslations("onboarding.register.noAgent");
  return (
    <section data-testid="register-no-agent" className={`${panel} p-4`}>
      <h3 className="text-sm font-semibold">{t("title")}</h3>
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

function Identity({ identity }: { identity: AgentDetail["identity"] }) {
  const t = useTranslations("onboarding.register.wrap");
  const harness = useTranslations("agents.harness");
  return (
    <dl
      data-testid="register-identity"
      className="flex flex-wrap gap-x-6 gap-y-1 text-sm"
    >
      <div className="flex min-w-0 gap-2">
        <dt className="text-muted-foreground">{t("agentKey")}</dt>
        <dd className={`${mono} break-all`}>
          {identity.agentKey ?? t("notRecorded")}
        </dd>
      </div>
      <div className="flex gap-2">
        <dt className="text-muted-foreground">{t("harness")}</dt>
        <dd>{harness(identity.harness)}</dd>
      </div>
    </dl>
  );
}

function Received({
  frame,
  place,
}: {
  frame: NonNullable<Frame["firstFrame"]>;
  place: Place;
}) {
  const t = useTranslations("onboarding.register.run.received");
  const format = useFormatter();
  return (
    <section
      data-testid="first-frame-received"
      className={`${panel} flex flex-col gap-2 p-4`}
    >
      <h3 className="text-sm font-semibold">{t("title")}</h3>
      <p className="max-w-prose text-sm text-muted-foreground">
        {t.rich("body", {
          run: () => <span className={mono}>{frame.runId}</span>,
        })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("at", {
          at: format.dateTime(new Date(frame.receivedAt), {
            dateStyle: "medium",
            timeStyle: "short",
          }),
        })}
      </p>
      <p>
        <SafeLink
          to={routes.run(place.org, place.ws, frame.runId)}
          className={linkText}
        >
          {t("open")}
        </SafeLink>
      </p>
    </section>
  );
}

/** The provisional window while it is open, which is what the bind offer needs. */
function openWindow(gate: Gate | null): Gate["provisional"] {
  if (gate === null || gate.provisional === null) return null;
  return gate.provisional.mainRepoBoundAt === null ? gate.provisional : null;
}

/**
 * The step bodies are awaited by the caller rather than rendered as async
 * components, so the whole step resolves before React sees it and a component
 * test renders the finished tree.
 */
async function wrapStep({
  ctx,
  source,
  agent,
  place,
  gated,
}: {
  ctx: WsCtx;
  source: DataSource;
  agent: string;
  place: Place;
  gated: boolean;
}): Promise<ReactNode> {
  const read = await source.agents.get(ctx, agent);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return <StepFailure read={read} />;
  }
  const { identity } = read.value;
  return (
    <>
      <Identity identity={identity} />
      <WrapAgent
        org={place.org}
        ws={place.ws}
        agentId={identity.id}
        harness={identity.harness}
        gated={gated}
        back={routes.register(place.org, place.ws, "name")}
        next={routes.register(place.org, place.ws, "run", {
          agent: identity.id,
        })}
      />
    </>
  );
}

async function runStep({
  ctx,
  source,
  agent,
  place,
  gate,
}: {
  ctx: WsCtx;
  source: DataSource;
  agent: string;
  place: Place;
  gate: Gate | null;
}): Promise<ReactNode> {
  const read = await source.onboarding.firstFrame(ctx, agent, {
    waitMs: FIRST_FRAME_WAIT_MS,
  });
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return <StepFailure read={read} />;
  }
  const frame = read.value;
  if (frame.firstFrame !== null)
    return <Received frame={frame.firstFrame} place={place} />;
  const provisional = openWindow(gate);
  return (
    <FirstFrameStep
      org={place.org}
      ws={place.ws}
      workspace={ctx.wsName}
      agentKey={frame.agentKey}
      host={frame.host}
      here={routes.register(place.org, place.ws, "run", { agent })}
      repository={provisional === null ? null : provisional.detectedRepository}
      provisionalUntil={provisional === null ? null : provisional.until}
    />
  );
}

function Layout({
  step,
  place,
  agent,
  children,
}: {
  step: RegisterStep;
  place: Place;
  agent: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Stepper step={step} place={place} agent={agent} />
      <section className="flex flex-col gap-4">
        <StepHeading step={step} />
        {children}
      </section>
      <Caption />
    </div>
  );
}

/**
 * One step of the register flow. The page's one h1 is the route's title, so
 * each step names itself in an h2 under the stepper (ARCHITECTURE.md §1.2).
 * The gate's row decides whether a step transition is the gate's to make and
 * whether the workspace is still provisional; the name step needs neither, so
 * it reads nothing.
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
  if (step === "name") {
    return (
      <Layout step={step} place={place} agent={agent}>
        <RegisterAgentForm org={place.org} ws={place.ws} />
      </Layout>
    );
  }
  if (agent === null) {
    return (
      <Layout step={step} place={place} agent={agent}>
        <NoAgent place={place} />
      </Layout>
    );
  }
  const gateRead = await source.onboarding.state(ctx);
  const gate = gateRead.ok ? gateRead.value : null;
  const body =
    step === "wrap"
      ? await wrapStep({
          ctx,
          source,
          agent,
          place,
          gated: gate !== null && gate.step !== "unlocked",
        })
      : await runStep({ ctx, source, agent, place, gate });
  return (
    <Layout step={step} place={place} agent={agent}>
      {body}
    </Layout>
  );
}
