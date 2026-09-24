// The onboarding gate's later steps and the installer's screens (#2967, the
// rev1 design's `pWelcome`): Wrap an agent and Start a run in the gate shell,
// and the signed package's own screens in the auth shell. Each is an async
// Server Component the route renders under its own Suspense boundary, so the
// loading state keeps the shell and the rail.
//
// **Which agent.** An enrollment token is minted for a registered agent, and
// the gate records no first agent of its own. The steps carry the identity as
// `?agent=`; without one they take the workspace's first agent a host can
// wrap (Claude Code, Codex, Cursor or Stella). A workspace with none shows the no-agent
// panel, which names the gap rather than inventing a key.
//
// **Who may.** Every write on these steps — `create_enrollment_token`,
// `advance_onboarding`, `bind_main_repository` — admits an org Owner or Admin
// in its handler (INV-29). The page checks the same role before it reads, so a
// member without it sees the gate's denied state instead of controls that
// would all be refused.
import "server-only";
import { notFound } from "next/navigation";
import type { AgentDetail } from "@/data/contracts/agents";
import type { OnboardingGate } from "@/data/contracts/onboarding";
import type { DataSource } from "@/data/ports";
import { getAuthUser } from "@/server/session";
import type { WsCtx } from "@/server/viewer";
import type { ReactNode } from "react";
import { routes, type SafePath } from "@/shared/safe-path";
import { AuthShell } from "@/ui/auth-shell";
import { GateShell, type GateStepId } from "./ui/gate-shell";
import { GateDenied, GateSkeleton } from "./ui/gate-states";
import { InstallerScreens } from "./ui/installer";
import { type ReceivedFrame, RunStep } from "./ui/run-step";
import { type WrapAgentFacts, WrapStep } from "./ui/wrap-step";

/**
 * The server-side wait for one read of `get_first_frame`, inside the budget the
 * contract allows. The handler answers at once until a host enrolls, and as
 * soon as a frame lands after that.
 */
const FIRST_FRAME_WAIT_MS = 20_000;

/**
 * How long an enrolled host may stay silent before the run step says its
 * collector cannot reach Oxagen. The collector heartbeats well inside this.
 */
const SILENT_HOST_SECONDS = 90;

/** The harnesses a host installer wraps; the others enrol through the SDK. */
const HOST_HARNESSES = new Set(["claude-code", "codex", "cursor", "stella"]);

const ONBOARDING_ROLES = new Set(["owner", "admin"]);

type Step = Exclude<GateStepId, "organization">;

function place(ctx: WsCtx) {
  return { org: ctx.orgSlug, ws: ctx.wsSlug };
}

function signedIn(ctx: WsCtx, name: string | null, email: string | null) {
  return `${name || email || "—"} · workspace.${ctx.wsRole} · ${ctx.wsSlug}`;
}

/** The done steps' targets: the organization form, and Wrap for the same agent. */
function backLinks(
  ctx: WsCtx,
  agent: string | null,
): Partial<Record<GateStepId, SafePath>> {
  const { org, ws } = place(ctx);
  return {
    organization: routes.newOrganization(),
    wrap: routes.welcome(
      org,
      ws,
      "wrap",
      agent === null ? undefined : { agent },
    ),
  };
}

/** The permission each step's write needs, as the design's Permissions name it. */
function permissionFor(step: Step, ctx: WsCtx): string {
  return step === "wrap"
    ? `enrollment.create on ${ctx.wsSlug}`
    : `repo.bind on ${ctx.wsSlug}`;
}

/** The loading state: the shell and the rail stay, the card is the skeleton. */
export function WelcomeLoading({ step }: { step: Step }) {
  return (
    <GateShell step={step} email={null} cancel={routes.root()} pending>
      <GateSkeleton />
    </GateShell>
  );
}

