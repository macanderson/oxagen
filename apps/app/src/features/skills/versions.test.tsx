// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import messages from "../../../messages/skills.json";
import { configuration } from "./console.builders";
const { proposeSkillConfig, publishSkillConfig, importSkillConfig, refresh } =
  vi.hoisted(() => ({
    proposeSkillConfig: vi.fn(),
    publishSkillConfig: vi.fn(),
    importSkillConfig: vi.fn(),
    refresh: vi.fn(),
  }));
vi.mock("./actions", () => ({
  proposeSkillConfig,
  publishSkillConfig,
  importSkillConfig,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh }),
}));
const { SkillVersions } = await import("./versions");
const mount = (canEdit = true, model = configuration) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <SkillVersions
        at={{ org: "acme", ws: "core" }}
        configuration={model}
        canEdit={canEdit}
      />
    </NextIntlClientProvider>,
  );
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe("skill configuration versions", () => {
  it("proposes exact draft bytes without claiming publication, then publishes the merged PR", async () => {
    proposeSkillConfig.mockResolvedValue({
      ok: true,
      value: {
        pullRequest: {
          number: 81,
          url: "https://github.com/acme/core/pull/81",
        },
        published: null,
      },
    });
    publishSkillConfig.mockResolvedValue({
      ok: true,
      value: {
        pullRequest: null,
        published: { ...configuration.current, version: "skl_v2" },
      },
    });
    const user = userEvent.setup();
    const { container } = mount();
    await user.clear(screen.getByLabelText("Proposed TOML"));
    await user.type(screen.getByLabelText("Proposed TOML"), "enabled = true\n");
    await user.click(
      screen.getByRole("button", { name: "Open configuration PR" }),
    );
    expect(
      await screen.findByRole("link", { name: "Review pull request #81" }),
    ).toHaveAttribute("href", "https://github.com/acme/core/pull/81");
    expect(proposeSkillConfig).toHaveBeenCalledWith(
      "acme",
      "core",
      "enabled = true\n",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "published version has not changed",
    );
    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Merged pull request number")).toHaveValue(
      "81",
    );
    await user.click(
      screen.getByRole("button", { name: "Publish merged configuration" }),
    );
    await screen.findByText("Published skl_v2.");
    expect(publishSkillConfig).toHaveBeenCalledWith("acme", "core", 81);
    expect(refresh).toHaveBeenCalledOnce();
    await expectNoAxe(container);
  });
  it("holds the draft during a pending write and after a refusal", async () => {
    let finish: ((value: unknown) => void) | undefined;
    proposeSkillConfig.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const user = userEvent.setup();
    mount();
    await user.click(
      screen.getByRole("button", { name: "Open configuration PR" }),
    );
    expect(screen.getByLabelText("Proposed TOML")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working" })).toBeDisabled();
    finish?.({ ok: false, reason: "denied", code: "forbidden" });
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Proposed TOML")).toHaveValue(
      configuration.draftText,
    );
    expect(
      await screen.findByRole("button", { name: "Open configuration PR" }),
    ).toBeEnabled();
    expect(refresh).not.toHaveBeenCalled();
  });
  it("offers an off workspace an explicit import and keeps non-admin controls read-only", async () => {
    importSkillConfig.mockResolvedValue({
      ok: true,
      value: { pullRequest: null, published: configuration.current },
    });
    const user = userEvent.setup();
    const view = mount(true, { ...configuration, current: null, versions: [] });
    await user.click(
      screen.getByRole("button", { name: "Import repository configuration" }),
    );
    await waitFor(() => {
      expect(importSkillConfig).toHaveBeenCalledWith("acme", "core");
    });
    view.unmount();
    mount(false);
    expect(screen.getByLabelText("Proposed TOML")).toHaveAttribute("readonly");
    expect(
      screen.getByRole("button", { name: "Open configuration PR" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Publish merged configuration" }),
    ).toBeDisabled();
  });
});

it("keeps the merged-PR input after an unmerged refusal and never refreshes", async () => {
  publishSkillConfig.mockResolvedValue({
    ok: false,
    reason: "conflict",
    code: "skill_config_not_merged",
  });
  const user = userEvent.setup();
  mount();
  await user.type(screen.getByLabelText("Merged pull request number"), "42");
  await user.click(
    screen.getByRole("button", { name: "Publish merged configuration" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Merge it there, then publish again",
  );
  expect(screen.getByLabelText("Merged pull request number")).toHaveValue("42");
  expect(screen.getByLabelText("Proposed TOML")).toHaveValue(
    configuration.draftText,
  );
  // The refusal is set inside the transition, so the alert can paint while
  // `pending` is still true and the submit button still disabled; `pending`
  // clears on a later commit. Awaiting the alert alone raced that commit and
  // failed under CI load.
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Publish merged configuration" }),
    ).toBeEnabled(),
  );
  expect(refresh).not.toHaveBeenCalled();
});
