// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider, translator } from "@/test/intl";
import { SourceFilename } from "./source-filename";

const t = translator("ui.sourceFilename");
const pathOf = (name: string) => `.oxagen/agents/${name}.toml`;

function mount(disabled = false) {
  const rename = vi.fn((name: string) => /^[a-z]+(?:-[a-z]+)*$/.test(name));
  const submit = vi.fn();
  function Host() {
    const [name, setName] = useState("release-bot");
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <SourceFilename
          path={pathOf(name)}
          name={name}
          disabled={disabled}
          onRename={(value) => {
            if (!rename(value)) return false;
            setName(value);
            return true;
          }}
        />
        <button type="button">Next field</button>
      </form>
    );
  }
  render(
    <IntlProvider>
      <Host />
    </IntlProvider>,
  );
  return { rename, submit, user: userEvent.setup() };
}

const filename = (name = "release-bot") =>
  screen.getByRole("button", {
    name: t("rename", { path: pathOf(name) }),
  });
const input = () =>
  screen.getByRole<HTMLInputElement>("textbox", { name: t("name") });

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("SourceFilename", () => {
  it("opens from the full path, selects the name, and commits Enter without submitting its form", async () => {
    const { user, rename, submit } = mount();
    await user.click(screen.getByText(pathOf("release-bot")));
    expect(input()).toHaveFocus();
    expect(input().selectionStart).toBe(0);
    expect(input().selectionEnd).toBe("release-bot".length);
    await user.keyboard("renamed-agent{Enter}");
    expect(rename).toHaveBeenCalledExactlyOnceWith("renamed-agent");
    expect(filename("renamed-agent")).toHaveFocus();
    expect(submit).not.toHaveBeenCalled();
  });

  it("commits blur and keeps focus on the next control", async () => {
    const { user, rename } = mount();
    await user.click(filename());
    await user.keyboard("release-check");
    await user.tab();
    expect(rename).toHaveBeenCalledExactlyOnceWith("release-check");
    expect(filename("release-check")).toBeVisible();
    expect(screen.getByRole("button", { name: "Next field" })).toHaveFocus();
  });

  it("cancels Escape without committing and returns focus to the filename", async () => {
    const { user, rename } = mount();
    await user.click(filename());
    await user.keyboard("discard-me{Escape}");
    expect(filename()).toHaveFocus();
    expect(rename).not.toHaveBeenCalled();
    await user.click(filename());
    expect(input()).toHaveValue("release-bot");
  });

  it("keeps invalid edits open and accepts a correction", async () => {
    const { user } = mount();
    await user.click(filename());
    await user.keyboard("../outside{Enter}");
    expect(input()).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(t("invalid"));
    await user.clear(input());
    await user.type(input(), "correct-name");
    await user.keyboard("{Enter}");
    expect(filename("correct-name")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("closes an unchanged edit without a write", async () => {
    const { user, rename } = mount();
    await user.click(filename());
    await user.keyboard("{Enter}");
    expect(rename).not.toHaveBeenCalled();
    expect(filename()).toHaveFocus();
  });

  it("does not open a disabled filename", async () => {
    const { user, rename } = mount(true);
    await user.click(filename());
    expect(filename()).toBeDisabled();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(rename).not.toHaveBeenCalled();
  });
});
