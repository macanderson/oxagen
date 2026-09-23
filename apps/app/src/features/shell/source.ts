// The shell renders for the context the organization layout resolved with
// requireViewer: signed in, a member, MFA satisfied, on the canonical slug. The
// person's name and email come from the same request's session; the
// organizations and workspaces the switchers list come from `shell.context`;
// the zone the chrome's dates render in comes from `shell.preferences`.
//
// The approvals drawer is organization-wide (mockup `apdBody()`): the topbar
// button on every page counts every call parked for a person in every
// workspace. `list_approvals` answers one workspace, so the chrome reads each
// workspace the viewer belongs to, a few at a time and at most
// WORKSPACE_BOUND of them, and says so when it stopped short (#3848).
// The reads run when the layout renders: on a full load, and on the refresh
// every governed write ends with. Nothing polls (#3805).
import "server-only";
import { createHash } from "node:crypto";
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import type { MandateRow } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import { getAuthUser } from "@/features/auth";
import { type OrgCtx, requireViewer } from "@/server/viewer";
import { startOfZonedDay } from "@/shared/calendar-day";
import type { ShellData, WorkspaceApprovals } from "./shell-data";

/** The most workspaces whose approvals the chrome reads on one render. */
export const WORKSPACE_BOUND = 12;
/** How many workspaces are read at once, so a large organization does not take the pool. */
const BATCH = 4;

/** The first instant of the viewer's calendar day: "resolved today" counts from here. */
export function startOfViewerDay(now: number, timeZone: string): string {
  // en-CA formats a date as YYYY-MM-DD.
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return (
    startOfZonedDay(day, timeZone) ??
    new Date(now - (now % 86_400_000)).toISOString()
  );
}

/**
 * What the server keeps for the approval cards it renders and the client never
 * receives: the mandates each workspace's parked calls drew on, by public id,
 * so a card draws its mandate bar the way Fleet and Run draw it.
 */
export type ShellCardInputs = {
  mandates: ReadonlyMap<string, ReadonlyMap<string, MandateRow>>;
};

async function workspaceApprovals(
  ctx: OrgCtx,
  source: DataSource,
  place: { slug: string; name: string },
  since: string,
): Promise<{
  approvals: WorkspaceApprovals;
  mandates: ReadonlyMap<string, MandateRow>;
}> {
  // Each workspace is its own tenant scope, resolved the way its pages are, so
  // a membership removed since the list was read is a refusal, not a leak.
  const wsCtx = await requireViewer(ctx.orgSlug, place.slug);
  const [pending, resolved] = await Promise.all([
    source.approvals.pending(wsCtx, { runId: null }),
    source.approvals.resolvedSince(wsCtx, { since }),
  ]);
  // The ledger is read only where a parked call names a mandate, the same
  // rule the Fleet page follows.
  const mandates = new Map<string, MandateRow>();
  if (pending.ok && pending.value.items.some((i) => i.mandateId !== null)) {
    const read = await source.mandates.list(wsCtx, { agentId: null });
    if (read.ok)
      for (const mandate of read.value.mandates)
        mandates.set(mandate.id, mandate);
  }
  return {
    approvals: { slug: place.slug, name: place.name, pending, resolved },
    mandates,
  };
}

export async function shellSource(
  ctx: OrgCtx,
  source: DataSource,
): Promise<{ data: ShellData; cards: ShellCardInputs }> {
  const [user, context, preferences] = await Promise.all([
    getAuthUser(),
    source.shell.context(ctx),
    source.shell.preferences(ctx),
  ]);
  // requireViewer admitted this request, so its memoized session is present;
  // a missing one is a programming error, never a signed-out render.
  if (user === null) throw new Error("shell_without_session");
  // A clock is not worth an empty shell: a refused or failed preference
  // read falls back to the default zone, and the read's own refusal is
  // already reported by the kernel seam.
  const timeZone = preferences.ok
    ? preferences.value.timeZone
    : DEFAULT_TIME_ZONE;
  const readAt = Date.now();
  const since = startOfViewerDay(readAt, timeZone);
  const places = context.ok ? context.value.workspaces : [];
  const read = places.slice(0, WORKSPACE_BOUND);
  const workspaces: WorkspaceApprovals[] = [];
  const mandates = new Map<string, ReadonlyMap<string, MandateRow>>();
  for (let i = 0; i < read.length; i += BATCH) {
    const batch = await Promise.all(
      read
        .slice(i, i + BATCH)
        .map((place) => workspaceApprovals(ctx, source, place, since)),
    );
    for (const one of batch) {
      workspaces.push(one.approvals);
      mandates.set(one.approvals.slug, one.mandates);
    }
  }
  // The bell on an organization page reads the feed in the workspace the
  // sidebar points at: the organization's rows and that workspace's.
  const first = read[0];
  const feed =
    first === undefined
      ? null
      : await source.shell.notifications(
          await requireViewer(ctx.orgSlug, first.slug),
        );
  const data: ShellData = {
    org: {
      key: createHash("sha256").update(`account:${ctx.orgId}`).digest("hex"),
      slug: ctx.orgSlug,
      name: ctx.orgName,
    },
    viewer: {
      name: user.name || null,
      email: user.email,
      avatarUrl: user.avatarUrl,
      id: user.id,
      orgRole: ctx.orgRole,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      timeZone,
    },
    context,
    approvals: {
      workspaces,
      truncated: places.length > read.length,
      readAt,
    },
    feed,
  };
  return { data, cards: { mandates } };
}
