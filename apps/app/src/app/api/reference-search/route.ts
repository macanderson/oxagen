/**
 * POST /api/reference-search
 *
 * Typed reference autocomplete for the chat composer's @-mention picker, and
 * exact-slug resolution for mention-chip hover hydration.
 *
 * Auth: session required → resolve org+workspace → assert workspace member.
 * Delegates to search_references via invoke() (IAM + metering + audit).
 */
import "@oxagen/handlers/register";

import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertWorkspaceMember,
} from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen/kernel";
import { REFERENCE_TYPES } from "@oxagen/oxagen/contracts/reference.search";
import type { ReferenceSearchOutput } from "@oxagen/oxagen/contracts/reference.search";
import { logger } from "@oxagen/handlers/logger";

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  query: z.string().min(0).max(500).default(""),
  types: z
    .array(z.enum(REFERENCE_TYPES))
    .min(1)
    .max(REFERENCE_TYPES.length)
    .optional(),
  slug: z.string().min(1).max(500).optional(),
  limit: z.number().int().min(1).max(25).default(10),
});

export async function POST(request: NextRequest): Promise<Response> {
  let session: Awaited<ReturnType<typeof getSessionOrRedirect>>;
  try {
    session = await getSessionOrRedirect();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      { status: 400 },
    );
  }

  const body = parsed.data;

  let orgId: string;
  let workspaceId: string;
  try {
    const org = await resolveOrg(body.orgSlug);
    const workspace = await resolveWorkspace(org.id, body.workspaceSlug);
    await assertWorkspaceMember(workspace.id, session.user.id);
    orgId = org.id;
    workspaceId = workspace.id;
  } catch {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const result = (await invoke(
      "search_references",
      {
        query: body.query,
        types: body.types,
        slug: body.slug,
        limit: body.limit,
      },
      {
        orgId,
        workspaceId,
        userId: session.user.id,
        apiKeyId: null,
        requestId: crypto.randomUUID(),
        surface: "app",
        messageId: null,
      },
    )) as ReferenceSearchOutput;

    return NextResponse.json(result);
  } catch (err) {
    logger.error(
      { err, orgId, workspaceId, types: body.types, slug: body.slug ?? null },
      "[reference-search] search failed",
    );
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
