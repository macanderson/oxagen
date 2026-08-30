import { describe, it, expect, vi } from "vitest";

// The barrel re-exports notifyOrgManagers, which imports @oxagen/database.
// Stub it so importing the public surface never touches a real connection.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withSystemDb: vi.fn(),
    withTenantDb: vi.fn(),
    scopedSession: vi.fn(),
  };
});

import * as pkg from "./index";

describe("@oxagen/notifications public surface", () => {
  it("exposes every documented runtime entry point", () => {
    expect(typeof pkg.sendEmail).toBe("function");
    expect(typeof pkg.emailTransport).toBe("function");
    expect(typeof pkg.createSmtpTransport).toBe("function");
    expect(typeof pkg.createNotification).toBe("function");
    expect(typeof pkg.notifyOrgManagers).toBe("function");
    expect(typeof pkg.reauthEmailTemplate).toBe("function");
  });

  it("exposes the shared zod payload schema as a parseable validator", () => {
    expect(pkg.sendEmailInputSchema).toBeDefined();
    expect(typeof pkg.sendEmailInputSchema.safeParse).toBe("function");
  });
});
