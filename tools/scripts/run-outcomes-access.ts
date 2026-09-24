#!/usr/bin/env tsx
// Trusted operator entry point. No API or app may mint this binding.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { schema, withSystemDb, closeDatabase } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { invoke, setSecurityEventEmitter } from "@oxagen/oxagen/kernel";
import { createPlatformOperatorContext } from "@oxagen/oxagen/platform-operator";
import { runOutcomesAccessSet } from "@oxagen/oxagen/contracts/run.outcomes.access.set";
import { eq } from "drizzle-orm";
import "@oxagen/handlers/register";

export function parseRunOutcomesAccessFlags(args: string[]) {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (
      !key ||
      !["--org", "--disabled", "--reason"].includes(key) ||
      !value ||
      values.has(key)
    ) {
      throw new Error("Usage: --org <slug> --disabled on|off --reason <text>");
    }
    values.set(key, value);
  }
  const org = values.get("--org");
  const disabled = values.get("--disabled");
  const reason = values.get("--reason")?.trim();
  if (
    !org ||
    (disabled !== "on" && disabled !== "off") ||
    !reason ||
    reason.length > 500
  ) {
    throw new Error("Usage: --org <slug> --disabled on|off --reason <text>");
  }
  return { org, disabled: disabled === "on", reason };
}

async function main() {
  const flags = parseRunOutcomesAccessFlags(process.argv.slice(2));
  const target = new URL(process.env["DATABASE_URL"] ?? "");
  console.log(
    `Target database: ${target.hostname}:${target.port || "5432"}${target.pathname}`,
  );
  // tenancy: global operator lookup filtered by the requested organization slug before the trusted platform-only invocation.
  const row = await withSystemDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.slug, flags.org),
      columns: { id: true },
    }),
  );
  if (!row) throw new Error("Organization not found");
  const requestId = randomUUID();
  const audits: Promise<void>[] = [];
  setSecurityEventEmitter((event) => {
    audits.push(
      emitSecurityEventAsync({
        eventType:
          event.outcome === "allow"
            ? "capability.invoke_allowed"
            : event.outcome === "deny"
              ? "capability.invoke_denied"
              : "capability.invoke_error",
        orgId: row.id,
        workspaceId: null,
        actorUserId: null,
        capability: event.capability,
        outcome: event.outcome,
        requestId,
        ip: null,
        userAgent: null,
      }),
    );
  });
  try {
    const result = await invoke(
      runOutcomesAccessSet.name,
      { orgId: row.id, disabled: flags.disabled, reason: flags.reason },
      {
        orgId: "",
        workspaceId: "",
        userId: null,
        apiKeyId: null,
        surface: "runner",
        messageId: null,
        requestId,
        platformOperator: createPlatformOperatorContext({ requestId }),
      },
    );
    console.log(JSON.stringify({ org: flags.org, requestId, policy: result }));
  } finally {
    await Promise.all(audits);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main()
    .catch((error: unknown) => {
      console.error(
        error instanceof Error
          ? error.message
          : "Run outcomes access update failed",
      );
      process.exitCode = 1;
    })
    .finally(() => closeDatabase());
}
