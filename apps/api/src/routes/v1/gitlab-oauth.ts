/**
 * The steering connection routes, mounted on the org-only group at
 * /v1/:org_slug/connections/steering. Only an org Owner or Admin passes.
 *
 *   POST /gitlab   store a GitLab group access token for the steering repos
 *   GET  /github   start the GitHub connect (github-oauth.ts)
 *
 * GitLab takes a pasted token rather than an OAuth round trip. The steering
 * repos belong to a group, not to a person, and a GitLab OAuth token acts as
 * the person who authorized it: it stops working when they leave the group,
 * and it can reach every group they belong to. A group access token is scoped
 * to the one group and outlives any member. The owner creates it in GitLab
 * under the group's Settings > Access tokens, with the `api` scope and the
 * Maintainer role, which provisioning needs to create projects, push the
 * first commit and apply branch protection.
 *
 * The route checks the token before storing it: GitLab must accept it, it
 * must carry the `api` scope, it must see the group, it must be that group's
 * own access token, and its user must hold Maintainer or higher there. A
 * refusal answers 422 with `gitlab_token_invalid`, `gitlab_group_unreachable`,
 * `gitlab_token_not_group` or `gitlab_token_insufficient`. The token is never
 * logged or echoed.
 */
import { Hono } from "hono";
import { z } from "zod";
import { GITLAB_STEERING_PROVIDER } from "@oxagen/handlers/steering_repo.provision";
import type { AppEnv } from "../../app";
import { logger } from "../../middleware/logger";
import {
  assertMayConnectSteering,
  githubSteeringStartRoute,
  resendSteeringProvisioning,
  steeringError,
  storeSteeringToken,
} from "./github-oauth";

/**
 * The GitLab API the provision job calls through `@oxagen/gitlab/provision`.
 * apps/api does not depend on that package, so the three reads here call
 * `fetch` directly against the same base URL.
 */
const GITLAB_API = "https://gitlab.com/api/v4";

/** How long one GitLab request may take before the check gives up. */
const GITLAB_TIMEOUT_MS = 10_000;

/** GitLab's access level for the Maintainer role. Owner is 50. */
const MAINTAINER_ACCESS_LEVEL = 40;

/** A GitLab group path, such as `acme` or `acme/platform`. */
const GROUP_PATH = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

const connectGitlabBody = z.object({
  /** The group's full path, or its numeric id. */
  group: z.union([
    z.string().trim().min(1).max(255).regex(GROUP_PATH),
    z.number().int().positive(),
  ]),
  /** A group access token with the `api` scope and the Maintainer role. */
  token: z.string().trim().min(1).max(512),
});

/** What GitLab answers for `/personal_access_tokens/self`. */
interface TokenSelfBody {
  active?: boolean;
  revoked?: boolean;
  scopes?: string[];
  /** A date such as `2027-01-31`, or null for a token that does not expire. */
  expires_at?: string | null;
}

interface GroupBody {
  id?: number;
  full_path?: string;
}

interface MemberBody {
  access_level?: number;
}

interface UserBody {
  id?: number;
  username?: string;
  /** True for the bot user behind a group, project or service account token. */
  bot?: boolean;
}

/** GitLab refused the token outright (401). */
class GitlabTokenRefused extends Error {}

/** GitLab is limiting requests (429). */
class GitlabRateLimited extends Error {}

/** GitLab answered a status the check does not expect, or did not answer. */
class GitlabUnavailable extends Error {
  constructor(readonly status: number | null) {
    super(
      status === null
        ? "GitLab did not answer"
        : `GitLab answered status ${status}`,
    );
  }
}

/**
 * GET `path` from the GitLab API with `token` in the `PRIVATE-TOKEN` header,
 * which takes a group access token. A 2xx returns its body. A status in
 * `accept` returns null, so the caller can refuse the token in its own words.
 * A 401 and a 429 throw even when listed. Any other status, or no answer,
 * throws `GitlabUnavailable`. Nothing thrown carries the token.
 */
async function gitlabGet<T>(
  token: string,
  path: string,
  accept: readonly number[],
): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`${GITLAB_API}${path}`, {
      method: "GET",
      headers: { "PRIVATE-TOKEN": token, Accept: "application/json" },
      signal: AbortSignal.timeout(GITLAB_TIMEOUT_MS),
    });
  } catch {
    throw new GitlabUnavailable(null);
  }
  if (res.status === 401) throw new GitlabTokenRefused();
  if (res.status === 429) throw new GitlabRateLimited();
  if (res.status >= 200 && res.status < 300) {
    const text = await res.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GitlabUnavailable(res.status);
    }
  }
  if (accept.includes(res.status)) return null;
  throw new GitlabUnavailable(res.status);
}

