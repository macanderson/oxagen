/**
 * POST /api/command-menu/search
 *
 * Entity search for the Command Menu's Search section (spec §10).
 * Invoked when the user's input matches an entity-prefix pattern.
 *
 * Auth: session required → resolve org+workspace → assert workspace member.
 * Delegates to command.menu.search via invoke() (IAM + metering + audit).
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
import { SEARCHABLE_KINDS } from "@oxagen/oxagen/contracts/command.menu.search";
import type { CommandMenuSearchOutput } from "@oxagen/oxagen/contracts/command.menu.search";
import { logger } from "@oxagen/handlers/logger";

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  kind: z.enum(SEARCHABLE_KINDS).optional(),
  query: z.string().min(0).max(500).default(""),
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
      "search_command_menu",
      {
        kind: body.kind,
        query: body.query,
        orgSlug: body.orgSlug,
        workspaceSlug: body.workspaceSlug,
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
    )) as CommandMenuSearchOutput;

    return NextResponse.json(result);
  } catch (err) {
    logger.error(
      { err, orgId, workspaceId, kind: body.kind, query: body.query },
      "[command-menu/search] search failed",
    );
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
