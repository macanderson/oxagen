/**
 * schema-service.test.ts — Storybook fixtures vs. live API regression.
 *
 * Bug: `schema-service` hard-coded `USE_FIXTURES = false`, so every service
 * call hit the real `/api/schema/*` route. That route exists in the live app
 * but NOT in Storybook (which has no API backend), so each schema-builder story
 * that self-fetches on mount (OnboardingRecommendation, SchemaBuilder,
 * VersionHistory, SchemaList) fired a fetch that 404'd — OnboardingRecommendation
 * caught the 404 and rendered its error box, so the story was non-functional.
 *
 * Fix: the service now serves in-memory fixtures when running under Storybook
 * (detected via the `__OXAGEN_STORYBOOK__` global set in `.storybook/preview.ts`)
 * and hits the live API otherwise. These tests pin both halves of that switch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { recommend, fetchRegistry } from "./schema-service";

const SLUGS = { orgSlug: "acme", workspaceSlug: "main" };

type StorybookGlobal = { __OXAGEN_STORYBOOK__?: boolean };

function setStorybook(on: boolean): void {
  if (on) (globalThis as StorybookGlobal).__OXAGEN_STORYBOOK__ = true;
  else delete (globalThis as StorybookGlobal).__OXAGEN_STORYBOOK__;
}

beforeEach(() => {
  vi.clearAllMocks();
  setStorybook(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setStorybook(false);
});

describe("under Storybook (no API backend)", () => {
  beforeEach(() => setStorybook(true));

  it("recommend() returns fixtures WITHOUT calling fetch (the 404 source)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await recommend(SLUGS, { sampleLimit: 200 });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.sampledCount).toBe(180);
    expect(result.proposal.schemas[0]?.name).toBe("recommended");
  });

  it("never throws even when the API route would 404", async () => {
    // A 404-returning fetch must be irrelevant under Storybook: fixtures win
    // before any request is made. This is the exact symptom the user reported.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    await expect(recommend(SLUGS)).resolves.toMatchObject({
      sampledCount: 180,
    });
    await expect(fetchRegistry(SLUGS)).resolves.toMatchObject({
      registryId: "reg_fixture_01",
    });
  });
});

describe("in the live app (real API backend)", () => {
  it("recommend() POSTs to /api/schema/recommend", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({
        proposal: { schemas: [] },
        rationale: "ok",
        sampledCount: 5,
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await recommend(SLUGS, { sampleLimit: 200 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/schema/recommend");
    expect(init).toMatchObject({ method: "POST" });
    expect(JSON.parse(init.body as string)).toEqual({
      orgSlug: "acme",
      workspaceSlug: "main",
      sampleLimit: 200,
    });
    expect(result.sampledCount).toBe(5);
  });

  it("surfaces a 404 as a thrown error (live-route failure path)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })),
    );

    await expect(recommend(SLUGS)).rejects.toThrow("Request failed (404)");
  });
});
