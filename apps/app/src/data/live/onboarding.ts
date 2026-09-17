// The onboarding port on the kernel (ARCHITECTURE.md §3.3, #2967): where the
// organization stands in the gate (get_onboarding_state) and the wait for one
// registered agent's first frame (get_first_frame). Both are noBillingGate
// reads, each mapped into its view model.
//
// `get_onboarding_state` is `scoped: false` and answers from the organization
// the context carries, so an OrgCtx reaches it. `get_first_frame` carries the
// handler-side long poll `get_run` takes (§3.5): the wait happens inside one
// invoke, so a page waiting for the first frame costs one kernel call per
// `waitMs` rather than one per tick.
import "server-only";
import { onboardingFirstFrameGet } from "@oxagen/oxagen/contracts/onboarding.first_frame.get";
import { onboardingStateGet } from "@oxagen/oxagen/contracts/onboarding.state.get";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import { FirstFrame, OnboardingGate } from "@/data/contracts/onboarding";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toFirstFrame, toOnboardingGate } from "./mappers/onboarding";

/** The mapped value parsed at the boundary; a record the view refuses is `record_unmappable`, reported once. */
function view<S extends z.ZodType>(
  orgId: string,
  schema: S,
  mapped: z.input<S>,
  read: string,
): Read<z.output<S>> {
  const parsed = schema.safeParse(mapped);
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId,
    context: `${read} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

export const onboarding: DataSource["onboarding"] = {
  async state(ctx) {
    const read = await kernelRead(ctx, {
      contract: onboardingStateGet,
      input: {},
      page: "onboarding",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      OnboardingGate,
      toOnboardingGate(read.value),
      "onboarding.state",
    );
  },

  async firstFrame(ctx, agent, q) {
    const read = await kernelRead(ctx, {
      contract: onboardingFirstFrameGet,
      input: { agentId: agent, waitMs: q.waitMs },
      page: "onboarding",
    });
    if (!read.ok) return read;
    return view(
      ctx.orgId,
      FirstFrame,
      toFirstFrame(read.value),
      "onboarding.firstFrame",
    );
  },
};
