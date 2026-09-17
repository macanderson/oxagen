// onboarding.state.get.ts — `get_onboarding_state` (#2967).
//
// Unscoped: with no organization on the context the caller is at
// `organization` (name one), and nothing is read. With one, the gate row and
// its workspace are read through withSystemDb keyed on `ctx.orgId`, which the
// surface's own membership gate set (the API's org middleware, the app's
// viewer): the read cannot rely on an ambient tenant scope because the API's
// org-only router carries no workspace id and the kernel enters no scope
// without one. An organization that predates the gate has no row (the
// migration wrote none): it reads as `unlocked` with no first frame and no
// provisional window, since it was never provisional.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  type DetectedRepository,
  detectedRepositorySchema,
  onboardingStateGet,
  type OnboardingStateGetOutput,
} from "@oxagen/oxagen/contracts/onboarding.state.get";
import { schema, withSystemDb } from "@oxagen/database";
import { eq } from "drizzle-orm";

const NO_ORG: OnboardingStateGetOutput = {
  step: "organization",
  workspace: null,
  firstFrameAt: null,
  firstRunId: null,
  provisional: null,
};

/** The stored jsonb, or null when it is absent or not the shape enroll_host writes. */
function detectedRepositoryOf(value: unknown): DetectedRepository | null {
  const parsed = detectedRepositorySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const onboardingStateGetHandler: CapabilityHandler<
  typeof onboardingStateGet
> = async (_input, ctx) => {
  if (!ctx.orgId) return NO_ORG;
  const orgId = ctx.orgId;

  // tenancy: system bypass via withSystemDb (unscoped read of the caller's own
  // organization; ctx.orgId was set by the surface's membership gate and the
  // org-only API router enters no tenant scope) (see docs/specs/tenancy-rls/spec.md)
  const row = await withSystemDb(async (tx) => {
    const [state] = await tx
      .select({
        step: schema.onboardingState.step,
        workspaceId: schema.onboardingState.workspaceId,
        firstFrameAt: schema.onboardingState.firstFrameAt,
        firstRunId: schema.onboardingState.firstRunId,
        provisionalUntil: schema.onboardingState.provisionalUntil,
        mainRepoBoundAt: schema.onboardingState.mainRepoBoundAt,
        detectedRepository: schema.onboardingState.detectedRepository,
        workspacePublicId: schema.workspaces.publicId,
        workspaceSlug: schema.workspaces.slug,
      })
      .from(schema.onboardingState)
      .leftJoin(
        schema.workspaces,
        eq(schema.workspaces.id, schema.onboardingState.workspaceId),
      )
      .where(eq(schema.onboardingState.orgId, orgId))
      .limit(1);
    return state ?? null;
  });

  if (!row) {
    return { ...NO_ORG, step: "unlocked" };
  }
  const step =
    row.step === "wrap" || row.step === "run" ? row.step : "unlocked";
  return {
    step,
    workspace:
      row.workspacePublicId !== null && row.workspaceSlug !== null
        ? { id: row.workspacePublicId, slug: row.workspaceSlug }
        : null,
    firstFrameAt: row.firstFrameAt?.toISOString() ?? null,
    firstRunId: row.firstRunId,
    provisional: {
      until: row.provisionalUntil.toISOString(),
      mainRepoBoundAt: row.mainRepoBoundAt?.toISOString() ?? null,
      detectedRepository: detectedRepositoryOf(row.detectedRepository),
    },
  };
};
