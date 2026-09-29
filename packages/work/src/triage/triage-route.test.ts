import { describe, expect, it } from "vitest";
import type { Workflow } from "../types";
import { workflowFixture } from "./fixtures/triage-fixtures";
import { TriageRouteError, pinnedBuildRoutes, selectTriageRoute } from "./triage-route";

const ROUTES = ["triage-primary", "triage-second"];

function stages(...stage: Workflow["stage"]): Pick<Workflow, "stage"> {
  return { stage };
}

describe("pinnedBuildRoutes", () => {
  it("finds no build pin in the spec's v0.3 workflow, whose only model is on its verify stage", () => {
    expect([...pinnedBuildRoutes([workflowFixture("fix-test-verify-review")])]).toEqual([]);
  });

  it("reads a stage with no kind as a build stage", () => {
    const pinned = pinnedBuildRoutes([
      stages({ role: "Fix", agent: "aintel.core.bug-fixer", model: "triage-primary" }),
      stages(
        { role: "Build", kind: "build", agent: "aintel.core.builder", model: "build-route" },
        { role: "Review", kind: "review", agent: "aintel.core.architect", model: "review-route" },
      ),
    ]);
    expect([...pinned].sort()).toEqual(["build-route", "triage-primary"]);
  });
});

describe("selectTriageRoute", () => {
  it("takes the first route when no build stage pins it", () => {
    expect(selectTriageRoute(ROUTES, [workflowFixture("fix-test-verify-review")])).toBe("triage-primary");
  });

  it("takes the next route when a build stage pins the first", () => {
    const workflows = [stages({ role: "Fix", kind: "build", agent: "aintel.core.bug-fixer", model: "triage-primary" })];
    expect(selectTriageRoute(ROUTES, workflows)).toBe("triage-second");
  });

  it("ignores a pin on a stage that does not build", () => {
    const workflows = [stages({ role: "Verify", kind: "verify", agent: "aintel.core.verifier", model: "triage-primary" })];
    expect(selectTriageRoute(ROUTES, workflows)).toBe("triage-primary");
  });

  it("refuses when every route is pinned on a build stage", () => {
    const workflows = [
      stages(
        { role: "Fix", kind: "build", agent: "a", model: "triage-primary" },
        { role: "Fix again", agent: "b", model: "triage-second" },
      ),
    ];
    let error: unknown = null;
    try {
      selectTriageRoute(ROUTES, workflows);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TriageRouteError);
    const routeError = error as TriageRouteError;
    expect(routeError.name).toBe("TriageRouteError");
    expect(routeError.code).toBe("triage_route_pinned");
    expect(routeError.routes).toEqual(ROUTES);
    expect(routeError.pinned).toEqual(["triage-primary", "triage-second"]);
    expect(routeError.message).toBe(
      "Every triage model route (triage-primary, triage-second) is pinned on a build stage. Add a route to [triage] models that no build stage pins.",
    );
  });

  it("refuses when work.toml lists no route", () => {
    expect(() => selectTriageRoute([], [])).toThrow("work.toml lists no triage model route. Add one to [triage] models.");
  });
});
