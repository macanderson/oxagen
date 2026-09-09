import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";
import type { ContextQuery } from "@contextgraphprotocol/typescript-sdk";
import type { Namespace } from "@oxagen/engram";
import { describe, expect, it } from "vitest";
import { contentDigest, renderContent } from "./frames";
import { createContextProvider, PROVIDER_NAME } from "./provider";
import { FakeEpisodicStore, fakeRecord } from "./testing/fake-store";

const NAMESPACE: Namespace = { org: "acme", workspace: "platform" };

const DEPLOY = fakeRecord({
  id: "1".repeat(64),
  kind: "episodic",
  body: { text: "the deploy failed at 3am" },
  salience: 0.4,
  createdAt: 1_700_000_000_000,
});
const ROLLBACK = fakeRecord({
  id: "2".repeat(64),
  kind: "semantic",
  body: { text: "rollback takes four minutes" },
  salience: 0.9,
  createdAt: 1_700_000_100_000,
});
const OTHER_WORKSPACE = fakeRecord({
  id: "3".repeat(64),
  body: { text: "the deploy failed elsewhere" },
  namespace: { org: "acme", workspace: "other" },
});

function providerOver(records = [DEPLOY, ROLLBACK, OTHER_WORKSPACE]) {
  return createContextProvider({
    namespace: NAMESPACE,
    store: new FakeEpisodicStore(records),
  });
}

function ask(overrides: Partial<ContextQuery> = {}): ContextQuery {
  return {
    goal: "why did the deploy fail",
    max_frames: 10,
    max_tokens: 1000,
    ...overrides,
  };
}

describe("info", () => {
  it("declares a read-only, no-egress posture", () => {
    const info = providerOver().info();
    expect(info.name).toBe(PROVIDER_NAME);
    expect(info.data_flow).toEqual({
      reads: true,
      writes: false,
      egress: false,
      egress_scopes: ["local-only"],
    });
  });
});

describe("capabilities", () => {
  it("declares only what it can back", () => {
    const caps = providerOver().capabilities();
    expect(caps.correlation).toBe(true);
    expect(caps.verify).toBe(true);
    expect(caps.graph).toBe(false);
    expect(caps.resolve).toBe(false);
    expect(caps.embeddings_fingerprint).toBeNull();
    expect(caps.representations).toEqual(["full"]);
  });

  it("advertises exactly the kinds query can return", () => {
    expect(
      [...(providerOver().capabilities().query.kinds ?? [])].sort(),
    ).toEqual(["episode", "fact", "graph", "memory"]);
  });
});

describe("query", () => {
  it("serves only this provider's workspace", async () => {
    const result = await providerOver().query(ask({ query_text: "deploy" }));
    const ids = result.frames.map((frame) => frame.id);
    expect(ids).toContain(DEPLOY.id);
    expect(ids).not.toContain(OTHER_WORKSPACE.id);
  });

  it("ranks by lexical relevance when the query carries text", async () => {
    const result = await providerOver().query(
      ask({ query_text: "rollback minutes" }),
    );
    expect(result.frames[0]?.id).toBe(ROLLBACK.id);
  });

  it("falls back to salience when there is nothing to be relevant to", async () => {
    const result = await providerOver().query(ask());
    expect(result.frames[0]?.id).toBe(ROLLBACK.id);
    expect(result.frames[0]?.score).toBe(ROLLBACK.salience);
  });

  it("reports an honest token cost on every frame", async () => {
    const result = await providerOver().query(ask());
    for (const frame of result.frames) {
      expect(frame.token_cost).toBe(budgetTokens(frame.content));
    }
  });

  it("never spends more than the budget it was given", async () => {
    const result = await providerOver().query(ask({ max_tokens: 12 }));
    const spent = result.frames.reduce((sum, f) => sum + f.token_cost, 0);
    expect(spent).toBeLessThanOrEqual(12);
    expect(result.truncated).toBe(true);
  });

  it("honours max_frames", async () => {
    const result = await providerOver().query(ask({ max_frames: 1 }));
    expect(result.frames).toHaveLength(1);
    expect(result.dropped_estimate).toBe(1);
  });

  it("filters to the requested kinds", async () => {
    const result = await providerOver().query(ask({ kinds: ["episode"] }));
    expect(result.frames.map((f) => f.id)).toEqual([DEPLOY.id]);
  });

  it("returns nothing for a kind it does not serve", async () => {
    const result = await providerOver().query(ask({ kinds: ["doc"] }));
    expect(result).toEqual({ frames: [], truncated: false });
  });

  it("excludes records newer than as_of", async () => {
    const result = await providerOver().query(
      ask({ as_of: new Date(1_700_000_050_000).toISOString() }),
    );
    expect(result.frames.map((f) => f.id)).toEqual([DEPLOY.id]);
  });

  it("applies as_of on the lexical route too", async () => {
    const result = await providerOver().query(
      ask({
        query_text: "deploy rollback",
        as_of: new Date(1_700_000_050_000).toISOString(),
      }),
    );
    expect(result.frames.map((f) => f.id)).toEqual([DEPLOY.id]);
  });

  it("ignores an as_of it cannot parse rather than dropping everything", async () => {
    const result = await providerOver().query(ask({ as_of: "not a date" }));
    expect(result.frames.length).toBeGreaterThan(0);
  });

  it("returns nothing for a budget of nothing", async () => {
    await expect(providerOver().query(ask({ max_frames: 0 }))).resolves.toEqual(
      {
        frames: [],
        truncated: false,
      },
    );
    await expect(providerOver().query(ask({ max_tokens: 0 }))).resolves.toEqual(
      {
        frames: [],
        truncated: false,
      },
    );
  });

  it("answers an empty store with an empty, untruncated result", async () => {
    const result = await providerOver([]).query(ask());
    expect(result).toEqual({ frames: [], truncated: false });
  });

  it("treats whitespace-only query text as no text", async () => {
    const result = await providerOver().query(ask({ query_text: "   " }));
    expect(result.frames[0]?.score).toBe(ROLLBACK.salience);
  });
});

