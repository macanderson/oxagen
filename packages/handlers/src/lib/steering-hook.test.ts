import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  isSteeringHookScopeKind,
  STEERING_HOOK_DOMAIN,
  steeringHookPath,
  steeringHookTarget,
  steeringHookToken,
  type SteeringHookIdentity,
} from "./steering-hook";

const SECRET = "a-steering-hook-secret-of-32-chars!";
const WORKSPACE = "00000000-0000-4000-8000-0000000000aa";
const ORG = "00000000-0000-4000-8000-0000000000bb";
const identity: SteeringHookIdentity = {
  kind: "workspace",
  scopeId: WORKSPACE,
  projectId: 4242,
};

describe("isSteeringHookScopeKind", () => {
  it("accepts the two scope kinds and nothing else", () => {
    expect(isSteeringHookScopeKind("workspace")).toBe(true);
    expect(isSteeringHookScopeKind("organization")).toBe(true);
    expect(isSteeringHookScopeKind("org")).toBe(false);
    expect(isSteeringHookScopeKind("")).toBe(false);
  });
});

describe("steeringHookPath", () => {
  it("names the scope kind and id under the GitLab webhook prefix", () => {
    expect(steeringHookPath("workspace", WORKSPACE)).toBe(
      `/webhooks/gitlab/steering/workspace/${WORKSPACE}`,
    );
    expect(steeringHookPath("organization", ORG)).toBe(
      `/webhooks/gitlab/steering/organization/${ORG}`,
    );
  });
});

describe("steeringHookToken", () => {
  it("is the base64url HMAC-SHA256 of the domain, kind, scope and project", () => {
    const expected = createHmac("sha256", SECRET)
      .update(`${STEERING_HOOK_DOMAIN}\nworkspace\n${WORKSPACE}\n4242`)
      .digest("base64url");
    expect(steeringHookToken(SECRET, identity)).toBe(expected);
  });

  it("is stable, so a rerun writes the same token", () => {
    expect(steeringHookToken(SECRET, identity)).toBe(
      steeringHookToken(SECRET, { ...identity }),
    );
  });

  it("changes with the kind, the scope, the project and the secret", () => {
    const base = steeringHookToken(SECRET, identity);
    const others = [
      steeringHookToken(SECRET, { ...identity, kind: "organization" }),
      steeringHookToken(SECRET, { ...identity, scopeId: ORG }),
      steeringHookToken(SECRET, { ...identity, projectId: 4243 }),
      steeringHookToken(`${SECRET}x`, identity),
    ];
    for (const other of others) expect(other).not.toBe(base);
    expect(new Set(others).size).toBe(others.length);
  });

  it("carries only URL-safe characters", () => {
    expect(steeringHookToken(SECRET, identity)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("steeringHookTarget", () => {
  it("builds the URL from NEXT_PUBLIC_API_URL without a trailing slash", () => {
    const target = steeringHookTarget(identity, {
      BETTER_AUTH_SECRET: SECRET,
      NEXT_PUBLIC_API_URL: "https://api.example.test//",
    });
    expect(target).toEqual({
      url: `https://api.example.test/webhooks/gitlab/steering/workspace/${WORKSPACE}`,
      token: steeringHookToken(SECRET, identity),
    });
  });

  it("prefers the service's NEXT_PUBLIC_API_URL over the CLI's OXAGEN_API_URL", () => {
    const target = steeringHookTarget(identity, {
      BETTER_AUTH_SECRET: SECRET,
      NEXT_PUBLIC_API_URL: "https://api.isolated.example.test",
      OXAGEN_API_URL: "https://api.oxagen.sh",
    });
    expect(target.url).toBe(
      `https://api.isolated.example.test/webhooks/gitlab/steering/workspace/${WORKSPACE}`,
    );
  });

  it("falls back to the production API origin", () => {
    const target = steeringHookTarget(
      { kind: "organization", scopeId: ORG, projectId: 7 },
      { BETTER_AUTH_SECRET: SECRET },
    );
    expect(target.url).toBe(
      `https://api.oxagen.sh/webhooks/gitlab/steering/organization/${ORG}`,
    );
  });

  it("refuses without the secret", () => {
    expect(() => steeringHookTarget(identity, {})).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });
});
