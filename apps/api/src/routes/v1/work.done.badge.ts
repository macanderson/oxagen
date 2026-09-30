// GET /v1/work/done/badge/<token>.svg draws a work item's done-record verdict
// for a README (agent-work-spec.html, Done record).
//
// No session: GitHub's image proxy fetches a README image and sends no
// credential. The signed token is the boundary. It names the organization, the
// workspace, and the work item, and the route reads the verdict inside that
// tenant scope, so a guessed work item id shows nothing. Every refusal is one
// 404, so a probe learns nothing about which part failed.
import { and, desc, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import {
  DONE_VERDICTS,
  readDoneBadgeToken,
  renderDoneBadge,
  type DoneAttestationKey,
  type DoneBadgeClaims,
  type DoneBadgeState,
  type DoneVerdict,
} from "@oxagen/done-record/attestation";
import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import type { AppEnv } from "../../app";
import { doneAttestationKeyFromEnv } from "./work.done.key";

const SVG = ".svg";

function isVerdict(value: string): value is DoneVerdict {
  return (DONE_VERDICTS as readonly string[]).includes(value);
}

/**
 * The badge state for a work item, or null when the workspace holds no such
 * work item. An item with no done record, or with no verdict on its current
 * record, shows `none`.
 */
export async function readDoneBadgeState(
  claims: DoneBadgeClaims,
): Promise<DoneBadgeState | null> {
  const { orgId, workspaceId, item } = claims;
  return runInTenantScope({ orgId, workspaceId }, () =>
    withTenantDb(async (tx) => {
      const items = schema.workItems;
      const [found] = await tx
        .select({ recordDigest: items.doneRecordDigest })
        .from(items)
        .where(
          and(
            eq(items.orgId, orgId),
            eq(items.workspaceId, workspaceId),
            eq(items.publicId, item),
            isNull(items.deletedAt),
          ),
        )
        .limit(1);
      if (!found) return null;
      if (found.recordDigest === null) return "none";

      const verdicts = schema.workDoneVerdicts;
      const [latest] = await tx
        .select({ verdict: verdicts.verdict })
        .from(verdicts)
        .where(
          and(
            eq(verdicts.orgId, orgId),
            eq(verdicts.workspaceId, workspaceId),
            eq(verdicts.recordDigest, found.recordDigest),
          ),
        )
        // The id is a UUIDv7, so it breaks a tie in time order.
        .orderBy(desc(verdicts.createdAt), desc(verdicts.id))
        .limit(1);
      if (!latest) return "none";
      // The table's check constraint allows only the four verdicts.
      if (!isVerdict(latest.verdict)) {
        throw new Error(`work.done_verdicts holds an unknown verdict for ${item}`);
      }
      return latest.verdict;
    }),
  );
}

/** What the badge route reads. Tests pass their own. */
export interface WorkDoneBadgeDeps {
  signingKey: () => DoneAttestationKey | null;
  readState: (claims: DoneBadgeClaims) => Promise<DoneBadgeState | null>;
}

const defaultDeps: WorkDoneBadgeDeps = {
  signingKey: () => doneAttestationKeyFromEnv(),
  readState: readDoneBadgeState,
};

export function createWorkDoneBadgeRoute(
  deps: WorkDoneBadgeDeps = defaultDeps,
): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  route.get("/:file", async (c) => {
    const file = c.req.param("file");
    const key = deps.signingKey();
    const claims =
      key && file.endsWith(SVG)
        ? readDoneBadgeToken(file.slice(0, -SVG.length), key.publicKeyPem)
        : null;
    const state = claims ? await deps.readState(claims) : null;
    if (state === null) {
      return c.json({ error: "not_found" }, 404, { "Cache-Control": "no-store" });
    }
    return new Response(renderDoneBadge(state), {
      status: 200,
      headers: {
        "Content-Type": "image/svg+xml; charset=utf-8",
        // GitHub's image proxy honors this, so a README shows a new verdict
        // within a minute.
        "Cache-Control": "public, max-age=60",
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  return route;
}

export const workDoneBadgeRoute = createWorkDoneBadgeRoute();
