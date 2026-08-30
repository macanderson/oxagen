"use server";

// ── Server action: video.generate ─────────────────────────────────────────────
//
// Routes video generation requests through the single invoke() chokepoint so
// IAM, billing, and audit run on every call. The capability is scoped: true,
// so real org + workspace context is required — no stub placeholders.

import { invoke } from "@oxagen/oxagen";
// Side-effect import: bind every foundation handler into the shared kernel so
// invoke("generate_video", …) can resolve its handler at runtime.
import "@oxagen/handlers/register";
import { videoGenerate } from "@oxagen/oxagen/contracts/video.generate";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";

export interface VideoGenerateFormData {
  prompt: string;
  durationSeconds?: number;
  aspectRatio?: "16:9" | "9:16" | "1:1";
  style?: string;
  /** Org slug from the current URL route segment — required for real IAM context. */
  orgSlug: string;
  /** Workspace slug from the current URL route segment — required for real IAM context. */
  workspaceSlug: string;
}

export type VideoGenerateActionResult =
  | { ok: true; queued: true; jobId: string }
  | { ok: false; error: string };

export async function videoGenerateAction(
  data: VideoGenerateFormData,
): Promise<VideoGenerateActionResult> {
  // Validate the capability input fields (excludes slug params).
  const parsed = videoGenerate.input.safeParse({
    prompt: data.prompt,
    durationSeconds: data.durationSeconds,
    aspectRatio: data.aspectRatio,
    style: data.style,
  });
  if (!parsed.success) {
    return {
      ok: false,
      error:
        parsed.error.issues[0]?.message ?? "Invalid video generation request",
    };
  }

  // Resolve real org + workspace from slugs and assert membership (IDOR guard).
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return { ok: false, error: "Not authenticated." };
  }

  let orgId: string;
  let workspaceId: string;
  try {
    const org = await resolveOrg(data.orgSlug);
    const ws = await resolveWorkspace(org.id, data.workspaceSlug);
    await assertOrgMember(org.id, session.user.id);
    orgId = org.id;
    workspaceId = ws.id;
  } catch {
    return { ok: false, error: "Org or workspace not found." };
  }

  const ctx = {
    orgId,
    workspaceId,
    userId: session.user.id,
    apiKeyId: null as string | null,
    requestId: crypto.randomUUID(),
    surface: "app" as const,
    messageId: null as string | null,
  };

  try {
    const result = (await invoke("generate_video", parsed.data, ctx, {
      surface: "agent",
    })) as {
      jobId: string;
    };
    return { ok: true, queued: true, jobId: result.jobId };
  } catch (err) {
    const message =
      err instanceof Error
        ? err.message
        : "Video generation could not be queued.";
    return { ok: false, error: message };
  }
}
