// @vitest-environment jsdom
// One open interjection in the approvals drawer (#3839): the branches the
// drawer's own tests do not reach, each checked with axe.
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import en from "../../../messages/en.json";
import shellMessages from "../../../messages/shell.json";
import uiMessages from "../../../messages/ui.json";
import { countdown } from "./approvals-drawer";
import { InterjectionRow } from "./interjection-row";
import { interjectionItem, SHELL_NOW } from "./shell.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { href: string; children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function show(props: Partial<Parameters<typeof InterjectionRow>[0]> = {}) {
  render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ ...en, ...shellMessages, ...uiMessages }}
    >
      <ul>
        <InterjectionRow
          item={interjectionItem()}
          org="acme"
          ws="core-platform"
          wsName="Core platform"
          now={SHELL_NOW}
          countdown={countdown}
          agent="release-manager"
          harness={null}
          {...props}
        />
      </ul>
    </NextIntlClientProvider>,
  );
  return screen.getByTestId("interjection-row");
}

describe("InterjectionRow", () => {
  it("counts down to the question's expiry in the info ink", () => {
    const row = show();
    const clock = row.querySelector("[data-countdown]");
    expect(clock?.textContent).toBe("26:24");
    expect(clock).not.toHaveAttribute("data-warn");
  });

  it("takes the warning tone under two minutes", () => {
    const row = show({
      item: interjectionItem({
        expiresAt: new Date(SHELL_NOW + 90_000).toISOString(),
      }),
    });
    expect(row.querySelector("[data-countdown]")).toHaveAttribute(
      "data-warn",
      "",
    );
  });

  it("says expired once the run has stopped waiting (negative)", () => {
    const row = show({
      item: interjectionItem({
        expiresAt: new Date(SHELL_NOW - 1_000).toISOString(),
      }),
    });
    expect(row.querySelector("[data-countdown]")?.textContent).toBe("expired");
  });

  it("names no agent when the writer recorded none (negative)", () => {
    const row = show({ agent: null });
    expect(row).toHaveTextContent("An agent is paused");
    // No agent, no avatar: the speech mark stays (#4871).
    expect(row.querySelector("[data-agent-avatar]")).toBeNull();
  });

  // #4871: the agent that paused wears the harness it registered.
  it("leads with the agent's avatar and its registered harness", () => {
    const row = show({ harness: "claude-code" });
    expect(row.querySelector("[data-avatar]")).toHaveTextContent("RE");
    expect(row.querySelector("[data-harness-badge]")).toHaveAttribute(
      "data-harness-badge",
      "claude-code",
    );
  });

  it("draws the agent's avatar with no badge when its harness is not known (negative)", () => {
    const row = show({ harness: null });
    expect(row.querySelector("[data-agent-avatar]")).not.toBeNull();
    expect(row.querySelector("[data-harness-badge]")).toBeNull();
  });
});
