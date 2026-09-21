// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import messages from "../../../messages/skills.json";
import { configuration } from "./console.builders";
const { previewSkillSearch } = vi.hoisted(() => ({
  previewSkillSearch: vi.fn(),
}));
vi.mock("./actions", () => ({ previewSkillSearch }));
const { SkillSearch } = await import("./search");
const mount = (model = configuration) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SkillSearch at={{ org: "acme", ws: "core" }} configuration={model} />
    </NextIntlClientProvider>,
  );
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("skill search preview", () => {
  it("pins the selected version and displays approved and held evidence", async () => {
    previewSkillSearch.mockResolvedValue({
      ok: true,
      value: {
        version: "skl_v1",
        repositoryCommitSha: "abcdef0123456789",
        tokenCost: 40,
        results: [
          {
            skillRef: "review",
            version: "1.0.0",
            digest: "sha256:a",
            source: "workspace",
            description: "Review changes",
            tokenCost: 40,
            score: 0.9,
          },
        ],
        withheld: [{ skillRef: "secret", reason: "unapproved_digest" }],
      },
    });
    const user = userEvent.setup();
    const { container } = mount();
    await user.type(screen.getByLabelText("Search query"), "review changes");
    await user.click(screen.getByRole("button", { name: "Preview search" }));
    expect(await screen.findByText("review@1.0.0")).toBeTruthy();
    // A withheld row is its slug and its reason. It carries no version,
    // because the contract sends none: asserting `secret@2.0.0` here passed
    // only while the fixture invented a field the handler never returns.
    expect(screen.getByText("secret")).toBeTruthy();
    expect(
      screen.getByText("Content differs from the approved digest"),
    ).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent("abcdef012345");
    expect(previewSkillSearch).toHaveBeenCalledWith(
      "acme",
      "core",
      "skl_v1",
      "review changes",
    );
    await expectNoAxe(container);
    await user.type(screen.getByLabelText("Search query"), " again");
    expect(screen.queryByText("review@1.0.0")).toBeNull();
  });
  it.each(["denied", "pending_approval", "thrown"])(
    "retains the query after %s and permits retry",
    async (reason) => {
      if (reason === "thrown")
        previewSkillSearch.mockRejectedValueOnce(new Error("offline"));
      else
        previewSkillSearch.mockResolvedValueOnce(
          reason === "denied"
            ? { ok: false, reason, code: "forbidden" }
            : { ok: false, reason, accessRequestId: "acr_one" },
        );
      const user = userEvent.setup();
      mount();
      await user.type(screen.getByLabelText("Search query"), "review");
      await user.click(screen.getByRole("button", { name: "Preview search" }));
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.getByLabelText("Search query")).toHaveValue("review");
      previewSkillSearch.mockResolvedValue({
        ok: true,
        value: {
          version: "skl_v1",
          repositoryCommitSha: "abc",
          tokenCost: 0,
          results: [],
          withheld: [],
        },
      });
      await user.click(screen.getByRole("button", { name: "Preview search" }));
      expect(
        await screen.findByText(
          "No approved description matched within the score and token limits.",
        ),
      ).toBeTruthy();
      await waitFor(() => {
        expect(previewSkillSearch).toHaveBeenCalledTimes(2);
      });
    },
  );
});

it("keeps one pending request pinned to an explicitly selected older version", async () => {
  let finish: ((value: unknown) => void) | undefined;
  previewSkillSearch.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const original = configuration.versions[0];
  if (!original) throw new Error("version fixture missing");
  const current = { ...original, id: "skv_456", version: "skl_v2" };
  const user = userEvent.setup();
  mount({ ...configuration, current, versions: [current, original] });
  await user.selectOptions(
    screen.getByLabelText("Configuration version"),
    "skl_v1",
  );
  await user.type(screen.getByLabelText("Search query"), "older");
  await user.click(screen.getByRole("button", { name: "Preview search" }));
  expect(screen.getByLabelText("Search query")).toBeDisabled();
  expect(screen.getByLabelText("Configuration version")).toBeDisabled();
  const pending = screen.getByRole("button", { name: "Searching" });
  expect(pending).toBeDisabled();
  await user.click(pending);
  expect(previewSkillSearch).toHaveBeenCalledExactlyOnceWith(
    "acme",
    "core",
    "skl_v1",
    "older",
  );
  finish?.({
    ok: true,
    value: {
      version: "skl_v1",
      repositoryCommitSha: "abc",
      tokenCost: 0,
      results: [],
      withheld: [],
    },
  });
  await screen.findByRole("status");
  expect(screen.getByLabelText("Configuration version")).toBeEnabled();
});
