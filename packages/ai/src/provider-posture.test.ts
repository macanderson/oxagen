import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { gatewayModels, type Vendor } from "./catalog";
import {
  allPostures,
  asVendor,
  ATTACHMENT_POSTURE,
  CACHE_POSTURE,
  postureBadges,
  postureForModel,
  posturesFor,
  REASONING_POSTURE,
  STRUCTURED_OUTPUT_POSTURE,
  vendorFromModelId,
  WITNESS_SOURCES,
} from "./provider-posture";

// The enforcement suite for the provider posture registry. It runs in BOTH
// directions, which is the whole point of the matrix:
//
//   forward — a vendor the gateway can route to with no posture row fails.
//   reverse — a row whose named witness test no longer exists fails.
//
// Without the reverse direction the matrix decays into confident-sounding
// claims backed by tests that were renamed away, which is worse than no matrix
// at all: it reads as proof while proving nothing.

const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The witness sources, read from disk at test time. The Rust original embeds
 * these with `include_str!`; reading them here is the same idea — the proof
 * that a witness exists is the source text itself, not a claim about it.
 */
function witnessSources(): string {
  return WITNESS_SOURCES.map((f) =>
    readFileSync(join(SRC_DIR, f), "utf8"),
  ).join("\n");
}

/** Every witness named anywhere in the matrix, tagged with its axis + vendor. */
function declaredWitnesses(): {
  axis: string;
  vendor: Vendor;
  witness: string;
}[] {
  const out: { axis: string; vendor: Vendor; witness: string }[] = [];
  for (const p of allPostures()) {
    if (p.cache.kind === "opt-in" || p.cache.kind === "implicit") {
      out.push({ axis: "cache", vendor: p.vendor, witness: p.cache.witness });
    }
    if (p.reasoning.kind === "controllable") {
      out.push({
        axis: "reasoning",
        vendor: p.vendor,
        witness: p.reasoning.witness,
      });
    }
    if (
      p.structuredOutput.kind === "native" ||
      p.structuredOutput.kind === "emulated"
    ) {
      out.push({
        axis: "structuredOutput",
        vendor: p.vendor,
        witness: p.structuredOutput.witness,
      });
    }
    if (p.attachments.kind === "supported") {
      out.push({
        axis: "attachments",
        vendor: p.vendor,
        witness: p.attachments.witness,
      });
    }
  }
  return out;
}

describe("provider posture registry — completeness (forward gate)", () => {
  it("declares a row on every axis for every vendor the catalog can route to", () => {
    // The gateway model id's `creator` prefix IS the vendor, so the catalog is
    // the enumerable source of truth for "reachable via modelIdOf()". A vendor
    // that ships a model but no posture row is the exact gap this fails on.
    const catalogVendors = [
      ...new Set(gatewayModels.map((m) => m.vendor)),
    ].sort();
    expect(catalogVendors.length).toBeGreaterThan(0);

    for (const vendor of catalogVendors) {
      expect(
        CACHE_POSTURE[vendor],
        `no cache posture row for "${vendor}"`,
      ).toBeDefined();
      expect(
        REASONING_POSTURE[vendor],
        `no reasoning posture row for "${vendor}"`,
      ).toBeDefined();
      expect(
        STRUCTURED_OUTPUT_POSTURE[vendor],
        `no structured-output posture row for "${vendor}"`,
      ).toBeDefined();
      expect(
        ATTACHMENT_POSTURE[vendor],
        `no attachment posture row for "${vendor}"`,
      ).toBeDefined();
    }
  });

  it("every model in the catalog resolves to a posture through its gateway id", () => {
    for (const model of gatewayModels) {
      const posture = postureForModel(model.id);
      expect(
        posture,
        `no posture resolved for catalog model "${model.id}"`,
      ).toBeDefined();
      expect(posture?.vendor).toBe(model.vendor);
    }
  });

  it("carries no posture row for a vendor the catalog never ships (no dead rows)", () => {
    const catalogVendors = new Set(gatewayModels.map((m) => m.vendor));
    for (const vendor of Object.keys(CACHE_POSTURE) as Vendor[]) {
      expect(
        catalogVendors.has(vendor),
        `posture row for "${vendor}" but no catalog model ships it — stale row or missing model`,
      ).toBe(true);
    }
  });

  it("covers exactly the same vendor set on all four axes", () => {
    const keys = (o: object) => Object.keys(o).sort();
    const cache = keys(CACHE_POSTURE);
    expect(keys(REASONING_POSTURE)).toEqual(cache);
    expect(keys(STRUCTURED_OUTPUT_POSTURE)).toEqual(cache);
    expect(keys(ATTACHMENT_POSTURE)).toEqual(cache);
  });
});

