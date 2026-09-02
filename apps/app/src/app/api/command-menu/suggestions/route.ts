/**
 * POST /api/command-menu/suggestions
 *
 * LLM-powered "Suggested for this page" endpoint for the Command Menu (spec §7).
 *
 * Auth: session required → resolve org+workspace → assert workspace member.
 * Delegates to command.menu.suggest via invoke() (IAM + metering + audit).
 *
 * Server-side caching: uses unstable_cache keyed on a hash of the
 * SuggestionContext (excluding session fields), TTL 1 hour — so suggestions for
 * the same page entity are shared across users (spec §7 server cache layer).
 *
 * Cache Components note: this deliberately stays on unstable_cache rather than
 * `"use cache"`. The directive keys on ALL arguments and closed-over values,
 * and this cache must EXCLUDE the session-specific fields (userId, requestId)
 * from its key so entries are shared org-wide — with `"use cache"` the
 * per-request requestId would make every key unique and the cache would never
 * hit. unstable_cache's explicit key-parts express that exclusion; it remains
 * a supported caching layer alongside Cache Components.
 */
import "@oxagen/handlers/register";

import { type NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { z } from "zod";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertWorkspaceMember,
} from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen/kernel";
import type {
  CommandMenuSuggestInput,
  CommandMenuSuggestOutput,
} from "@oxagen/oxagen/contracts/command.menu.suggest";
import { logger } from "@oxagen/handlers/logger";

// ── Body schema ───────────────────────────────────────────────────────────────

const entityRefSchema = z.object({
  kind: z.string(),
  id: z.string(),
  label: z.string().optional(),
});

const BodySchema = z.object({
  orgSlug: z.string().min(1),
  workspaceSlug: z.string().min(1),
  // SuggestionContext fields
  route: z.string().max(2000),
  routeParams: z.record(z.string()).default({}),
  queryParams: z.record(z.string()).default({}),
  pageEntity: z
    .object({
      kind: z.string(),
      id: z.string(),
      publicId: z.string().optional(),
      label: z.string().optional(),
      summary: z.string().max(500).optional(),
    })
    .optional(),
  recentEntities: z.array(entityRefSchema).max(5).default([]),
  capabilities: z.array(z.string()).max(200).default([]),
  locale: z.string().max(20).default("en"),
});

// ── Cache key hash ────────────────────────────────────────────────────────────

/**
 * Derive a stable cache key from the SuggestionContext minus session-specific
 * fields. Shared across users looking at the same entity.
 *
 * Uses the Web Crypto digest (SHA-256) which is available in the Next.js
 * edge/node runtimes without importing Node's `crypto` module.
 */
async function hashContext(ctx: CommandMenuSuggestInput): Promise<string> {
  // Only hash fields that describe the page context, not user-specific state.
  const keyObj = {
    route: ctx.route,
    routeParams: ctx.routeParams,
    queryParams: ctx.queryParams,
    pageEntity: ctx.pageEntity
      ? {
          kind: ctx.pageEntity.kind,
          id: ctx.pageEntity.id,
          summary: ctx.pageEntity.summary ?? null,
        }
      : null,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(keyObj));
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Cached invoke wrapper ─────────────────────────────────────────────────────

/**
 * Call command.menu.suggest through a 1-hour server cache.
 * The cache key includes the context hash + orgId (so different orgs never
 * share suggestion results even if they hit the same route/entity).
 */
function cachedSuggest(
  input: CommandMenuSuggestInput,
  capCtx: {
    orgId: string;
    workspaceId: string;
    userId: string;
    requestId: string;
  },
  cacheKey: string,
): Promise<CommandMenuSuggestOutput> {
  return unstable_cache(
    async () => {
      return (await invoke("suggest_commands", input, {
        orgId: capCtx.orgId,
        workspaceId: capCtx.workspaceId,
        userId: capCtx.userId,
        apiKeyId: null,
        requestId: capCtx.requestId,
        surface: "app",
        messageId: null,
      })) as CommandMenuSuggestOutput;
    },
    // Cache tags: [orgId, context hash]
    [`cmd-suggest-${capCtx.orgId}-${cacheKey}`],
    { revalidate: 3600 }, // 1 hour TTL per spec §7
  )();
}

// ── Route handler ─────────────────────────────────────────────────────────────

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

  const suggestInput: CommandMenuSuggestInput = {
    route: body.route,
    routeParams: body.routeParams,
    queryParams: body.queryParams,
    pageEntity: body.pageEntity,
    recentEntities: body.recentEntities,
    capabilities: body.capabilities,
    locale: body.locale,
  };

  const cacheKey = await hashContext(suggestInput);

  try {
    const result = await cachedSuggest(
      suggestInput,
      {
        orgId,
        workspaceId,
        userId: session.user.id,
        requestId: crypto.randomUUID(),
      },
      cacheKey,
    );
    return NextResponse.json(result);
  } catch (err) {
    logger.error(
      { err, orgId, workspaceId, route: body.route },
      "[command-menu/suggestions] suggest failed",
    );
    // Return empty suggestions rather than a 500 — the client hides the section
    // on any non-OK response, so this is a graceful path.
    return NextResponse.json({ suggestions: [] });
  }
}
