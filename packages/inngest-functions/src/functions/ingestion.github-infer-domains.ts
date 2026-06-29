import { z } from "zod";
import { createFunction } from "../create-function";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
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
 * Writes the inferred `domain` property to every matching :SourceFile and
 * :SourceSymbol node in Neo4j, enabling domain-sliced knowledge graph queries:
 *   MATCH (n:SourceFile {orgId: $orgId, domain: 'payments'})
 *
 * Reconciliation with the existing :Domain / multi-label model
 * ─────────────────────────────────────────────────────────────
 * The platform graph uses TYPE labels (:SourceFile, :SourceSymbol, :Feature…)
 * as the ontological "domain" concept. This function adds an APPLICATION domain
 * as a scalar property (`n.domain`) on top of those type-labelled nodes — it
 * does NOT introduce a new :Domain label or conflict with the existing model.
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
    const { filePaths, orgId, workspaceId, connectionId, owner, repo } =
      event.data as {
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
        generateObject<T>(args: { schema: z.ZodType<T>; system: string; prompt: string }) {
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

    // ── Step 2: Write domain property to SourceFile + SourceSymbol nodes ──────
    // The naturalKey format matches ingestion.github-parse-file.ts:
    //   `github:${connectionId}:${owner}/${repo}:${filePath}`
    await step.run("write-domains", () =>
      runInTenantScope({ orgId, workspaceId }, async () => {
        const session = scopedSession();
        try {
          for (const [filePath, domain] of domainEntries) {
            const naturalKey = `github:${connectionId}:${owner}/${repo}:${filePath}`;

            // Stamp domain on the SourceFile node.
            await session.run(
              `MATCH (f:SourceFile {naturalKey: $naturalKey, orgId: $orgId})
               SET f.domain = $domain`,
              { naturalKey, orgId, domain },
            );

            // Stamp domain on all SourceSymbol nodes for this file.
            await session.run(
              `MATCH (s:SourceSymbol {fileNaturalKey: $naturalKey, orgId: $orgId})
               SET s.domain = $domain`,
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