describe("provider posture registry — witness integrity (reverse gate)", () => {
  it("names at least one witness (guards against a matrix of pure prose)", () => {
    expect(declaredWitnesses().length).toBeGreaterThan(0);
  });

  it("every named witness exists as a test in the witness sources", () => {
    const sources = witnessSources();
    for (const { axis, vendor, witness } of declaredWitnesses()) {
      expect(
        sources.includes(witness),
        `${axis}-posture witness for "${vendor}" not found in ${WITNESS_SOURCES.join(", ")}: ` +
          `"${witness}" — the test was renamed or deleted, so the row's proof has rotted`,
      ).toBe(true);
    }
  });

  it("reads every declared witness source (a missing file fails loudly)", () => {
    for (const file of WITNESS_SOURCES) {
      expect(readFileSync(join(SRC_DIR, file), "utf8").length).toBeGreaterThan(
        0,
      );
    }
  });

  it("holds the Anthropic cache row to an opt-in posture with a wire witness", () => {
    // The motivating defect, pinned: Anthropic's cache is explicit opt-in, so a
    // row that ever softens to "implicit" would re-open the silent 0%-hit,
    // full-rate-billing failure this registry exists to prevent.
    const anthropic = CACHE_POSTURE.anthropic;
    expect(anthropic.kind).toBe("opt-in");
    if (anthropic.kind !== "opt-in") throw new Error("unreachable");
    expect(anthropic.mechanism).toMatch(/cacheControl|cache_control/);
    expect(witnessSources()).toContain(anthropic.witness);
  });

  it("holds every implicit cache row to the normalized gateway telemetry field", () => {
    for (const p of allPostures()) {
      if (p.cache.kind !== "implicit") continue;
      expect(
        p.cache.telemetry,
        `implicit cache row for "${p.vendor}" does not name the telemetry field it relies on`,
      ).toMatch(
        /cacheReadTokens|cached_tokens|cachedContentTokenCount|prompt_cache_hit_tokens/,
      );
    }
  });
});

