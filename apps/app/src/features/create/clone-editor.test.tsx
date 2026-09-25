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
const agentDraft = {
  ...draft,
  kind: "agent",
  sourceId: "triage",
  slug: "triage-cloned",
  name: "Triage cloned",
};
const recordDraft = {
  ...draft,
  kind: "record",
  sourceId: "ctx.core.review",
  slug: "ctx.core.review-cloned",
  name: "Review-cloned",
};
const mount = (
  kind: "skill" | "agent" | "record" = "skill",
  onClose = vi.fn(),
) =>
  render(
    <IntlProvider>
      <CloneEditor
        org="acme"
        ws="core"
        kind={kind}
        sourceRef={kind === "skill" ? "review" : "triage"}
        onClose={onClose}
      />
    </IntlProvider>,
  );
const submit = () =>
  fireEvent.click(screen.getByRole("button", { name: "Propose clone" }));
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
      "already holds this slug or name",
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
  it("reports an unreadable source when the read throws", async () => {
    actions.readCloneDraft.mockRejectedValueOnce(new Error("network down"));
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be read",
    );
    expect(screen.queryByLabelText("Configuration source")).toBeNull();
  });
  it("reports an unreadable source when the read is refused without a denial", async () => {
    actions.readCloneDraft.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
      code: "repository_unbound",
    });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "checking the repository binding",
    );
  });
  it("edits an agent clone's display name apart from its identifier", async () => {
    actions.readCloneDraft.mockResolvedValue({ ok: true, value: agentDraft });
    actions.proposeClone.mockResolvedValue({
      ok: true,
      value: { slug: "triage-fork", proposalId: "prop_1", pullRequest: null },
    });
    mount("agent");
    const name = await screen.findByLabelText("Display name");
    // An agent keeps the two apart: the identifier is the record's slug and the
    // name is what a person reads. A skill has one field, and editing its
    // identifier carries the name with it.
    fireEvent.change(screen.getByLabelText("Source identifier"), {
      target: { value: "triage-fork" },
    });
    fireEvent.change(name, { target: { value: "Triage fork" } });
    submit();
    expect(
      await screen.findByRole("link", { name: "Review proposal" }),
    ).toBeInTheDocument();
    expect(actions.proposeClone).toHaveBeenCalledWith("acme", "core", {
      ...agentDraft,
      slug: "triage-fork",
      name: "Triage fork",
    });
  });
  it("names a record clone by its label and caps it at 36 characters (ADR-173)", async () => {
    actions.readCloneDraft.mockResolvedValue({ ok: true, value: recordDraft });
    mount("record");
    const label = await screen.findByLabelText<HTMLInputElement>("Label");
    expect(label).toHaveValue("Review-cloned");
    expect(label.maxLength).toBe(36);
    expect(screen.queryByLabelText("Display name")).toBeNull();
  });
  it("refuses to link a pull request url it cannot read", async () => {
    actions.proposeClone.mockResolvedValue({
      ok: true,
      value: {
        slug: "review-cloned",
        proposalId: null,
        pullRequest: {
          number: 12,
          url: "https://example.com/acme/repo/pull/12",
        },
      },
    });
    mount();
    await screen.findByLabelText("Configuration source");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be read",
    );
    expect(
      screen.queryByRole("link", { name: "Review pull request" }),
    ).toBeNull();
  });
  it("reports an unavailable clone when the write throws", async () => {
    actions.proposeClone.mockRejectedValue(new Error("offline"));
    mount();
    await screen.findByLabelText("Configuration source");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not be read",
    );
    expect(screen.getByRole("button", { name: "Propose clone" })).toBeEnabled();
  });
  it("tells a denial, a changed source and a plain refusal apart", async () => {
    actions.proposeClone
      .mockResolvedValueOnce({
        ok: false,
        reason: "denied",
        code: "authz_denied",
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: "conflict",
        code: "clone_source_changed",
      })
      .mockResolvedValueOnce({ ok: false, reason: "invalid" });
    mount();
    await screen.findByLabelText("Configuration source");
    submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Owner or Admin",
    );
    submit();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "changed after this draft opened",
      );
    });
    submit();
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "did not pass validation",
      );
    });
  });
  it("counts the companion files the source carries", async () => {
    actions.readCloneDraft.mockResolvedValue({
      ok: true,
      value: {
        ...draft,
        files: [
          { path: "reference.md", text: "a" },
          { path: "rubric.md", text: "b" },
        ],
      },
    });
    mount();
    expect(
      await screen.findByText("Includes 2 companion files from the source."),
    ).toBeInTheDocument();
  });
  it("holds the submit while a required field is blank", async () => {
    mount();
    const source = await screen.findByLabelText("Configuration source");
    fireEvent.change(source, { target: { value: "   " } });
    expect(
      screen.getByRole("button", { name: "Propose clone" }),
    ).toBeDisabled();
    fireEvent.change(source, { target: { value: "enabled = true" } });
    fireEvent.change(screen.getByLabelText("Source identifier"), {
      target: { value: "" },
    });
    expect(
      screen.getByRole("button", { name: "Propose clone" }),
    ).toBeDisabled();
  });
  it("closes on dismissal and stays open through a pending write", async () => {
    const closeAfterRead = vi.fn();
    const view = mount("skill", closeAfterRead);
    await screen.findByLabelText("Configuration source");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(closeAfterRead).toHaveBeenCalledOnce();
    });
    view.unmount();
    let finish: (value: unknown) => void = () => {};
    actions.proposeClone.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const closeDuringWrite = vi.fn();
    mount("skill", closeDuringWrite);
    const source = await screen.findByLabelText("Configuration source");
    submit();
    await waitFor(() => {
      expect(source).toBeDisabled();
    });
    // A dismissal during the write is ignored, and a second submit is refused
    // by the guard rather than by the disabled button alone.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    const form = source.closest("form");
    if (!form) {
      throw new Error("Expected the source field to be inside a form");
    }

    fireEvent.submit(form);
    expect(closeDuringWrite).not.toHaveBeenCalled();
    expect(actions.proposeClone).toHaveBeenCalledTimes(1);
    finish({
      ok: true,
      value: { slug: "review-cloned", proposalId: "prop_2", pullRequest: null },
    });
    await screen.findByRole("link", { name: "Review proposal" });
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