describe("verify", () => {
  const digestOf = (record: typeof DEPLOY) =>
    contentDigest(renderContent(record.body));

  it("vouches for a frame whose bytes still match", async () => {
    const provider = providerOver();
    const response = await provider.verify?.({
      frames: [
        {
          provider_id: PROVIDER_NAME,
          frame_id: DEPLOY.id,
          content_digest: digestOf(DEPLOY),
        },
      ],
    });
    expect(response?.verdicts[0]?.status).toBe("valid");
  });

  it("vouches for existence when asked without a digest", async () => {
    const response = await providerOver().verify?.({
      frames: [{ provider_id: PROVIDER_NAME, frame_id: DEPLOY.id }],
    });
    expect(response?.verdicts[0]?.status).toBe("valid");
  });

  it("reports a record it no longer holds as gone", async () => {
    const response = await providerOver().verify?.({
      frames: [{ provider_id: PROVIDER_NAME, frame_id: "9".repeat(64) }],
    });
    expect(response?.verdicts[0]?.status).toBe("gone");
  });

  it("reports a digest mismatch as stale, and offers the current one", async () => {
    const response = await providerOver().verify?.({
      frames: [
        {
          provider_id: PROVIDER_NAME,
          frame_id: DEPLOY.id,
          content_digest: "sha256:stale",
        },
      ],
    });
    expect(response?.verdicts[0]?.status).toBe("stale");
    expect(response?.verdicts[0]?.replacement_digest).toBe(digestOf(DEPLOY));
  });

  // `provider_id` is the host's name for this provider, not this provider's
  // name for itself: the reference host labels a provider under test
  // `provider-under-test`. Comparing it against PROVIDER_NAME meant declining
  // to vouch for every frame this provider had just served, which is what the
  // upstream conformance suite's `verify-honesty` check failed on.
  it("vouches for its own frame under whatever id the host gave it", async () => {
    const response = await providerOver().verify?.({
      frames: [{ provider_id: "provider-under-test", frame_id: DEPLOY.id }],
    });
    expect(response?.verdicts[0]?.status).toBe("valid");
  });

  it("answers every frame it was asked about, in order", async () => {
    const response = await providerOver().verify?.({
      frames: [
        { provider_id: PROVIDER_NAME, frame_id: DEPLOY.id },
        { provider_id: "provider-under-test", frame_id: ROLLBACK.id },
        { provider_id: PROVIDER_NAME, frame_id: "9".repeat(64) },
      ],
    });
    expect(response?.verdicts.map((v) => v.status)).toEqual([
      "valid",
      "valid",
      "gone",
    ]);
  });
});
