import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { workCriterionClaim } from "@oxagen/oxagen/contracts/work.criterion.claim";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Claim, for the agent working a send, that one criterion of the brief is
 * met on the pull request's head commit (`claim_work_criterion`, ADR-251
 * amended 2026-10-03). `oxagen work claim` calls it from inside the run,
 * with the key of the host that claimed the send.
 *
 * Machine-to-machine: the host's API key carries its org and workspace, so
 * this route lives on the static /v1/tacho router beside the work order
 * claim, under the host's own rate limit, and refuses anything but an API
 * key before it reads the body. The org-scoped route
 * (`work.criterion.claim.ts`) takes the same call by workspace slug, which a
 * host does not address its calls by. The handler reads the host from the
 * key and files the claim as the run linked to the send.
 */
// A claim names a work item, a work order, a criterion, and a commit, with
// a statement of at most 2000 characters. JSON escapes can grow that to
// about 12 KiB. 16 KiB leaves room and refuses a large body before it is
// read. A body past the limit answers 413. tacho.host-routes.ts mounts
// routes by this limit.
const MAX_BODY_BYTES = 16 * 1024;

export const workCriterionHostClaimRoute = new Hono<AppEnv>();

workCriterionHostClaimRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

workCriterionHostClaimRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

workCriterionHostClaimRoute.post("/work-orders/criteria/claim", async (c) => {
  const mediaType = c.req
    .header("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    throw new HTTPException(415, {
      message: "Content-Type must be application/json",
    });
  }

  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = workCriterionClaim.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(workCriterionClaim.name, input, ctx, {
    surface: "api",
  });
  c.header("Cache-Control", "no-store");
  return c.json(output);
});
