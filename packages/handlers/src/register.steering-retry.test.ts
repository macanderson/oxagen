// The witness for #4750. The app's kernel loads these registrations, then asks
// the registry for the capability a write names, and answers
// `tool_not_registered` when it finds none (apps/app/src/server/kernel.ts).
// On main before #4750, `retry_steering_repo_provision` resolved nothing, so
// the steering repo banner's Retry button always got that refusal.
import { getCapability, hasHandler } from "@oxagen/oxagen";
import { describe, expect, it } from "vitest";

await import("./register");

describe("the retry_steering_repo_provision registration", () => {
  it("resolves the contract the app's kernel looks up", () => {
    expect(getCapability("retry_steering_repo_provision")?.name).toBe(
      "retry_steering_repo_provision",
    );
  });

  it("resolves a handler for it", () => {
    expect(hasHandler("retry_steering_repo_provision")).toBe(true);
  });
});
