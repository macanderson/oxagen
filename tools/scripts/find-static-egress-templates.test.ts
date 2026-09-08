import { describe, expect, it } from "vitest";
import {
  classify,
  render,
  type StaticEgressRow,
} from "./find-static-egress-templates";

const base: StaticEgressRow = {
  id: "00000000-0000-0000-0000-000000000001",
  publicId: "sbx_abc",
  orgId: "org_1",
  workspaceId: "ws_1",
  environmentId: "env_1",
  name: "prewarmed",
  slug: "prewarmed",
  isActive: true,
  isDefault: false,
  network: { mode: "static_egress" },
};

describe("classify", () => {
  it("counts an active template as needing action", () => {
    expect(classify(base).urgent).toBe(true);
  });

  it("does not count an inactive one, which cannot start a run", () => {
    const r = classify({ ...base, isActive: false });
    expect(r.urgent).toBe(false);
    expect(r.note).toContain("inactive");
  });

  it("calls out a default template, because every unnamed run resolved to it", () => {
    const r = classify({ ...base, isDefault: true });
    expect(r.urgent).toBe(true);
    expect(r.note).toContain("DEFAULT");
  });

  it("reads inactive before default, so a disabled default is not urgent", () => {
    expect(classify({ ...base, isActive: false, isDefault: true }).urgent).toBe(
      false,
    );
  });
});

describe("render", () => {
  it("says plainly when nothing declares the mode", () => {
    expect(render([])).toContain("no template declares static_egress");
  });

  it("names each template and who owns it", () => {
    const out = render([base]);
    expect(out).toContain("sbx_abc");
    expect(out).toContain("org_1");
    expect(out).toContain("ws_1");
  });

  it("counts only the ones that can still start a run", () => {
    const out = render([
      base,
      { ...base, publicId: "sbx_off", isActive: false },
    ]);
    expect(out).toContain("1 of 2 can still start a run");
  });

  it("says what the owner has to be told, not just that there is a row", () => {
    const out = render([base]);
    expect(out).toContain("never enforced");
    expect(out).toContain("#2724");
  });
});
