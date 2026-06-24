import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../../lib/api-client.js";

interface ReconcileStatus {
  status: string;
  processedNodes: number;
  totalNodes: number;
  processedRelationships: number;
  totalRelationships: number;
}

/**
 * `oxagen schema reconcile <version-id> [--prune] [--poll] [--json]`
 *
 * Dispatches reconciliation workers that coerce existing graph nodes/relationships
 * to match the target schema version. Direction-agnostic: pinning an older version
 * and reconciling with --prune implements a downgrade by pruning forward-heal additions.
 */
export const schemaReconcileCommand = new Command("reconcile")
  .description(
    "Dispatch reconciliation workers to coerce/improve existing graph data to match a schema version",
  )
  .argument("<version-id>", "Target schema version public ID (scv_…)")
  .option(
    "--prune",
    "Also remove properties not in the target schema (destructive, requires confirmation)",
  )
  .option("--poll", "Poll until the job completes and print final status")
  .option("--json", "Output raw JSON")
  .action(
    async (
      versionId: string,
      options: { prune?: boolean; poll?: boolean; json?: boolean },
    ) => {
      requireAuth();
      try {
        const body: Record<string, unknown> = { versionId };

        if (options.prune) {
          // Warn user about the destructive action before dispatching.
          console.warn(
            "Warning: --prune will permanently remove off-schema properties from existing nodes.",
          );
          body.prune = true;
        }

        const data = await apiRequest<{ executionId: string }>("/schema/reconcile/dispatch", {
          method: "POST",
          body: JSON.stringify(body),
        });

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          if (!options.poll) return;
        } else {
          console.log(`Reconciliation job dispatched. Execution ID: ${data.executionId}`);
        }

        if (options.poll) {
          let done = false;
          while (!done) {
            await new Promise<void>((r) => setTimeout(r, 3000));
            const status = await apiRequest<ReconcileStatus>(
              `/schema/reconcile/status?executionId=${data.executionId}`,
            );
            process.stdout.write(
              `\rStatus: ${status.status} | Nodes: ${status.processedNodes}/${status.totalNodes} | Rels: ${status.processedRelationships}/${status.totalRelationships}   `,
            );
            if (
              status.status === "completed" ||
              status.status === "failed" ||
              status.status === "cancelled"
            ) {
              done = true;
              // Newline after the progress overwrite.
              console.log();
              if (options.json) {
                console.log(JSON.stringify(status, null, 2));
              } else {
                console.log(`Final status: ${status.status}`);
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );
