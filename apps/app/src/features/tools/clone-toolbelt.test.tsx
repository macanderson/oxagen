// @vitest-environment jsdom
// Clone a toolbelt (ADR-198): the slug fills from the name until the person
// types one, the write carries what the dialog shows, a new belt opens below
// the list, and a taken slug is named on its field. axe checks the state each
// test ends in (INV-26).
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const actions = vi.hoisted(() => ({
  cloneToolbelt: vi.fn(),
  updateToolbelt: vi.fn(),
  deleteToolbelt: vi.fn(),
  setToolState: vi.fn(),
}));
vi.mock("./actions", () => actions);

const { CloneToolbelt } = await import("./clone-toolbelt");

const at = { org: "acme", ws: "core-platform" };

async function openDialog() {
  render(
    <IntlProvider>
      <CloneToolbelt
        at={at}
        source={{ id: "tbt_alltools", name: "All tools" }}
        label="New toolbelt"
        gold
        testId="tools-belt-new"
      />
    </IntlProvider>,
  );
  fireEvent.click(screen.getByTestId("tools-belt-new"));
  return within(await screen.findByTestId("tools-belt-new-dialog"));
}

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockReset();
  for (const fn of Object.values(router)) fn.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("CloneToolbelt", () => {
  it("fills the slug from the name, dropping apostrophes and special characters", async () => {
    const dialog = await openDialog();
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "Mac's R&D belt" },
    });
    expect(dialog.getByLabelText("Slug")).toHaveValue("macs-rd-belt");
  });

  it("stops following the name once the slug is typed by hand", async () => {
    const dialog = await openDialog();
    fireEvent.change(dialog.getByLabelText("Slug"), {
      target: { value: "review" },
    });
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "Review belt" },
    });
    expect(dialog.getByLabelText("Slug")).toHaveValue("review");
  });

  it("clones the source with what the dialog shows and opens the new belt", async () => {
    actions.cloneToolbelt.mockResolvedValue({
      ok: true,
      value: { id: "tbt_reviewbelt", name: "Review belt", slug: "review-belt" },
    });
    const dialog = await openDialog();
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "Review belt" },
    });
    fireEvent.change(dialog.getByLabelText("Description"), {
      target: { value: "What a reviewer needs" },
    });
    fireEvent.click(dialog.getByTestId("tools-belt-new-submit"));
    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith(
        "/acme/core-platform/tools/toolbelts?belt=tbt_reviewbelt",
      );
    });
    expect(actions.cloneToolbelt).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      {
        toolbeltId: "tbt_alltools",
        name: "Review belt",
        slug: "review-belt",
        description: "What a reviewer needs",
      },
    );
  });

  it("asks for a name and a well-formed slug before writing", async () => {
    const dialog = await openDialog();
    fireEvent.change(dialog.getByLabelText("Slug"), {
      target: { value: "Review Belt" },
    });
    fireEvent.click(dialog.getByTestId("tools-belt-new-submit"));
    expect(await dialog.findByText("Name the toolbelt.")).toBeVisible();
    expect(
      dialog.getByText(
        "Use lowercase letters and digits joined by single hyphens.",
      ),
    ).toBeVisible();
    expect(actions.cloneToolbelt).not.toHaveBeenCalled();
  });

  it("names a taken slug on the slug field", async () => {
    actions.cloneToolbelt.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "toolbelt_slug_taken",
    });
    const dialog = await openDialog();
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "Review belt" },
    });
    fireEvent.click(dialog.getByTestId("tools-belt-new-submit"));
    expect(
      await dialog.findByText(
        "Another toolbelt in this workspace uses this slug. Choose another.",
      ),
    ).toBeVisible();
    expect(router.push).not.toHaveBeenCalled();
  });

  it("says why any other refusal changed nothing", async () => {
    actions.cloneToolbelt.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    const dialog = await openDialog();
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "Review belt" },
    });
    fireEvent.click(dialog.getByTestId("tools-belt-new-submit"));
    expect(
      await dialog.findByTestId("tools-belt-new-failure"),
    ).toHaveTextContent(
      "This needs an organization Owner or Admin. Nothing was changed.",
    );
  });

  it("says the write went unanswered when the action throws", async () => {
    actions.cloneToolbelt.mockRejectedValue(new Error("network"));
    const dialog = await openDialog();
    fireEvent.change(dialog.getByLabelText("Name"), {
      target: { value: "Review belt" },
    });
    fireEvent.click(dialog.getByTestId("tools-belt-new-submit"));
    expect(
      await dialog.findByTestId("tools-belt-new-failure"),
    ).toHaveTextContent("Could not be recorded (action_failed).");
  });
});
