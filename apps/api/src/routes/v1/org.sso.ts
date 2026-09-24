import { Hono } from "hono";
import { orgSsoCreate } from "@oxagen/oxagen/contracts/org.sso.create";
import { orgSsoDelete } from "@oxagen/oxagen/contracts/org.sso.delete";
import { orgSsoGroupRolesSet } from "@oxagen/oxagen/contracts/org.sso.group_roles.set";
import { orgSsoList } from "@oxagen/oxagen/contracts/org.sso.list";
import { orgSsoPolicySet } from "@oxagen/oxagen/contracts/org.sso.policy.set";
import { orgSsoUpdate } from "@oxagen/oxagen/contracts/org.sso.update";
import { orgSsoVerifyDomain } from "@oxagen/oxagen/contracts/org.sso.verify_domain";
import { orgScimTokenCreate } from "@oxagen/oxagen/contracts/org.scim_token.create";
import { orgScimTokenRevoke } from "@oxagen/oxagen/contracts/org.scim_token.revoke";
import { orgScimTokenRotate } from "@oxagen/oxagen/contracts/org.scim_token.rotate";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Combined enterprise-SSO route (ADR-145), mounted at
 * `/v1/:org_slug/:workspace_slug/org/sso`. One file covers the seven
 * capabilities, as `org.model_credential.ts` does for its four. Each handler
 * parses the contract input, builds the kernel context, and invokes with
 * surface "api".
 *
 * GET    /                                    → providers and the SSO policy
 * POST   /providers                           → register a provider
 * PATCH  /providers/:providerId               → change a provider
 * DELETE /providers/:providerId               → delete a provider
 * POST   /providers/:providerId/verify-domain → check the DNS TXT record
 * PUT    /providers/:providerId/group-roles   → replace the group-role table
 * PUT    /policy                              → require SSO, or stop
 * POST   /scim-token                          → mint the SCIM token (shown once)
 * POST   /scim-token/rotate                   → replace the SCIM token
 * DELETE /scim-token                          → revoke the SCIM token
 */
export const orgSsoRoute = new Hono<AppEnv>();

orgSsoRoute.get("/", async (c) => {
  const input = orgSsoList.input.parse({});
  const ctx = capabilityContext(c);
  return c.json(await invoke(orgSsoList.name, input, ctx, { surface: "api" }));
});

orgSsoRoute.post("/providers", async (c) => {
  const body = orgSsoCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgSsoCreate.name, body, ctx, { surface: "api" }),
    201,
  );
});

orgSsoRoute.patch("/providers/:providerId", async (c) => {
  const body = orgSsoUpdate.input.parse({
    ...((await c.req.json()) as object),
    providerId: c.req.param("providerId"),
  });
  const ctx = capabilityContext(c);
  return c.json(await invoke(orgSsoUpdate.name, body, ctx, { surface: "api" }));
});

orgSsoRoute.delete("/providers/:providerId", async (c) => {
  const input = orgSsoDelete.input.parse({
    providerId: c.req.param("providerId"),
  });
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgSsoDelete.name, input, ctx, { surface: "api" }),
  );
});

orgSsoRoute.post("/providers/:providerId/verify-domain", async (c) => {
  const input = orgSsoVerifyDomain.input.parse({
    providerId: c.req.param("providerId"),
  });
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgSsoVerifyDomain.name, input, ctx, { surface: "api" }),
  );
});

orgSsoRoute.put("/providers/:providerId/group-roles", async (c) => {
  const body = orgSsoGroupRolesSet.input.parse({
    ...((await c.req.json()) as object),
    providerId: c.req.param("providerId"),
  });
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgSsoGroupRolesSet.name, body, ctx, { surface: "api" }),
  );
});

orgSsoRoute.put("/policy", async (c) => {
  const body = orgSsoPolicySet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgSsoPolicySet.name, body, ctx, { surface: "api" }),
  );
});

orgSsoRoute.post("/scim-token", async (c) => {
  const input = orgScimTokenCreate.input.parse({});
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgScimTokenCreate.name, input, ctx, { surface: "api" }),
    201,
  );
});

orgSsoRoute.post("/scim-token/rotate", async (c) => {
  const input = orgScimTokenRotate.input.parse({});
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgScimTokenRotate.name, input, ctx, { surface: "api" }),
  );
});

orgSsoRoute.delete("/scim-token", async (c) => {
  const input = orgScimTokenRevoke.input.parse({});
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgScimTokenRevoke.name, input, ctx, { surface: "api" }),
  );
});