/** The agent the steps enrol: `?agent=`, or the workspace's first a host can wrap. */
async function resolveAgent(
  ctx: WsCtx,
  source: DataSource,
  agent: string | null,
): Promise<AgentDetail | null> {
  let id = agent;
  if (id === null) {
    const page = await source.agents.list(ctx, { cursor: null });
    if (!page.ok) return null;
    id =
      page.value.agents.find((row) => HOST_HARNESSES.has(row.harness))?.id ??
      null;
  }
  if (id === null) return null;
  const read = await source.agents.get(ctx, id);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return null;
  }
  return read.value;
}

function facts(detail: AgentDetail): WrapAgentFacts {
  const live = detail.credentials.find((c) => c.revokedAt === null);
  return {
    id: detail.identity.id,
    key: detail.identity.agentKey,
    harness: detail.identity.harness,
    credentialPrefix: live?.prefix ?? null,
  };
}

async function frame(
  ctx: WsCtx,
  source: DataSource,
  runId: string,
): Promise<Omit<ReceivedFrame, "receivedAt">> {
  const [run, chain] = await Promise.all([
    source.runs.get(ctx, runId, { framesAfter: null }),
    source.runs.chain(ctx, runId),
  ]);
  const intact = chain.ok
    ? chain.value.gaps.missingFrameCount === 0 &&
      chain.value.gaps.missingSequences.length === 0 &&
      !chain.value.gaps.recorded.includes("chain_break")
    : null;
  return {
    runId,
    frames: run.ok
      ? run.value.frames.frames.slice(0, 2).map((f) => ({
          seq: f.seq,
          at: f.observedAt,
          type: f.type,
          summary: f.summary,
        }))
      : null,
    tier: run.ok ? run.value.run.enforcementTier : null,
    replayGrade: run.ok ? run.value.run.replayGrade : null,
    chainIntact: intact,
  };
}

export async function WelcomeWrap({
  ctx,
  source,
  agent,
}: {
  ctx: WsCtx;
  source: DataSource;
  agent: string | null;
}) {
  const { org, ws } = place(ctx);
  const user = await getAuthUser();
  const email = user?.email ?? null;
  const shell = (body: ReactNode) => (
    <GateShell
      step="wrap"
      email={email}
      cancel={routes.fleet(org, ws)}
      back={backLinks(ctx, agent)}
    >
      {body}
    </GateShell>
  );
  if (!ONBOARDING_ROLES.has(ctx.orgRole))
    return shell(
      <GateDenied
        org={ctx.orgName}
        permission={permissionFor("wrap", ctx)}
        signedIn={signedIn(ctx, user?.name ?? null, email)}
        back={routes.fleet(org, ws)}
      />,
    );
  const [detail, gate] = await Promise.all([
    resolveAgent(ctx, source, agent),
    source.onboarding.state(ctx),
  ]);
  const wrapped = detail === null ? null : facts(detail);
  return shell(
    <WrapStep
      org={org}
      ws={ws}
      agent={wrapped}
      gated={gate.ok && gate.value.step !== "unlocked"}
      back={routes.newOrganization()}
      cancel={routes.fleet(org, ws)}
      register={routes.register(org, ws, "name")}
      next={routes.welcome(
        org,
        ws,
        "run",
        wrapped === null ? undefined : { agent: wrapped.id },
      )}
    />,
  );
}

const DAY_MS = 86_400_000;

/** The provisional window and the repository the enrolling host reported. */
function repositoryOf(gate: OnboardingGate | null, now: number) {
  const provisional = gate?.provisional ?? null;
  if (provisional === null) return null;
  return {
    detected: provisional.detectedRepository,
    until: provisional.until,
    daysLeft: Math.max(
      0,
      Math.ceil((Date.parse(provisional.until) - now) / DAY_MS),
    ),
    boundAt: provisional.mainRepoBoundAt,
  };
}

