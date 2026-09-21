// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntlProvider } from "@/test/intl";
import { expectNoAxe } from "@/test/expect-no-axe";
const actions = vi.hoisted(() => ({
  readCloneDraft: vi.fn(),
  proposeClone: vi.fn(),
}));
vi.mock("./clone-actions", () => actions);
import { CloneEditor } from "./clone-editor";
const draft = {
  kind: "skill",
  sourceId: "review",
  sourceDigest: `sha256:${"a".repeat(64)}`,
  slug: "review-cloned",
  name: "review-cloned",
  source: "source text",
  files: [],
  harness: null,
};
const mount = () =>
  render(
    <IntlProvider>
      <CloneEditor
        org="acme"
        ws="core"
        kind="skill"
        sourceRef="review"
        onClose={vi.fn()}
      />
    </IntlProvider>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  actions.readCloneDraft.mockResolvedValue({ ok: true, value: draft });
});
afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});
describe("configuration clone editor", () => {
  it("prefills an editable clone and keeps edits after a refused proposal", async () => {
    actions.proposeClone.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "clone_name_taken",
    });
    mount();
    const source = await screen.findByLabelText("Configuration source");
    fireEvent.change(source, { target: { value: "edited configuration" } });
    fireEvent.change(screen.getByLabelText("Source identifier"), {
      target: { value: "review-cloned-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Propose clone" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already occupied",
    );
    expect(source).toHaveValue("edited configuration");
    expect(actions.proposeClone).toHaveBeenCalledWith("acme", "core", {
      ...draft,
      slug: "review-cloned-1",
      name: "review-cloned-1",
      source: "edited configuration",
    });
  });
  it("holds controls during a pending write and shows the proposal without retiring the source", async () => {
    let finish: (value: unknown) => void = () => {};
    actions.proposeClone.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    const source = await screen.findByLabelText("Configuration source");
    fireEvent.click(screen.getByRole("button", { name: "Propose clone" }));
    await waitFor(() => {
      expect(source).toBeDisabled();
    });
    expect(screen.getByRole("button", { name: "Submitting…" })).toBeDisabled();
    finish({
      ok: true,
      value: {
        slug: "review-cloned",
        proposalId: null,
        pullRequest: {
          number: 12,
          url: "https://github.com/acme/repo/pull/12",
        },
      },
    });
    expect(
      await screen.findByRole("link", { name: "Review pull request" }),
    ).toHaveAttribute("href", "https://github.com/acme/repo/pull/12");
    expect(actions.proposeClone).toHaveBeenCalledTimes(1);
  });
  it("offers a retry after a denied read without exposing an editor", async () => {
    actions.readCloneDraft.mockResolvedValueOnce({
      ok: false,
      reason: "denied",
      code: "authz_denied",
    });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Owner or Admin",
    );
    expect(screen.queryByLabelText("Configuration source")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Configuration source")).toHaveValue(
      "source text",
    );
  });
});
