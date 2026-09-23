// @vitest-environment jsdom
// The Steering header's own entry into a creation wizard (roadmap
// creation-spec §1): "Add a skill" on the Skills shelf opens the skill wizard
// over the page, and every other view's "Write a context record" opens the
// context-record wizard. A view whose body holds its own primary action takes
// the gold from the header (pages/steering.md, "One gold action").
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CREATE_EVENT } from "@/shared/create";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { SteeringCreate, tabHoldsPrimary } from "./create-action";
import { resolveSteeringRoute, type SteeringView } from "./view";

const AT = { org: "acme", ws: "core" };

function viewAt(segments: string[], query: Record<string, string> = {}) {
  const route = resolveSteeringRoute(
    AT,
    segments.length === 0 ? undefined : segments,
    query,
  );
  if (route.kind !== "view") throw new Error(`${segments.join("/")} moved`);
  return route.view;
}

function mount(view: SteeringView, primary?: boolean) {
  return render(
    <IntlProvider>
      <SteeringCreate view={view} primary={primary} />
    </IntlProvider>,
  );
}

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("SteeringCreate", () => {
  it("opens the skill wizard from the Skills shelf", () => {
    const heard = vi.fn();
    window.addEventListener(CREATE_EVENT, heard);
    try {
      mount(viewAt(["skills"]));
      fireEvent.click(screen.getByRole("button", { name: "Add a skill" }));
      expect(heard).toHaveBeenCalledTimes(1);
      const event: unknown = heard.mock.calls[0]?.[0];
      expect(event).toBeInstanceOf(CustomEvent);
      expect(event).toHaveProperty("detail", { kind: "skill" });
    } finally {
      window.removeEventListener(CREATE_EVENT, heard);
    }
  });

  it("opens the context-record wizard from every view but the Skills shelf", () => {
    const views = [
      viewAt([]),
      viewAt(["records"]),
      viewAt(["proposals"]),
      viewAt(["proposals", "prs"]),
    ];
    const heard = vi.fn();
    window.addEventListener(CREATE_EVENT, heard);
    try {
      for (const view of views) {
        const { container } = mount(view);
        expect(container.querySelectorAll("button")).toHaveLength(1);
        fireEvent.click(
          screen.getByRole("button", { name: "Write a context record" }),
        );
        cleanup();
      }
      expect(heard).toHaveBeenCalledTimes(views.length);
      for (const [event] of heard.mock.calls)
        expect(event).toHaveProperty("detail", { kind: "record" });
    } finally {
      window.removeEventListener(CREATE_EVENT, heard);
    }
  });

  it("offers no record button on the Skills shelf (negative)", () => {
    mount(viewAt(["skills"]));
    expect(
      screen.queryByRole("button", { name: "Write a context record" }),
    ).toBeNull();
  });

  it("draws the button secondary where the view's body holds the gold", () => {
    mount(viewAt([]), false);
    const button = screen.getByRole("button", {
      name: "Write a context record",
    });
    expect(button.className).not.toMatch(/button-primary/);
  });
});

describe("tabHoldsPrimary", () => {
  it("gives the gold to a selected Context PR whose checks passed", () => {
    const selected = viewAt(["proposals", "prs"], {
      proposal: "prp_01k5ru4a",
    });
    expect(tabHoldsPrimary(selected, true)).toBe(true);
    // Merge is secondary until the checks pass, so the header keeps the gold.
    expect(tabHoldsPrimary(selected, false)).toBe(false);
    expect(tabHoldsPrimary(viewAt(["proposals", "prs"]), true)).toBe(false);
  });

  it("gives the gold to the Skills shelf's Search and Versions views", () => {
    expect(tabHoldsPrimary(viewAt(["skills", "search"]), false)).toBe(true);
    expect(tabHoldsPrimary(viewAt(["skills", "versions"]), false)).toBe(true);
    expect(tabHoldsPrimary(viewAt(["skills"]), false)).toBe(false);
  });

  it("keeps the gold in the header on every other view (negative)", () => {
    for (const segments of [[], ["records"], ["gates"], ["compiler"]])
      expect(tabHoldsPrimary(viewAt(segments), true)).toBe(false);
  });
});
