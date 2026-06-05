# API route (`/v1`)

A Next.js App Router route handler under the `/v1` prefix. Import the shared Zod schemas. Branch on execution mode. Log with structured levels.

## Sync handler

```ts
// app/v1/<capability>/route.ts
import { NextRequest, NextResponse } from "next/server";
import { <camelName>Input, <camelName>Capability } from "@oxagen/capabilities/<capability-name>";
import { requireCaller } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { run<PascalName> } from "@/lib/capabilities/<capability-name>";

export async function POST(req: NextRequest) {
  const caller = await requireCaller(req); // resolves tenant + workspace scope
  const parsed = <camelName>Input.safeParse(await req.json());
  if (!parsed.success) {
    logger.warn("invalid <capability> input", { issues: parsed.error.issues, tenant: caller.tenantId });
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  logger.debug("running <capability>", { tenant: caller.tenantId, count: parsed.data.items.length });
  try {
    const result = await run<PascalName>(caller, parsed.data);
    logger.info("<capability> complete", { tenant: caller.tenantId });
    return NextResponse.json(result);
  } catch (err) {
    logger.error("<capability> failed", { err, tenant: caller.tenantId });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
```

## Async/batch handler

For `mode: "async"` or large batches, enqueue and return a job handle instead of the result:

```ts
  const job = await enqueue<PascalName>(caller, parsed.data);
  logger.info("<capability> enqueued", { tenant: caller.tenantId, jobId: job.id });
  return NextResponse.json({ jobId: job.id, status: "queued" }, { status: 202 });
```

Pair it with a status route at `app/v1/<capability>/[jobId]/route.ts`. See `async-batch.md`.

## Rules

- Always `requireCaller` first; scope every query by the resolved tenant and workspace.
- Validate with the shared schema. Never redeclare the shape inline.
- Log at debug (entry/trace), info (lifecycle), warn (bad input, recoverable), error (failure). Never swallow errors silently.
- Keep the handler thin. Business logic lives in `lib/capabilities/`, so the MCP tool can call the same function.
