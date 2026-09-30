import { afterEach, vi } from "vitest";

const fixture = vi.hoisted(() => ({ cleanup: undefined as (() => Promise<void>) | undefined }));
afterEach(async () => { await fixture.cleanup?.(); });

vi.mock("./middleware/admission", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./middleware/admission")>();
  const { API_ADMISSION_LANES, createRequestAdmission } = await import("@oxagen/telemetry/request-admission");
  const { createTestResponseTransport } = await import("./__tests__/admission-transport");
  // Route assertions do not depend on Vitest's heap or its sibling workers.
  // The real admission tests supply explicit memory pressure independently.
  const admission = createRequestAdmission(API_ADMISSION_LANES, () => ({
    heapUsed: 0, heapLimit: 2 ** 30, rss: 0, memoryLimit: 2 ** 31,
  }));
  const transport = createTestResponseTransport();
  fixture.cleanup = () => transport.cleanup();
  return {
    ...actual,
    apiAdmission: admission,
    requestAdmission: transport.wrap(actual.createApiRequestAdmission(admission)),
  };
});
