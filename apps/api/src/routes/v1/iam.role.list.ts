import { Hono } from "hono";
import { iamRoleList } from "@oxagen/oxagen/contracts/iam.role.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const iamRoleListRoute = new Hono<AppEnv>();

iamRoleListRoute.get("/", async (c) => {
  const q = c.req.query();
  const input = iamRoleList.input.parse({
    ...(q["scopeKind"] ? { scopeKind: q["scopeKind"] } : {}),
    ...(q["includeGrants"]
      ? { includeGrants: q["includeGrants"] === "true" }
      : {}),
    ...(q["limit"] ? { limit: Number(q["limit"]) } : {}),
    ...(q["offset"] ? { offset: Number(q["offset"]) } : {}),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(iamRoleList.name, input, ctx, { surface: "api" });
  return c.json(out);
});
