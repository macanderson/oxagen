import { describe, expect, it } from "vitest";
import { inngestEnvironmentComplaint, signingKeyPosture } from "./env-check";

describe("signingKeyPosture", () => {
  it("reads a production key from its prefix", () => {
    expect(signingKeyPosture("signkey-prod-abc123")).toBe("production");
  });

  it("reads every other environment as non-production", () => {
    expect(signingKeyPosture("signkey-test-abc123")).toBe("non_production");
  });

  it("declines to guess at an unrecognised format", () => {
    expect(signingKeyPosture("")).toBe("unknown");
    expect(signingKeyPosture("signkey-branch-abc123")).toBe("unknown");
  });
});

describe("inngestEnvironmentComplaint", () => {
  // The witness: this is the exact configuration production ran on, and it
  // reported success on every surface while ingesting nothing.
  it("complains when production holds a non-production signing key", () => {
    const complaint = inngestEnvironmentComplaint({
      nodeEnv: "production",
      signingKey: "signkey-test-f5616840000000000000000000000000",
    });
    expect(complaint).toContain("non-production Inngest key");
    expect(complaint).toContain("INNGEST_EVENT_KEY");
  });

  it("is silent when production holds a production signing key", () => {
    expect(
      inngestEnvironmentComplaint({
        nodeEnv: "production",
        signingKey: "signkey-prod-f5616840000000000000000000000000",
      }),
    ).toBeNull();
  });

  it("is silent outside production, where a test key is correct", () => {
    for (const nodeEnv of ["development", "test", "ci"]) {
      expect(
        inngestEnvironmentComplaint({
          nodeEnv,
          signingKey: "signkey-test-ci0000000000000000000000000000",
        }),
      ).toBeNull();
    }
  });

  it("is silent on a key format it does not recognise", () => {
    expect(
      inngestEnvironmentComplaint({
        nodeEnv: "production",
        signingKey: "signkey-branch-abc123",
      }),
    ).toBeNull();
  });
});