describe("provider posture registry — row hygiene", () => {
  it("gives every no-witness variant a human-checkable reason or note", () => {
    for (const p of allPostures()) {
      if (p.cache.kind === "not-applicable") {
        expect(
          p.cache.reason.length,
          `empty cache reason for "${p.vendor}"`,
        ).toBeGreaterThan(20);
      }
      if (
        p.reasoning.kind === "fixed-on" ||
        p.reasoning.kind === "fixed-off" ||
        p.reasoning.kind === "unsupported"
      ) {
        expect(
          p.reasoning.note.length,
          `empty reasoning note for "${p.vendor}"`,
        ).toBeGreaterThan(20);
      }
      if (p.reasoning.kind === "not-applicable") {
        expect(p.reasoning.reason.length).toBeGreaterThan(20);
      }
      if (p.structuredOutput.kind === "not-applicable") {
        expect(p.structuredOutput.reason.length).toBeGreaterThan(20);
      }
      if (p.attachments.kind === "text-only") {
        expect(p.attachments.note.length).toBeGreaterThan(20);
      }
      if (p.attachments.kind === "not-applicable") {
        expect(p.attachments.reason.length).toBeGreaterThan(20);
      }
    }
  });

  it("gives every witness-carrying variant a non-trivial mechanism description", () => {
    for (const p of allPostures()) {
      if (p.cache.kind === "opt-in")
        expect(p.cache.mechanism.length).toBeGreaterThan(20);
      if (p.reasoning.kind === "controllable") {
        expect(p.reasoning.mechanism.length).toBeGreaterThan(20);
      }
      if (p.structuredOutput.kind !== "not-applicable") {
        expect(p.structuredOutput.mechanism.length).toBeGreaterThan(20);
      }
      if (p.attachments.kind === "supported") {
        expect(p.attachments.mechanism.length).toBeGreaterThan(20);
        expect(p.attachments.kinds.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps image-only vendors as accurate n/a rows rather than forcing a text shape", () => {
    // bfl (FLUX) reaches the platform through selectImageModel(), never the
    // chat path — claiming a cache or reasoning posture for it would be fiction.
    expect(CACHE_POSTURE.bfl.kind).toBe("not-applicable");
    expect(REASONING_POSTURE.bfl.kind).toBe("not-applicable");
    expect(STRUCTURED_OUTPUT_POSTURE.bfl.kind).toBe("not-applicable");
    expect(ATTACHMENT_POSTURE.bfl.kind).toBe("not-applicable");
  });
});

describe("vendorFromModelId / asVendor / posturesFor", () => {
  it("takes the creator prefix of a gateway model id", () => {
    expect(vendorFromModelId("anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(vendorFromModelId("google/veo-3.0-generate-001")).toBe("google");
  });

  it("returns a bare slug unchanged when there is no creator prefix", () => {
    expect(vendorFromModelId("gpt-5.2")).toBe("gpt-5.2");
  });

  it("narrows a known vendor and rejects an unknown one", () => {
    expect(asVendor("anthropic")).toBe("anthropic");
    expect(asVendor("no-such-vendor")).toBeUndefined();
  });

  it("resolves a posture for every known vendor", () => {
    for (const vendor of Object.keys(CACHE_POSTURE) as Vendor[]) {
      expect(posturesFor(vendor)?.vendor).toBe(vendor);
    }
  });

  it("returns undefined for an unknown vendor rather than guessing a posture", () => {
    // A BYOK customer can point at anything; an unknown provider must read as
    // "unknown", never as "supported".
    expect(posturesFor("no-such-vendor")).toBeUndefined();
    expect(postureForModel("no-such-vendor/some-model")).toBeUndefined();
    expect(postureForModel("bare-slug-no-prefix")).toBeUndefined();
  });

  it("rejects Object.prototype keys instead of returning a garbage row", () => {
    // `key in obj` walks the prototype chain, so a naive lookup answers true
    // for "toString"/"constructor" and hands back a function as a posture.
    // The vendor string is caller-controlled (BYOK), so this must be an
    // own-property check.
    for (const key of [
      "toString",
      "constructor",
      "hasOwnProperty",
      "__proto__",
    ]) {
      expect(
        asVendor(key),
        `asVendor("${key}") must be undefined`,
      ).toBeUndefined();
      expect(
        posturesFor(key),
        `posturesFor("${key}") must be undefined`,
      ).toBeUndefined();
      expect(postureForModel(`${key}/some-model`)).toBeUndefined();
    }
  });

  it("lists every vendor exactly once, alphabetically", () => {
    const all = allPostures();
    const vendors = all.map((p) => p.vendor);
    expect(new Set(vendors).size).toBe(vendors.length);
    expect(vendors).toEqual([...vendors].sort());
    expect(vendors.length).toBe(Object.keys(CACHE_POSTURE).length);
  });
});

describe("postureBadges", () => {
  it("returns one badge per axis for every vendor", () => {
    for (const p of allPostures()) {
      const badges = postureBadges(p);
      expect(badges.map((b) => b.axis)).toEqual([
        "cache",
        "reasoning",
        "structuredOutput",
        "attachments",
      ]);
      for (const badge of badges) {
        expect(
          badge.label.length,
          `empty badge label for "${p.vendor}"`,
        ).toBeGreaterThan(0);
        expect(
          badge.detail.length,
          `empty badge detail for "${p.vendor}"`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("flags the opt-in cache as requiring action and the implicit ones as not", () => {
    const anthropic = postureBadges(posturesFor("anthropic")!);
    expect(anthropic.find((b) => b.axis === "cache")?.requiresAction).toBe(
      true,
    );
    const openai = postureBadges(posturesFor("openai")!);
    expect(openai.find((b) => b.axis === "cache")?.requiresAction).toBe(false);
  });

  it("flags emulated structured output as requiring action (a parse can fail)", () => {
    const mistral = postureBadges(posturesFor("mistral")!);
    expect(
      mistral.find((b) => b.axis === "structuredOutput")?.requiresAction,
    ).toBe(true);
    const openai = postureBadges(posturesFor("openai")!);
    expect(
      openai.find((b) => b.axis === "structuredOutput")?.requiresAction,
    ).toBe(false);
  });

  it("labels attachment support by the accepted input kinds", () => {
    const google = postureBadges(posturesFor("google")!);
    expect(google.find((b) => b.axis === "attachments")?.label).toBe(
      "Accepts: image, video, audio",
    );
    const mistral = postureBadges(posturesFor("mistral")!);
    expect(mistral.find((b) => b.axis === "attachments")?.label).toBe(
      "Accepts: text only",
    );
    const bfl = postureBadges(posturesFor("bfl")!);
    expect(bfl.find((b) => b.axis === "attachments")?.label).toBe(
      "Attachments: n/a",
    );
  });

  it("labels reasoning by posture kind", () => {
    expect(
      postureBadges(posturesFor("anthropic")!).find(
        (b) => b.axis === "reasoning",
      )?.label,
    ).toBe("Reasoning: controllable");
    expect(
      postureBadges(posturesFor("deepseek")!).find(
        (b) => b.axis === "reasoning",
      )?.label,
    ).toBe("Reasoning: no control");
    expect(
      postureBadges(posturesFor("meta")!).find((b) => b.axis === "reasoning")
        ?.label,
    ).toBe("Reasoning: none");
  });
});