export async function WelcomeRun({
  ctx,
  source,
  agent,
  now,
  pollRevision,
}: {
  ctx: WsCtx;
  source: DataSource;
  agent: string | null;
  /** The render's instant, passed in so the silent-host test is a pure comparison. */
  now: number;
  /** A new opaque value after every completed server read. */
  pollRevision: string;
}) {
  const { org, ws } = place(ctx);
  const user = await getAuthUser();
  const email = user?.email ?? null;
  const shell = (body: ReactNode) => (
    <GateShell
      step="run"
      email={email}
      cancel={routes.fleet(org, ws)}
      back={backLinks(ctx, agent)}
    >
      {body}
    </GateShell>
  );
  if (!ONBOARDING_ROLES.has(ctx.orgRole))
    return shell(
      <GateDenied
        org={ctx.orgName}
        permission={permissionFor("run", ctx)}
        signedIn={signedIn(ctx, user?.name ?? null, email)}
        back={routes.fleet(org, ws)}
      />,
    );
  const [detail, gateRead] = await Promise.all([
    resolveAgent(ctx, source, agent),
    source.onboarding.state(ctx),
  ]);
  const gate = gateRead.ok ? gateRead.value : null;
  const wrapped = detail === null ? null : facts(detail);
  const common = {
    org,
    ws,
    workspace: ctx.wsSlug,
    fleet: routes.fleet(org, ws),
    back: routes.welcome(
      org,
      ws,
      "wrap",
      wrapped === null ? undefined : { agent: wrapped.id },
    ),
    installer: routes.welcome(
      org,
      ws,
      "installer",
      wrapped === null ? undefined : { agent: wrapped.id },
    ),
    register: routes.register(org, ws, "name"),
    repository: repositoryOf(gate, now),
    pollRevision,
  };
  if (wrapped === null)
    return shell(
      <RunStep
        {...common}
        agent={null}
        host={null}
        received={null}
        silentFor={null}
      />,
    );
  const read = await source.onboarding.firstFrame(ctx, wrapped.id, {
    waitMs: FIRST_FRAME_WAIT_MS,
  });
  const first = read.ok ? read.value : null;
  const host = first?.host ?? null;
  const received =
    first?.firstFrame == null
      ? null
      : {
          ...(await frame(ctx, source, first.firstFrame.runId)),
          receivedAt: first.firstFrame.receivedAt,
        };
  // A host that enrolled and has since said nothing: the collector's requests
  // are not reaching Oxagen, which is the step's error state.
  const lastHeard =
    host === null ? null : Date.parse(host.lastHeartbeatAt ?? host.enrolledAt);
  const silent =
    received === null && lastHeard !== null
      ? Math.floor((now - lastHeard) / 1000)
      : null;
  return shell(
    <RunStep
      {...common}
      agent={wrapped}
      host={host}
      received={received}
      silentFor={
        silent !== null && silent >= SILENT_HOST_SECONDS ? silent : null
      }
    />,
  );
}

/** The installer's own screens, in the auth shell: no rail, no app shell. */
export async function WelcomeInstaller({
  ctx,
  source,
  agent,
}: {
  ctx: WsCtx;
  source: DataSource;
  agent: string | null;
}) {
  const { org, ws } = place(ctx);
  const [detail, gateRead] = await Promise.all([
    resolveAgent(ctx, source, agent),
    source.onboarding.state(ctx),
  ]);
  const gate = gateRead.ok ? gateRead.value : null;
  const connected =
    gate?.firstFrameAt != null && gate.firstRunId !== null
      ? { at: gate.firstFrameAt, runId: gate.firstRunId }
      : null;
  const agentId = detail?.identity.id;
  return (
    <AuthShell>
      <InstallerScreens
        org={ctx.orgName}
        workspace={ctx.wsName}
        agentKey={detail?.identity.agentKey ?? null}
        connected={connected}
        rejected={null}
        wrap={routes.welcome(
          org,
          ws,
          "wrap",
          agentId === undefined ? undefined : { agent: agentId },
        )}
        run={routes.welcome(
          org,
          ws,
          "run",
          agentId === undefined ? undefined : { agent: agentId },
        )}
      />
    </AuthShell>
  );
}
