import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { tachoGithubTokenIssue } from "@oxagen/oxagen/contracts/tacho.github_token.issue";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Mint a repository-scoped GitHub token for the calling host (ADR-151).
 *
 * Machine-to-machine: the host's API key carries its immutable org and
 * workspace scope, so this route lives on the static /v1/tacho router and
 * rejects anything but an API key before the body is read.
 */
const MAX_BODY_BYTES = 4096;

export const tachoGithubTokenIssueRoute = new Hono<AppEnv>();

tachoGithubTokenIssueRoute.use("*", async (c, next) => {
  if (!c.get("apiKeyId")) {
    throw new HTTPException(401, { message: "API key required" });
  }
  await next();
});

tachoGithubTokenIssueRoute.use(
  "*",
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: () => {
      throw new HTTPException(413, { message: "Payload Too Large" });
    },
  }),
);

tachoGithubTokenIssueRoute.post("/github-token", async (c) => {
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

  const input = tachoGithubTokenIssue.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(tachoGithubTokenIssue.name, input, ctx, {
    surface: "api",
  });
  c.header("Cache-Control", "no-store");
  return c.json(output);
});
