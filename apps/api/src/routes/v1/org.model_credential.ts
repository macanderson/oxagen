import { Hono } from "hono";
import { orgModelCredentialDelete } from "@oxagen/oxagen/contracts/org.model_credential.delete";
import { orgModelCredentialGet } from "@oxagen/oxagen/contracts/org.model_credential.get";
import { orgModelCredentialSet } from "@oxagen/oxagen/contracts/org.model_credential.set";
import { orgModelCredentialVerify } from "@oxagen/oxagen/contracts/org.model_credential.verify";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Combined ADR-053 model-credential route — the
 * `/v1/:org_slug/:workspace_slug/org/model-credential` surface. One file covers
 * the four capabilities (the combined-route precedent `org.data_plane.ts`
 * set); each handler parses the contract input, builds the kernel context,
 * and invokes with surface "api".
 *
 * GET    /        → the redacted credential view (never the key; its last four
 *                   characters at most)
 * PUT    /        → store the organisation's own vendor key, replacing any
 *                   already stored
 * DELETE /        → remove the stored key and return to the platform key
 * POST   /verify  → check a key against the vendor; `{}` checks the stored one
 *
 * PUT rather than POST for the store: `set_model_credential` replaces the one
 * credential an organisation holds and is idempotent under repetition with the
 * same body. Verify is a POST because it carries a candidate key in the body
 * and is not a resource write.
 */
export const orgModelCredentialRoute = new Hono<AppEnv>();

orgModelCredentialRoute.get("/", async (c) => {
  const input = orgModelCredentialGet.input.parse({});
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgModelCredentialGet.name, input, ctx, { surface: "api" }),
  );
});

orgModelCredentialRoute.put("/", async (c) => {
  const body = orgModelCredentialSet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgModelCredentialSet.name, body, ctx, { surface: "api" }),
  );
});

orgModelCredentialRoute.delete("/", async (c) => {
  const input = orgModelCredentialDelete.input.parse({});
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgModelCredentialDelete.name, input, ctx, {
      surface: "api",
    }),
  );
});

orgModelCredentialRoute.post("/verify", async (c) => {
  // An empty body verifies the stored key; a `{provider, apiKey}` pair
  // verifies a candidate before it is stored. The contract enforces that the
  // two fields travel together.
  const raw = await c.req.text();
  const body = orgModelCredentialVerify.input.parse(
    raw.trim() === "" ? {} : JSON.parse(raw),
  );
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgModelCredentialVerify.name, body, ctx, {
      surface: "api",
    }),
  );
});
