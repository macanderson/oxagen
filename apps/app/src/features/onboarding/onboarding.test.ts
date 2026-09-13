import { describe, expect, it } from "vitest";
import onboardingMessages from "../../../messages/onboarding.json";
import {
  AgentSlug,
  agentKey,
  enrollCommand,
  sdkSnippet,
  suggestNamespace,
  toSlug,
} from "./agent-key";
import { OrganizationForm } from "./org-form";
import {
  parseGateStep,
  parseRegisterStep,
  stepIndex,
  wrapMethodFor,
} from "./steps";

describe("parseGateStep", () => {
  it("renders the first step at the bare route", () => {
    expect(parseGateStep(undefined)).toBe("organization");
    expect(parseGateStep([])).toBe("organization");
  });

  it("accepts each named step", () => {
    expect(parseGateStep(["organization"])).toBe("organization");
    expect(parseGateStep(["wrap"])).toBe("wrap");
    expect(parseGateStep(["run"])).toBe("run");
  });

  it("refuses an unknown segment, a register-only step and a deeper path", () => {
    expect(parseGateStep(["name"])).toBeNull();
    expect(parseGateStep(["billing"])).toBeNull();
    expect(parseGateStep(["wrap", "extra"])).toBeNull();
  });
});

describe("parseRegisterStep", () => {
  it("renders name at the bare route and refuses the gate-only step", () => {
    expect(parseRegisterStep(undefined)).toBe("name");
    expect(parseRegisterStep(["run"])).toBe("run");
    expect(parseRegisterStep(["organization"])).toBeNull();
  });

  it("numbers steps per flow", () => {
    expect(stepIndex("gate", "wrap")).toBe(1);
    expect(stepIndex("register", "name")).toBe(0);
    expect(stepIndex("register", "organization")).toBe(-1);
  });
});

describe("agent keys", () => {
  it("joins org namespace, workspace namespace and slug", () => {
    expect(agentKey("acme", "core", "perf-watch")).toBe("acme.core.perf-watch");
  });

  it("validates an agent slug", () => {
    expect(AgentSlug.safeParse("perf-watch").success).toBe(true);
    expect(AgentSlug.safeParse("Perf Watch").success).toBe(false);
    expect(AgentSlug.safeParse("-edge-").success).toBe(false);
    expect(AgentSlug.safeParse("a").success).toBe(false);
  });

  it("maps each harness to its wrap method", () => {
    expect(wrapMethodFor("claude-code")).toBe("claude-code");
    expect(wrapMethodFor("codex-cli")).toBe("codex-cli");
    expect(wrapMethodFor("stella")).toBe("sdk");
    expect(wrapMethodFor("custom")).toBe("sdk");
  });
});

describe("toSlug and suggestNamespace", () => {
  it("derives an address from a name", () => {
    expect(toSlug("Acme Robotics")).toBe("acme-robotics");
    expect(toSlug("  Ünïcode & Co.  ")).toBe("unicode-co");
    expect(toSlug(`${"a".repeat(39)} b`)).toBe("a".repeat(39));
  });

  it("suggests a namespace of at most six characters", () => {
    expect(suggestNamespace("acme-robotics")).toBe("acme");
    expect(suggestNamespace("core-platform")).toBe("core");
    expect(suggestNamespace("internationalization")).toBe("intern");
  });
});

describe("sdkSnippet", () => {
  it.each(["ts", "py", "go"] as const)(
    "is five lines that embed the key in %s",
    (language) => {
      const snippet = sdkSnippet(language, "acme.core.perf-watch");
      expect(snippet.code.split("\n")).toHaveLength(5);
      expect(snippet.code).toContain('"acme.core.perf-watch"');
      expect(snippet.install.length).toBeGreaterThan(0);
    },
  );

  it("quotes a key so it cannot break out of the string literal", () => {
    expect(sdkSnippet("ts", 'x"; evil()').code).toContain('"x\\"; evil()"');
  });
});

describe("enrollCommand", () => {
  it("names the harness for Codex and carries a token only when there is one", () => {
    expect(enrollCommand("claude-code", "oxe_1")).toBe(
      "oxagen agent enroll --token oxe_1",
    );
    expect(enrollCommand("codex-cli", null)).toBe(
      "oxagen agent enroll --harness codex-cli",
    );
  });
});

describe("OrganizationForm", () => {
  const valid = {
    name: "Acme Robotics",
    slug: "acme",
    namespace: "acme",
    workspaceName: "core-platform",
    workspaceSlug: "core-platform",
  };

  it("accepts a complete organization", () => {
    expect(OrganizationForm.safeParse(valid).success).toBe(true);
  });

  it.each([
    [{ namespace: "a" }, "namespace", "namespaceInvalid"],
    [{ namespace: "toolong7" }, "namespace", "namespaceInvalid"],
    [{ namespace: "ac-me" }, "namespace", "namespaceInvalid"],
    [{ slug: "Acme Robotics" }, "slug", "slugInvalid"],
    [{ name: "" }, "name", "orgNameRequired"],
    [{ workspaceSlug: "billing" }, "workspaceSlug", "workspaceSlugReserved"],
    [{ workspaceSlug: "-core" }, "workspaceSlug", "workspaceSlugInvalid"],
  ])("refuses %j", (patch, field, key) => {
    const r = OrganizationForm.safeParse({ ...valid, ...patch });
    expect(r.success).toBe(false);
    expect(r.error?.issues.find((i) => i.path[0] === field)?.message).toBe(key);
  });

  it("every form error key has catalog copy", () => {
    for (const key of [
      "orgNameRequired",
      "orgNameTooLong",
      "slugInvalid",
      "namespaceInvalid",
      "workspaceNameRequired",
      "workspaceNameTooLong",
      "workspaceSlugInvalid",
      "workspaceSlugReserved",
      "slugTaken",
      "namespaceTaken",
      "agentSlugInvalid",
    ]) {
      expect(onboardingMessages.onboarding.errors).toHaveProperty(key);
    }
  });
});
