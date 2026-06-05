# Async / batch variant (conditional)

When the capability mode is async or batch, ship the queue handler and a job-status surface alongside the sync path. There is no Celery in v2; use a TypeScript queue/worker (Vercel-native queue, a lightweight worker, or your chosen TS queue). The contract matters more than the transport.

## Job lifecycle

1. The route or MCP tool enqueues work and returns `{ jobId, status: "queued" }` with HTTP 202.
2. A worker picks up the job, runs the same `run<PascalName>` logic (or a batched variant), and updates job status.
3. Callers poll a status route/tool for `queued | running | succeeded | failed` plus results or error.

## Worker

```ts
// packages/worker/src/handlers/<capability-name>.ts
import { run<PascalName> } from "@oxagen/capabilities/lib/<capability-name>";
import { logger } from "../logger";
import { updateJob } from "../jobs";

export async function handle<PascalName>(job: Job<<InputType>>) {
  logger.info("worker start <capability>", { jobId: job.id, tenant: job.caller.tenantId });
  try {
    await updateJob(job.id, { status: "running" });
    const result = await run<PascalName>(job.caller, job.payload);
    await updateJob(job.id, { status: "succeeded", result });
    logger.info("worker done <capability>", { jobId: job.id });
  } catch (err) {
    logger.error("worker failed <capability>", { jobId: job.id, err });
    await updateJob(job.id, { status: "failed", error: String(err) });
  }
}
```

## Status surface

```ts
// app/v1/<capability>/[jobId]/route.ts
export async function GET(req, { params }) {
  const caller = await requireCaller(req);
  const job = await getJob(params.jobId, caller); // scoped to caller's tenant
  if (!job) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ status: job.status, result: job.result, error: job.error });
}
```

## Rules

- The worker calls the identical business-logic function the sync path uses. One implementation, three entry points (API, MCP, worker).
- Job rows are tenant-scoped. A caller can only read their own tenant's jobs.
- The MCP path mirrors the async contract: tool returns a job handle, a companion status tool reads it. Never block the MCP path when the API path does not.
- Persist enough on the job to make it idempotent and retryable. Log every state transition.
