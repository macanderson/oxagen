import { describe, expect, it } from "vitest";
import {
  PUBLISHED_STEERING_MAX_FILES,
  publishedSteeringGet,
} from "./context.steering.published.get";

describe("get_published_steering contract", () => {
  it("is a scoped read on api, mcp and cli, outside metering", () => {
    expect(publishedSteeringGet.scoped).toBe(true);
    expect(publishedSteeringGet.mutates).toBe(false);
    expect(publishedSteeringGet.noBillingGate).toBe(true);
    expect(publishedSteeringGet.surfaces).toEqual(["api", "mcp", "cli"]);
    expect(PUBLISHED_STEERING_MAX_FILES).toBe(500);
  });

  it("takes an optional binding id and nothing else", () => {
    expect(publishedSteeringGet.input.parse({})).toEqual({});
    expect(publishedSteeringGet.input.parse({ bindingId: "rpb_0a1b" })).toEqual(
      { bindingId: "rpb_0a1b" },
    );
    expect(
      publishedSteeringGet.input.safeParse({ bindingId: "con_0a" }).success,
    ).toBe(false);
    expect(
      publishedSteeringGet.input.safeParse({ branch: "main" }).success,
    ).toBe(false);
  });

  it("answers the files at head, or none when the branch is gone", () => {
    const out = {
      bindingId: "rpb_0a1b",
      role: "main",
      fullName: "acme/widgets",
      productionBranch: "main",
      head: "abc123",
      files: [{ path: ".oxagen/workspace.toml", content: "" }],
      readAt: "2026-09-24T10:00:00.000Z",
    };
    expect(publishedSteeringGet.output.parse(out)).toEqual(out);
    expect(
      publishedSteeringGet.output.parse({ ...out, head: null, files: [] }),
    ).toMatchObject({ head: null, files: [] });
  });
});