/** Why a token was refused, as the 422 answers it. */
type Refusal = {
  code:
    | "gitlab_token_invalid"
    | "gitlab_group_unreachable"
    | "gitlab_token_not_group"
    | "gitlab_token_insufficient";
  message: string;
};

/**
 * Whether `user` is the bot user of an access token created in the group
 * `groupId`. GitLab names that bot `group_<id>_bot_<random>`, and older
 * GitLab versions name it `group_<id>_bot`. A personal access token's user is
 * a person, so `bot` is false. A project token's bot is named
 * `project_<id>_bot`, and a parent group's bot carries the parent's id.
 */
function isGroupTokenBot(user: UserBody, groupId: number): boolean {
  if (user.bot !== true || typeof user.username !== "string") return false;
  const prefix = `group_${groupId}_bot`;
  return user.username === prefix || user.username.startsWith(`${prefix}_`);
}

/** A token that passed every check. */
interface VerifiedGroupToken {
  group: { id: number; full_path: string };
  scopes: string[];
  expiresAt: Date | null;
}

/** GitLab's `expires_at` date as a Date, or null when it is absent or unreadable. */
function tokenExpiry(raw: string | null | undefined): Date | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Check `token` against `group`. Returns the refusal a person can act on, or
 * the group and the token's facts. `gitlabGet` throws for a 401, a 429 and an
 * unexpected status, and the route answers each.
 */
async function verifyGroupToken(
  token: string,
  group: string | number,
): Promise<{ ok: false; refusal: Refusal } | ({ ok: true } & VerifiedGroupToken)> {
  const self = await gitlabGet<TokenSelfBody>(
    token,
    "/personal_access_tokens/self",
    [403, 404],
  );
  if (self === null) {
    return {
      ok: false,
      refusal: {
        code: "gitlab_token_insufficient",
        message:
          "GitLab would not describe this token. Create a group access token with the api scope and paste it again.",
      },
    };
  }
  if (self.revoked === true || self.active === false) {
    return {
      ok: false,
      refusal: {
        code: "gitlab_token_invalid",
        message:
          "GitLab says this token is revoked or expired. Create a new group access token and paste it.",
      },
    };
  }
  const scopes = Array.isArray(self.scopes)
    ? self.scopes.filter((s): s is string => typeof s === "string")
    : [];
  if (!scopes.includes("api")) {
    return {
      ok: false,
      refusal: {
        code: "gitlab_token_insufficient",
        message:
          "The token lacks the api scope. Create a group access token with the api scope and the Maintainer role.",
      },
    };
  }

  // For a group access token, the user is the token's bot.
  const user = await gitlabGet<UserBody>(token, "/user", []);
  const userId = user?.id;
  if (user === null || typeof userId !== "number") {
    throw new GitlabUnavailable(200);
  }

  const found = await gitlabGet<GroupBody>(
    token,
    `/groups/${encodeURIComponent(String(group))}?with_projects=false`,
    [403, 404],
  );
  const groupId = found?.id;
  const groupPath = found?.full_path;
  if (typeof groupId !== "number" || typeof groupPath !== "string") {
    return {
      ok: false,
      refusal: {
        code: "gitlab_group_unreachable",
        message: `The token cannot see the group ${String(group)}. Check the group's path, or create the token in that group.`,
      },
    };
  }

  // A personal token with the api scope passes every other check and reaches
  // every group its person belongs to. Only the group's own token is scoped to
  // the one group, so refuse any other.
  if (!isGroupTokenBot(user, groupId)) {
    return {
      ok: false,
      refusal: {
        code: "gitlab_token_not_group",
        message: `The token is not an access token of the group ${groupPath}. Create one under the group's Settings > Access tokens with the api scope and the Maintainer role.`,
      },
    };
  }

  // The group's bot is a direct member of its own group, so the direct
  // membership carries its role.
  const member = await gitlabGet<MemberBody>(
    token,
    `/groups/${groupId}/members/${userId}`,
    [403, 404],
  );
  const level = member?.access_level;
  if (typeof level !== "number" || level < MAINTAINER_ACCESS_LEVEL) {
    return {
      ok: false,
      refusal: {
        code: "gitlab_token_insufficient",
        message: `The token's role in ${groupPath} is below Maintainer. Create a group access token with the Maintainer role.`,
      },
    };
  }

  return {
    ok: true,
    group: { id: groupId, full_path: groupPath },
    scopes,
    expiresAt: tokenExpiry(self.expires_at),
  };
}

