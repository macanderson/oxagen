import { describe, expect, it } from "vitest";
import { NotBuiltError } from "@oxagen/mcp-studio";
import type { Bundle, BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import {
  fixtureRepo,
  organizationFixtureRepo,
} from "@oxagen/oxagen/steering-repo/fixture-repo";
import { buildBundle, type BundleIdentity } from "./build";
import type { Delivery } from "./render";
import {
  queryWords,
  scoreRecord,
  searchSteering,
  STEERING_SEARCH_DEFAULT_LIMIT,
  STEERING_SEARCH_MAX_LIMIT,
  steeringSearchInputSchema,
  steeringSearchOutputSchema,
  type SteeringSearchHit,
  type SteeringSearchOutput,
} from "./search";
import { TreeReader, treeFromFiles } from "./tree";

// ── Fixture versions ─────────────────────────────────────────────────────────

/** MCP Studio's compile() stands here, so no server compiles and the tool manifest stays null. */
function refuseCompile(): never {
  throw new NotBuiltError("compile");
}

async function publish(
  files: ReadonlyMap<string, string>,
  identity: BundleIdentity,
  version: number,
  commit: string,
): Promise<Bundle> {
  const { bundle } = await buildBundle({
    identity,
    version,
    commit,
    published_at: "2026-09-24T10:00:30Z",
    reader: await TreeReader.open(treeFromFiles(files)),
    previous: null,
    compiler: refuseCompile,
  });
  return bundle;
}

const workspace = await publish(
  fixtureRepo(),
  {
    repository: "github.com/a-intel/oxagen-core-platform",
    scope: "workspace",
    organization: "a-intel",
    workspace: "core-platform",
  },
  21,
  "b5518188b20ddf02f905fadeaa50d9976abdcc90",
);

const organization = await publish(
  organizationFixtureRepo(),
  { repository: "github.com/a-intel/oxagen", scope: "organization", organization: "a-intel" },
  1,
  "0123456789abcdef0123456789abcdef01234567",
);

const both: Delivery = { workspace, organization };

const PLATFORM = "github.com/a-intel/platform";
const BILLING_SERVICE = "github.com/a-intel/billing-service";

/** The workspace fixture's records, in lineage order. */
const WORKSPACE_LINEAGES = [
  "a-intel.billing.refunds-over-100",
  "a-intel.brand.plain-words",
  "a-intel.brand.voice",
  "a-intel.design.house-ui",
  "a-intel.domain.refund",
  "a-intel.platform.ci-cache-key",
  "a-intel.platform.headings-sentence-case",
  "a-intel.platform.migration-names",
  "a-intel.platform.no-push-to-main",
  "a-intel.platform.production-branch",
  "a-intel.platform.release-steps",
  "a-intel.platform.tenant-queries",
  "a-intel.platform.write-migration",
];
const ORGANIZATION_LINEAGE = "a-intel.security.no-secrets-in-code";
/** Every record of both versions. The organization's lineage sorts last. */
const ALL_LINEAGES = [...WORKSPACE_LINEAGES, ORGANIZATION_LINEAGE];

function lineages(output: SteeringSearchOutput): string[] {
  return output.hits.map((hit) => hit.lineage);
}

function hitFor(output: SteeringSearchOutput, lineage: string): SteeringSearchHit {
  const hit = output.hits.find((entry) => entry.lineage === lineage);
  if (hit === undefined) throw new Error(`the search returned no hit for ${lineage}`);
  return hit;
}

/** The bundle with one record's description removed. */
function withoutDescription(bundle: Bundle, lineage: string): Bundle {
  return {
    ...bundle,
    records: bundle.records.map((entry): BundleRecord => {
      if (entry.lineage !== lineage) return entry;
      const { description: _description, ...rest } = entry;
      return rest;
    }),
  };
}

/** The bundle with every record renamed to one lineage. */
function withLineage(bundle: Bundle, lineage: string): Bundle {
  return { ...bundle, records: bundle.records.map((entry) => ({ ...entry, lineage })) };
}

/** The bundle with its block for one repository replaced by a block that holds only these lineages. */
function withBlock(bundle: Bundle, repository: string, held: string[]): Bundle {
  const others = bundle.always_on.filter((block) => block.repository !== repository);
  return {
    ...bundle,
    always_on: [...others, { repository, text: "", tokens: 0, lineages: held }],
  };
}

/** A record for the score tests. Only its label, description, and lineage matter. */
const BASE_RECORD: BundleRecord = {
  lineage: "a-intel.gamma",
  path: "steering/a-intel.gamma.md",
  blob: "0".repeat(40),
  id: "rec_a_intel_gamma_000000000000",
  hash: `sha256:${"0".repeat(64)}`,
  label: "Alpha rule",
  description: "Beta note",
  kind: "fact",
  force: "info",
  scope: "workspace",
  load: "relevant",
  tokens: 1,
  index_tokens: 1,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("the fixture versions", () => {
  it("hold the workspace's 13 records and the organization's one, in lineage order", () => {
    expect(workspace.records.map((entry) => entry.lineage)).toEqual(WORKSPACE_LINEAGES);
    expect(organization.records.map((entry) => entry.lineage)).toEqual([ORGANIZATION_LINEAGE]);
    expect(workspace.tools).toBeNull();
  });
});

describe("queryWords", () => {
  it("returns no words for no query", () => {
    expect(queryWords(undefined)).toEqual([]);
  });

  it("returns no words for an empty or punctuation-only query", () => {
    expect(queryWords("")).toEqual([]);
    expect(queryWords("  !?, ")).toEqual([]);
  });

  it("lowercases, splits at punctuation, and keeps the dollar sign", () => {
    expect(queryWords("Refunds, over $100!")).toEqual(["refunds", "over", "$100"]);
    expect(queryWords("a-intel.domain.refund")).toEqual(["a", "intel", "domain", "refund"]);
  });

  it("drops repeated words and keeps the first one's place", () => {
    expect(queryWords("refund Refund REFUND charge refund")).toEqual(["refund", "charge"]);
  });
});

describe("scoreRecord", () => {
  it("weighs a label match 3, a description match 2, and a lineage match 1", () => {
    expect(scoreRecord(BASE_RECORD, ["alpha"])).toBe(3);
    expect(scoreRecord(BASE_RECORD, ["beta"])).toBe(2);
    expect(scoreRecord(BASE_RECORD, ["gamma"])).toBe(1);
  });

  it("adds the weights of every word and every field a word matches", () => {
    expect(scoreRecord(BASE_RECORD, ["alpha", "beta", "gamma"])).toBe(6);
    const everywhere = {
      ...BASE_RECORD,
      label: "Refund",
      description: "A refund",
      lineage: "a-intel.refund",
    };
    expect(scoreRecord(everywhere, ["refund"])).toBe(6);
  });

  it("counts a field once however often the word repeats in it", () => {
    expect(scoreRecord({ ...BASE_RECORD, label: "alpha alpha alpha" }, ["alpha"])).toBe(3);
  });

  it("matches a word inside a longer word", () => {
    expect(scoreRecord({ ...BASE_RECORD, lineage: "a-intel.domain.refund" }, ["main"])).toBe(1);
  });

  it("scores 0 for no words or a word that matches nothing", () => {
    expect(scoreRecord(BASE_RECORD, [])).toBe(0);
    expect(scoreRecord(BASE_RECORD, ["delta"])).toBe(0);
  });

  it("lowercases the record but expects the words already lowercased, as queryWords gives them", () => {
    expect(scoreRecord({ ...BASE_RECORD, label: "ALPHA" }, ["alpha"])).toBe(3);
    expect(scoreRecord(BASE_RECORD, ["ALPHA"])).toBe(0);
  });

  it("reads a record with no description as an empty one", () => {
    const { description: _description, ...bare } = BASE_RECORD;
    expect(scoreRecord(bare, ["beta"])).toBe(0);
    expect(scoreRecord(bare, ["alpha"])).toBe(3);
  });
});

describe("searchSteering", () => {
  it("returns every record in lineage order when the input has no query", () => {
    const output = searchSteering(both, { limit: STEERING_SEARCH_MAX_LIMIT });
    expect(lineages(output)).toEqual(ALL_LINEAGES);
    expect(output.total).toBe(14);
    expect(output.workspace_version).toBe(21);
    expect(output.organization_version).toBe(1);
    expect(steeringSearchOutputSchema.parse(output)).toEqual(output);
  });

  it("returns every record when the query holds no words", () => {
    const output = searchSteering(both, { query: "?!", limit: STEERING_SEARCH_MAX_LIMIT });
    expect(lineages(output)).toEqual(ALL_LINEAGES);
  });

  it("returns the default limit of hits and counts every match in total", () => {
    const output = searchSteering(both, {});
    expect(STEERING_SEARCH_DEFAULT_LIMIT).toBe(10);
    expect(output.hits).toHaveLength(STEERING_SEARCH_DEFAULT_LIMIT);
    expect(lineages(output)).toEqual(ALL_LINEAGES.slice(0, STEERING_SEARCH_DEFAULT_LIMIT));
    expect(output.total).toBe(14);
  });

  it("returns at most limit hits, the first in order", () => {
    const output = searchSteering(both, { limit: 3 });
    expect(lineages(output)).toEqual(ALL_LINEAGES.slice(0, 3));
    expect(output.total).toBe(14);
  });

  it("ranks a query's matches by score", () => {
    // "Never push to main" matches in its label, description, and lineage (6).
    // "Production deploys from main" matches in its label (3).
    // "a-intel.domain.refund" matches only because "domain" holds "main" (1).
    const output = searchSteering(both, { query: "main" });
    expect(lineages(output)).toEqual([
      "a-intel.platform.no-push-to-main",
      "a-intel.platform.production-branch",
      "a-intel.domain.refund",
    ]);
    expect(output.total).toBe(3);
  });

  it("adds each word's score, so a record that matches more words ranks first", () => {
    // Both records score 6 for "refund". Only the first mentions approval.
    const output = searchSteering(both, { query: "refund approval" });
    expect(lineages(output)).toEqual([
      "a-intel.billing.refunds-over-100",
      "a-intel.domain.refund",
    ]);
  });

  it("breaks a score tie by lineage", () => {
    const output = searchSteering(both, { query: "migration" });
    expect(lineages(output)).toEqual([
      "a-intel.platform.migration-names",
      "a-intel.platform.write-migration",
    ]);
  });

  it("returns no hits for a query nothing matches", () => {
    const output = searchSteering(both, { query: "zebra" });
    expect(output.hits).toEqual([]);
    expect(output.total).toBe(0);
  });

  it("keeps only records of the kind asked for, from both versions", () => {
    const skills = searchSteering(both, { kind: "skill" });
    expect(lineages(skills)).toEqual([
      "a-intel.brand.voice",
      "a-intel.design.house-ui",
      "a-intel.platform.write-migration",
    ]);
    expect(skills.total).toBe(3);

    const constraints = searchSteering(both, { kind: "constraint" });
    expect(lineages(constraints)).toEqual([
      "a-intel.platform.no-push-to-main",
      ORGANIZATION_LINEAGE,
    ]);
    expect(constraints.hits.map((hit) => hit.source)).toEqual(["workspace", "organization"]);
  });

  it("leaves out a record whose repos name another repository and keeps one with no repos", () => {
    const platform = searchSteering(both, {
      repository: PLATFORM,
      limit: STEERING_SEARCH_MAX_LIMIT,
    });
    expect(lineages(platform)).toEqual(
      ALL_LINEAGES.filter((lineage) => lineage !== "a-intel.billing.refunds-over-100"),
    );
    expect(platform.total).toBe(13);

    const billing = searchSteering(both, {
      repository: BILLING_SERVICE,
      limit: STEERING_SEARCH_MAX_LIMIT,
    });
    expect(lineages(billing)).toEqual([
      "a-intel.billing.refunds-over-100",
      "a-intel.brand.plain-words",
      "a-intel.brand.voice",
      "a-intel.design.house-ui",
      "a-intel.domain.refund",
      "a-intel.platform.headings-sentence-case",
      "a-intel.platform.no-push-to-main",
      ORGANIZATION_LINEAGE,
    ]);
    expect(billing.total).toBe(8);
  });

  it("applies the kind, the repository, and the query together", () => {
    const skills = searchSteering(both, { kind: "skill", repository: BILLING_SERVICE });
    expect(lineages(skills)).toEqual(["a-intel.brand.voice", "a-intel.design.house-ui"]);

    const migrations = searchSteering(both, { query: "migration", repository: BILLING_SERVICE });
    expect(migrations.total).toBe(0);
  });

  it("marks a record always on when the block for any other repository holds it", () => {
    const output = searchSteering(both, { limit: STEERING_SEARCH_MAX_LIMIT });
    expect(Object.fromEntries(output.hits.map((hit) => [hit.lineage, hit.always_on]))).toEqual({
      // force must, but it names one repository, so only that repository's block holds it
      "a-intel.billing.refunds-over-100": false,
      "a-intel.brand.plain-words": true,
      // force may
      "a-intel.brand.voice": false,
      "a-intel.design.house-ui": false,
      // force info
      "a-intel.domain.refund": false,
      "a-intel.platform.ci-cache-key": false,
      "a-intel.platform.headings-sentence-case": true,
      // force should, but it targets a skill
      "a-intel.platform.migration-names": false,
      "a-intel.platform.no-push-to-main": true,
      "a-intel.platform.production-branch": false,
      // force should, but load relevant
      "a-intel.platform.release-steps": false,
      // force must, but load match
      "a-intel.platform.tenant-queries": false,
      "a-intel.platform.write-migration": false,
      [ORGANIZATION_LINEAGE]: true,
    });
  });

  it("returns each hit's label, description, kind, force, source, and index line", () => {
    const output = searchSteering(both, { limit: STEERING_SEARCH_MAX_LIMIT });
    expect(hitFor(output, "a-intel.platform.no-push-to-main")).toEqual({
      lineage: "a-intel.platform.no-push-to-main",
      label: "Never push to main",
      description: "Work reaches main only through a pull request.",
      kind: "constraint",
      force: "must",
      always_on: true,
      source: "workspace",
      line: "- Never push to main: Work reaches main only through a pull request. (a-intel.platform.no-push-to-main)",
    });
    expect(hitFor(output, ORGANIZATION_LINEAGE)).toEqual({
      lineage: ORGANIZATION_LINEAGE,
      label: "No secrets in code",
      description: "Credentials live in the vault, never in a repository.",
      kind: "constraint",
      force: "must",
      always_on: true,
      source: "organization",
      line: "- No secrets in code: Credentials live in the vault, never in a repository. (a-intel.security.no-secrets-in-code)",
    });
  });

  it("leaves description out of a hit whose record has none", () => {
    const delivery: Delivery = {
      workspace: withoutDescription(workspace, "a-intel.platform.no-push-to-main"),
      organization,
    };
    const hit = hitFor(
      searchSteering(delivery, { limit: STEERING_SEARCH_MAX_LIMIT }),
      "a-intel.platform.no-push-to-main",
    );
    expect(hit).not.toHaveProperty("description");
    expect(hit.line).toBe("- Never push to main (a-intel.platform.no-push-to-main)");
  });

  it("returns the workspace's record alone when both versions share a lineage", () => {
    const delivery: Delivery = {
      workspace,
      organization: withLineage(organization, "a-intel.platform.no-push-to-main"),
    };
    const output = searchSteering(delivery, { limit: STEERING_SEARCH_MAX_LIMIT });
    const shared = output.hits.filter((hit) => hit.lineage === "a-intel.platform.no-push-to-main");
    expect(shared.map((hit) => [hit.source, hit.label])).toEqual([
      ["workspace", "Never push to main"],
    ]);
    expect(output.total).toBe(13);
  });

  it("finds nothing by words only a shadowed organization record holds", () => {
    const delivery: Delivery = {
      workspace,
      organization: withLineage(organization, "a-intel.platform.no-push-to-main"),
    };
    expect(searchSteering(delivery, { query: "secrets" }).total).toBe(0);
  });

  it("marks a record always on for the repository it names when its tool is imported", () => {
    // The billing server's tools.toml imports create_refund, so publish puts the
    // record in the billing-service block even though no server compiles here.
    const output = searchSteering(both, { repository: BILLING_SERVICE, limit: STEERING_SEARCH_MAX_LIMIT });
    expect(hitFor(output, "a-intel.billing.refunds-over-100").always_on).toBe(true);
    expect(hitFor(output, "a-intel.platform.no-push-to-main").always_on).toBe(true);
  });

  it("leaves a record out of always on when the repository's block does not hold it", () => {
    // Publish leaves a record out of every block when its tool target is not
    // imported. The block decides, not the record's force and load.
    const delivery: Delivery = {
      workspace: withBlock(workspace, BILLING_SERVICE, ["a-intel.platform.no-push-to-main"]),
      organization,
    };
    const output = searchSteering(delivery, { repository: BILLING_SERVICE, limit: STEERING_SEARCH_MAX_LIMIT });
    expect(hitFor(output, "a-intel.billing.refunds-over-100").always_on).toBe(false);
    expect(hitFor(output, "a-intel.platform.no-push-to-main").always_on).toBe(true);
  });

  it("marks a record always on only on a repository whose block holds it", () => {
    const delivery: Delivery = {
      workspace: withBlock(workspace, BILLING_SERVICE, ["a-intel.billing.refunds-over-100"]),
      organization,
    };
    const billing = searchSteering(delivery, { repository: BILLING_SERVICE, limit: STEERING_SEARCH_MAX_LIMIT });
    expect(hitFor(billing, "a-intel.billing.refunds-over-100").always_on).toBe(true);
    expect(hitFor(billing, "a-intel.platform.no-push-to-main").always_on).toBe(false);
    const platform = searchSteering(delivery, { repository: PLATFORM, limit: STEERING_SEARCH_MAX_LIMIT });
    expect(hitFor(platform, "a-intel.platform.no-push-to-main").always_on).toBe(true);
  });

  it("reads an organization record against the organization's own blocks", () => {
    const output = searchSteering(both, { repository: PLATFORM, limit: STEERING_SEARCH_MAX_LIMIT });
    expect(hitFor(output, ORGANIZATION_LINEAGE).always_on).toBe(true);
  });

  it("reads a side with no published version as null and searches the other", () => {
    const workspaceOnly = searchSteering(
      { workspace, organization: null },
      { limit: STEERING_SEARCH_MAX_LIMIT },
    );
    expect(workspaceOnly.workspace_version).toBe(21);
    expect(workspaceOnly.organization_version).toBeNull();
    expect(lineages(workspaceOnly)).toEqual(WORKSPACE_LINEAGES);

    const organizationOnly = searchSteering({ workspace: null, organization }, {});
    expect(organizationOnly.workspace_version).toBeNull();
    expect(organizationOnly.organization_version).toBe(1);
    expect(lineages(organizationOnly)).toEqual([ORGANIZATION_LINEAGE]);

    expect(searchSteering({ workspace: null, organization: null }, { query: "main" })).toEqual({
      workspace_version: null,
      organization_version: null,
      hits: [],
      total: 0,
    });
  });
});

describe("steeringSearchInputSchema", () => {
  it("accepts every field", () => {
    const input = { query: "refund", kind: "skill", repository: PLATFORM, limit: 5 };
    expect(steeringSearchInputSchema.parse(input)).toEqual(input);
    expect(steeringSearchInputSchema.parse({})).toEqual({});
  });

  it("refuses a key it does not know", () => {
    expect(steeringSearchInputSchema.safeParse({ query: "refund", page: 2 }).success).toBe(false);
  });

  it("refuses a limit over STEERING_SEARCH_MAX_LIMIT and accepts the maximum", () => {
    expect(STEERING_SEARCH_MAX_LIMIT).toBe(50);
    expect(
      steeringSearchInputSchema.safeParse({ limit: STEERING_SEARCH_MAX_LIMIT + 1 }).success,
    ).toBe(false);
    expect(steeringSearchInputSchema.safeParse({ limit: STEERING_SEARCH_MAX_LIMIT }).success).toBe(
      true,
    );
  });

  it("refuses a limit under 1 or a fraction", () => {
    expect(steeringSearchInputSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(steeringSearchInputSchema.safeParse({ limit: 2.5 }).success).toBe(false);
  });

  it("refuses a kind, a repository, or a query it cannot read", () => {
    expect(steeringSearchInputSchema.safeParse({ kind: "rule" }).success).toBe(false);
    expect(steeringSearchInputSchema.safeParse({ repository: "platform" }).success).toBe(false);
    expect(steeringSearchInputSchema.safeParse({ query: "a".repeat(501) }).success).toBe(false);
  });
});
