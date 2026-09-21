// @vitest-environment jsdom
// The freshness panel: what it reports, who may change the two gates, and
// what a refused write leaves on screen. The last one is the point of the
// file — a checkbox that looks set and is not would tell an operator their
// workspace is protected when it is not.
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { steeringFreshness } from "@/test/steering-views";

const { setSteeringGate } = vi.hoisted(() => ({ setSteeringGate: vi.fn() }));
vi.mock("./actions", () => ({ setSteeringGate }));

const { Freshness } = await import("./freshness");

const AT = { org: "acme", ws: "core-platform" };

function show(
  read = steeringFreshness(),
  canEdit = true,
): { user: ReturnType<typeof userEvent.setup> } {
  const user = userEvent.setup();
  render(
    <IntlProvider>
      <Freshness at={AT} read={read} canEdit={canEdit} />
    </IntlProvider>,
  );
  return { user };
}

function box(gate: "autoSync" | "blockStaleRuns"): HTMLInputElement {
  // `data-gate` rather than a label lookup: the two hints are long, and a
  // name match would break every time the copy is reworded.
  const found = document.querySelector(`[data-gate="${gate}"]`);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`no checkbox for gate ${gate}`);
  }
  return found;
}

afterEach(async () => {
  setSteeringGate.mockReset();
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("what it reports", () => {
  it("prints the steering version, the repository and the newest record", () => {
    show();
    const panel = screen.getByRole("region", { name: "Steering freshness" });
    expect(panel).toHaveTextContent("12");
    expect(panel).toHaveTextContent("acme/platform");
    expect(panel).toHaveTextContent("main");
    // The commit is abbreviated, the way git prints it.
    expect(panel).toHaveTextContent("9a41c0e");
  });

  it("shows both gates, unchecked, when the workspace has set neither", () => {
    show();
    expect(box("autoSync").checked).toBe(false);
    expect(box("blockStaleRuns").checked).toBe(false);
  });

  it("shows a gate the workspace turned on", () => {
    show(
      steeringFreshness({ gates: { autoSync: false, blockStaleRuns: true } }),
    );
    expect(box("blockStaleRuns").checked).toBe(true);
  });
});

describe("who may change them", () => {
  // Shown and disabled, not hidden: a person looking for the switches should
  // find them, and find out why they cannot be used yet.
  it("disables both gates when no repository is bound, and says so", () => {
    show(
      steeringFreshness({
        repository: null,
        defaultBranch: null,
        headCommit: null,
        publishedAt: null,
      }),
    );
    expect(box("autoSync")).toBeDisabled();
    expect(box("blockStaleRuns")).toBeDisabled();
    expect(
      screen.getByRole("region", { name: "Steering freshness" }),
    ).toHaveTextContent("No repository is bound");
  });

  it("disables both gates for a viewer who could not write them", () => {
    show(steeringFreshness(), false);
    expect(box("autoSync")).toBeDisabled();
    expect(box("blockStaleRuns")).toBeDisabled();
  });
});

describe("changing a gate", () => {
  it("writes one gate, not both, so two editors cannot overwrite each other", async () => {
    setSteeringGate.mockResolvedValue({
      ok: true,
      value: { autoSync: false, blockStaleRuns: true },
    });
    const { user } = show();
    await user.click(box("blockStaleRuns"));
    await waitFor(() => {
      expect(setSteeringGate).toHaveBeenCalledWith(
        "acme",
        "core-platform",
        "blockStaleRuns",
        true,
      );
    });
    expect(setSteeringGate).toHaveBeenCalledTimes(1);
    expect(box("blockStaleRuns").checked).toBe(true);
  });

  it("takes the value the write returned, not the one it sent", async () => {
    setSteeringGate.mockResolvedValue({
      ok: true,
      value: { autoSync: true, blockStaleRuns: true },
    });
    const { user } = show();
    await user.click(box("blockStaleRuns"));
    // Auto-sync was on in the stored policy all along; the panel now agrees.
    await waitFor(() => {
      expect(box("autoSync").checked).toBe(true);
    });
  });

  it("puts the checkbox back and names the refusal", async () => {
    setSteeringGate.mockResolvedValue({
      ok: false,
      reason: "denied",
      permission: "workspace.settings.write",
    });
    const { user } = show();
    await user.click(box("blockStaleRuns"));
    await waitFor(() => {
      expect(box("blockStaleRuns").checked).toBe(false);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("puts the checkbox back when the write never answered", async () => {
    setSteeringGate.mockRejectedValue(new Error("network"));
    const { user } = show();
    await user.click(box("autoSync"));
    await waitFor(() => {
      expect(box("autoSync").checked).toBe(false);
    });
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