/**
 * `POST /v1/:org_slug/connections/steering/gitlab` with `{ group, token }`.
 * Answers 200 `{ group_id, group_path }` once the token is stored and each
 * scope that waits on a connection has its provision event again.
 */
export const steeringConnectionRoute = new Hono<AppEnv>();

steeringConnectionRoute.post("/gitlab", async (c) => {
  const orgId = c.get("orgId");
  if (!orgId) {
    return steeringError(
      c,
      400,
      "org_required",
      "The path names no organization. Call /v1/<org_slug>/connections/steering/gitlab.",
    );
  }
  const userId = c.get("userId");
  if (!userId) {
    return steeringError(
      c,
      403,
      "forbidden",
      "Only an organization Owner or Admin can connect a steering host. Sign in as one and try again.",
    );
  }
  await assertMayConnectSteering(orgId, userId);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return steeringError(
      c,
      400,
      "validation_error",
      "The body must be JSON with a group and a token.",
    );
  }
  const parsed = connectGitlabBody.safeParse(raw);
  if (!parsed.success) {
    // The issues name fields, never values, so the token stays out of the answer.
    const fields = [
      ...new Set(parsed.error.issues.map((i) => i.path.join(".") || "body")),
    ].join(", ");
    return steeringError(
      c,
      400,
      "validation_error",
      `The body needs a group path or numeric id and a token. Check: ${fields}.`,
    );
  }
  const { group, token } = parsed.data;

  let verified: Awaited<ReturnType<typeof verifyGroupToken>>;
  try {
    verified = await verifyGroupToken(token, group);
  } catch (err) {
    if (err instanceof GitlabTokenRefused) {
      return steeringError(
        c,
        422,
        "gitlab_token_invalid",
        "GitLab refused this token. Check that it was copied whole and has not expired, or create a new one.",
      );
    }
    if (err instanceof GitlabRateLimited) {
      return steeringError(
        c,
        503,
        "gitlab_rate_limited",
        "GitLab is limiting requests. Try again in a minute.",
      );
    }
    // Log the status only. GitLab's answer and a fetch error are not logged,
    // so nothing here can carry the token.
    logger.warn(
      {
        orgId,
        status: err instanceof GitlabUnavailable ? err.status : null,
      },
      "Checking a GitLab steering token failed",
    );
    return steeringError(
      c,
      502,
      "gitlab_unavailable",
      "GitLab did not answer as expected. Try again, and check GitLab's status if it keeps failing.",
    );
  }
  if (!verified.ok) {
    return steeringError(
      c,
      422,
      verified.refusal.code,
      verified.refusal.message,
    );
  }

  try {
    const stored = await storeSteeringToken(orgId, {
      provider: GITLAB_STEERING_PROVIDER,
      providerUserId: String(verified.group.id),
      providerUserName: verified.group.full_path,
      providerUserEmail: null,
      accessToken: token,
      refreshToken: null,
      expiresAt: verified.expiresAt,
      tokenType: "Bearer",
      scopes: verified.scopes,
    });
    if (!stored) throw new Error("the upsert returned no row");
  } catch (err) {
    logger.error(
      { orgId, groupId: verified.group.id, err: String(err) },
      "Storing a GitLab steering token failed",
    );
    return steeringError(
      c,
      500,
      "store_failed",
      "The token checked out but could not be saved. Try again.",
    );
  }

  try {
    await resendSteeringProvisioning(orgId, userId, "gitlab");
  } catch (err) {
    logger.error(
      { orgId, groupId: verified.group.id, err: String(err) },
      "Sending steering repo provisioning again failed after the GitLab connect",
    );
    return steeringError(
      c,
      500,
      "provision_resend_failed",
      "The group is connected, but its steering repos did not start. Connect again to retry.",
    );
  }

  return c.json(
    { group_id: verified.group.id, group_path: verified.group.full_path },
    200,
  );
});

steeringConnectionRoute.route("/github", githubSteeringStartRoute);
