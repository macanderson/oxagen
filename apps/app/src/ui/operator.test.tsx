// @vitest-environment jsdom
// An operator, named (operator.tsx): the label is the person's name, a
// principal with no name reads by its kind, and the id only ever appears
// inside the hover card, never as the label. The card exists only when there
// is something to put in it, and only while the pointer or focus is on the
// name, or on the card after a short wait for the pointer to cross to it.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  CLOSE_DELAY_MS,
  type OperatorIdentity,
  OperatorName,
} from "./operator";

afterEach(cleanup);

function renderOperator(
  operator: OperatorIdentity,
  props: { children?: string; className?: string; testId?: string } = {},
) {
  return render(
    <IntlProvider>
      <OperatorName operator={operator} {...props} />
    </IntlProvider>,
  );
}

/** The focusable label span inside the operator. */
function labelOf(root: HTMLElement): HTMLElement {
  const label = root.firstElementChild;
  if (!(label instanceof HTMLElement)) throw new Error("the label is drawn");
  return label;
}

const marcus: OperatorIdentity = {
  id: "prn_marcusbell",
  name: "Marcus Bell",
  kind: "human",
  email: "marcus@acme.test",
  avatarUrl: "https://avatars.acme.test/marcus.png",
  role: "Admin",
};

describe("OperatorName label", () => {
  it("reads a named operator by name, keeping the id off the label", () => {
    renderOperator(marcus);
    const root = screen.getByTestId("operator");
    expect(root).toHaveTextContent(/^Marcus Bell$/);
    expect(root).toHaveAttribute("data-operator-id", "prn_marcusbell");
    expect(labelOf(root)).toHaveAttribute("tabindex", "0");
    expect(screen.queryByTestId("operator-card")).toBeNull();
  });

  it.each<[NonNullable<OperatorIdentity["kind"]>, string]>([
    ["agent", "Agent"],
    ["service", "Service"],
    ["human", "Unnamed operator"],
  ])("reads an unnamed %s principal as %s", (kind, word) => {
    renderOperator({ id: null, name: null, kind });
    expect(screen.getByTestId("operator")).toHaveTextContent(
      new RegExp(`^${word}$`),
    );
  });

  it.each<[string, OperatorIdentity]>([
    ["no kind", { id: null, name: null }],
    ["a null kind", { id: null, name: null, kind: null }],
  ])("reads a principal with %s as Operator (negative)", (_, operator) => {
    renderOperator(operator);
    expect(screen.getByTestId("operator")).toHaveTextContent(/^Operator$/);
  });

  it("draws the caller's own label, test id and class instead of the defaults", () => {
    renderOperator(marcus, {
      children: "the release owner",
      className: "text-xs",
      testId: "run-operator",
    });
    const root = screen.getByTestId("run-operator");
    expect(root).toHaveTextContent(/^the release owner$/);
    expect(root.className).toContain("text-xs");
    expect(screen.queryByTestId("operator")).toBeNull();
  });
});

describe("OperatorName card", () => {
  it("opens on hover with the name, email, role, id and avatar, and closes on leave", async () => {
    const { container } = renderOperator(marcus);
    const root = screen.getByTestId("operator");
    await userEvent.hover(root);
    const card = screen.getByTestId("operator-card");
    expect(card).toHaveTextContent("Marcus Bell");
    expect(card).toHaveTextContent("marcus@acme.test");
    expect(card).toHaveTextContent("Admin");
    expect(card).toHaveTextContent("prn_marcusbell");
    expect(card.querySelector("[data-avatar]")).toHaveAttribute(
      "data-avatar",
      "image",
    );
    await expectNoAxe(container);
    await userEvent.unhover(root);
    await waitFor(() => {
      expect(screen.queryByTestId("operator-card")).toBeNull();
    });
  });

  it("stays open while the pointer crosses from the name to the card, and closes once it leaves the card (#4674)", () => {
    vi.useFakeTimers();
    try {
      renderOperator(marcus);
      const root = screen.getByTestId("operator");
      fireEvent.mouseEnter(root);
      fireEvent.mouseLeave(root);
      // The pointer is in the gap between the name and the card.
      expect(screen.getByTestId("operator-card")).toBeInTheDocument();
      fireEvent.mouseEnter(screen.getByTestId("operator-card"));
      act(() => {
        vi.advanceTimersByTime(CLOSE_DELAY_MS * 2);
      });
      expect(screen.getByTestId("operator-card")).toBeInTheDocument();
      fireEvent.mouseLeave(screen.getByTestId("operator-card"));
      act(() => {
        vi.advanceTimersByTime(CLOSE_DELAY_MS - 1);
      });
      expect(screen.getByTestId("operator-card")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.queryByTestId("operator-card")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a pending close when the name unmounts", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = renderOperator(marcus);
      const root = screen.getByTestId("operator");
      fireEvent.mouseEnter(root);
      const before = vi.getTimerCount();
      fireEvent.mouseLeave(root);
      expect(vi.getTimerCount()).toBe(before + 1);
      unmount();
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens on keyboard focus and stays open while focus moves within it", async () => {
    renderOperator(marcus);
    const root = screen.getByTestId("operator");
    await userEvent.tab();
    expect(labelOf(root)).toHaveFocus();
    const card = screen.getByTestId("operator-card");
    fireEvent.focusOut(labelOf(root), { relatedTarget: card });
    expect(screen.getByTestId("operator-card")).toBeInTheDocument();
    fireEvent.focusOut(labelOf(root), { relatedTarget: null });
    expect(screen.queryByTestId("operator-card")).toBeNull();
  });

  it("says there is no role, shows no email, and draws the kind's initials for an unnamed person", async () => {
    renderOperator({ id: "prn_ghost", name: null, kind: "human" });
    await userEvent.hover(screen.getByTestId("operator"));
    const card = screen.getByTestId("operator-card");
    expect(card).toHaveTextContent("No role in this scope");
    expect(card).toHaveTextContent("prn_ghost");
    expect(card).not.toHaveTextContent("@");
    const avatar = card.querySelector("[data-avatar]");
    expect(avatar).toHaveAttribute("data-avatar", "initials");
    expect(avatar).toHaveTextContent(/^UO$/);
  });

  it("draws a question mark when the name holds no letters to take", async () => {
    renderOperator({ id: "prn_blank", name: "   " });
    await userEvent.hover(screen.getByTestId("operator"));
    expect(
      screen.getByTestId("operator-card").querySelector("[data-avatar]"),
    ).toHaveTextContent(/^\?$/);
  });

  it.each<[string, Partial<OperatorIdentity>]>([
    ["an email", { email: "ops@acme.test" }],
    ["a role", { role: "Viewer" }],
    ["an avatar", { avatarUrl: "https://avatars.acme.test/ops.png" }],
  ])(
    "opens a card with no id row for a principal that has only %s",
    async (_, extra) => {
      renderOperator({ id: null, name: "Ops", ...extra });
      const root = screen.getByTestId("operator");
      expect(root).not.toHaveAttribute("data-operator-id");
      await userEvent.hover(root);
      const card = screen.getByTestId("operator-card");
      expect(card).not.toHaveTextContent("Id");
    },
  );

  it("offers no card and no tab stop when there is nothing to put in one (negative)", async () => {
    renderOperator({
      id: null,
      name: null,
      kind: "agent",
      email: null,
      role: null,
      avatarUrl: null,
    });
    const root = screen.getByTestId("operator");
    expect(labelOf(root)).not.toHaveAttribute("tabindex");
    await userEvent.hover(root);
    expect(screen.queryByTestId("operator-card")).toBeNull();
  });
});
