import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const auditLogQueryCommand = new Command("query")
  .description(
    "Query the org's security and automation audit events with filters — " +
      "actor, capability, outcome, event type, time range — newest first.",
  )
  .option("-s, --source <source>", "Which spine: all | security | playbook", "all")
  .option("-e, --event-type <type>", "Exact event-type match")
  .option("--actor <userId>", "Filter security events by acting user id")
  .option("-c, --capability <name>", "Filter security events by capability name")
  .option("-o, --outcome <outcome>", "Filter security events: allow | deny | error | success")
  .option("--run <playbookRunId>", "Filter playbook events to a single run")
  .option("--workspace <workspaceId>", "Restrict to one workspace")
  .option("--from <iso>", "Inclusive ISO-8601 lower bound on occurredAt")
  .option("--to <iso>", "Exclusive ISO-8601 upper bound on occurredAt")
  .option("--limit <n>", "Max events (1–200)", "50")
  .option("--offset <n>", "Pagination offset", "0")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/audit/log/query", {
        method: "POST",
        body: JSON.stringify({
          source: options.source,
          eventType: options.eventType,
          actorUserId: options.actor,
          capability: options.capability,
          outcome: options.outcome,
          playbookRunId: options.run,
          workspaceId: options.workspace,
          from: options.from,
          to: options.to,
          limit: Number(options.limit),
          offset: Number(options.offset),
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to query audit log:", error);
      process.exit(1);
    }
  });
