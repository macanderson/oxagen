import { z } from "zod";
import { createFunction } from "../create-function";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { toNaturalKey } from "@oxagen/ontology/natural-key";
import { generateObjectFor } from "@oxagen/ai";
import { inferDomains } from "@oxagen/code-graph";
import type { DomainAI } from "@oxagen/code-graph";
import { logger } from "../logger";

/**
 * GitHub infer-domains Inngest function.
 *
 * Triggered by "ingestion/github.infer-domains" — emitted once per initial
 * sync by ingestion.github-initial-sync.ts after the full file tree is known.
 *
 * Calls inferDomains() (from @oxagen/code-graph) with the full repo file
 * path list, using @oxagen/ai generateObjectFor as the injected AI so the
 * call is metered, telemetry-tagged, and routed through the AI Gateway.
 *
 * Writes the inferred `domain` property (+ authority provenance) to every
 * matching :SourceFile node in Neo4j, enabling domain-sliced knowledge graph
 * queries:
 *   MATCH (n:SourceFile {orgId: $orgId, domain: 'payments'})
 *
 * Reconciliation with the existing :Domain / multi-label model
 * ─────────────────────────────────────────────────────────────
 * The platform graph uses TYPE labels (:SourceFile, :Feature…) as the
 * ontological "domain" concept. This function adds an APPLICATION domain as a
 * scalar property (`n.domain`) on top of those type-labelled nodes — it does
 * NOT introduce a new :Domain label or conflict with the existing model. The
 * classification is bounded and inferred, never authoritative RBAC truth on its
 * own (spec finding 7), so it also stamps `domainAuthority='inferred'` +
 * `domainMethod`.
 *
 * Concurrency: limited to 2 parallel inferences per org to cap AI spend.
 */
export const [ingestionGithubInferDomains] = createFunction(
  {
    id: "ingestion-github-infer-domains",
    retries: 2,
    concurrency: { limit: 2, key: "event.data.orgId" },
  },
  { event: "ingestion/github.infer-domains" },
  async ({ event, step }) => {
    // connectionId is intentionally not destructured — the domain stamp keys on
    // the canonical, connectionId-less identity now (spec finding 4).
    const { filePaths, orgId, workspaceId, owner, repo } = event.data as {
      filePaths: string[];
      orgId: string;
      workspaceId: string;
      connectionId: string;
      owner: string;
      repo: string;
    };

    // ── Step 1: Infer domains via LLM ─────────────────────────────────────────
    // Inngest steps must return JSON-serialisable values (Map is not), so we
    // convert to a plain object and back.
    const domainRecord = await step.run("infer-domains", async () => {
      const ai: DomainAI = {
        generateObject<T>(args: {
          schema: z.ZodType<T>;
          system: string;
          prompt: string;
        }) {
          return generateObjectFor<T>({
            ...args,
            telemetry: {
              orgId,
              workspaceId,
              surface: "ingestion",
              // No initiating message for ingestion domain-inference. Must be a
              // UUID or null — a synthetic string floods the UUID column in
              // token_usage and causes code-27 parse errors.
              messageId: null,
            },
            // Domain classification is deterministic in the repo's file layout:
            // the same file set yields the same domains. Cache it so a re-sync
            // (or a retry) of an unchanged tree skips the model call. Semantic
            // layer on so a near-identical layout (a few files added/removed)
            // reuses a recent result above the similarity threshold. 7-day TTL.
            cache: { ttlSeconds: 604_800, semantic: true },
          });
        },
      };
      const map = await inferDomains({ files: filePaths }, ai);
      // Return as plain object for Inngest serialisation.
      return Object.fromEntries(map) as Record<string, string>;
    });

    const domainEntries = Object.entries(domainRecord);

    logger.info(
      {
        orgId,
        workspaceId,
        owner,
        repo,
        inputFileCount: filePaths.length,
        taggedFileCount: domainEntries.length,
        domains: [...new Set(domainEntries.map(([, d]) => d))],
      },
      "ingestion-github-infer-domains: inference complete",
    );

    if (domainEntries.length === 0) {
      return { orgId, filesTagged: 0 };
    }

    // ── Step 2: Stamp the inferred domain (+ authority) on SourceFile nodes ────
    // The naturalKey is the canonical, connectionId-less identity parse-file
    // projects (github:{owner}/{repo}:{path}) — a legacy connectionId-prefixed
    // key would stamp nothing (spec finding 4). SourceSymbol nodes are gone from
    // the workspace graph (parse-file reshape), so there is no symbol stamp.
    await step.run("write-domains", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          for (const [filePath, domain] of domainEntries) {
            const naturalKey = toNaturalKey(filePath, owner, repo);

            // Domain classification is a bounded LLM inference, never
            // authoritative RBAC truth on its own (spec finding 7) — stamp the
            // domain alongside its authority provenance (namespaced `domain*`
            // so it is unambiguously about the classification, not the file).
            await session.run(
              `MATCH (f:SourceFile {naturalKey: $naturalKey, orgId: $orgId})
               SET f.domain          = $domain,
                   f.domainAuthority = 'inferred',
                   f.domainMethod    = 'llm-domain-inference'`,
              { naturalKey, orgId, domain },
            );
          }
        } finally {
          await session.close();
        }
      }),
    );

    logger.info(
      { orgId, workspaceId, owner, repo, filesTagged: domainEntries.length },
      "ingestion-github-infer-domains: completed",
    );

    return { orgId, filesTagged: domainEntries.length };
  },
);
