// @vitest-environment jsdom
// The organization and workspace switchers over `shell.context`: each tile
// opens a dialog listing what the read returned with the current choice
// marked, and a denied or failed read renders its message in place of the list.
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { MouseEvent, ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Read, readError, readOk } from "@/data/read";
import type { ShellContext } from "@/data/contracts/shell";
import { expectNoAxe } from "@/test/expect-no-axe";
import en from "../../../messages/en.json";
import shellMessages from "../../../messages/shell.json";
import uiMessages from "../../../messages/ui.json";
import { shellData } from "./shell.builders";
import { OrgSwitcher, WorkspaceSwitcher } from "./switchers";

vi.mock("next/link", () => ({
  default: ({
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
    onClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
  }) => (
    <a
      {...rest}
      onClick={(e) => {
        e.preventDefault(); // jsdom cannot navigate documents
        onClick?.(e);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

afterEach(async () => {
  // INV-26: every test ends in a state of its section; axe checks it, portals included.
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

const listed = readOk({
  orgs: [
    { slug: "acme", name: "Acme Robotics" },
    { slug: "globex", name: "Globex" },
  ],
  workspaces: [
    { slug: "core-platform", name: "Core platform" },
    { slug: "finops", name: "FinOps" },
  ],
});

function renderSwitchers(context: Read<ShellContext>, ws: string | null) {
  const data = shellData({ context });
  return render(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={{ ...en, ...shellMessages, ...uiMessages }}
    >
      <OrgSwitcher data={data} />
      <WorkspaceSwitcher data={data} ws={ws} />
    </NextIntlClientProvider>,
  );
}

async function openDialog(name: string) {
  await userEvent.click(
    screen.getByRole("button", { name: new RegExp(`^${name}`) }),
  );
  return screen.findByRole("dialog", { name });
}

describe("organization switcher", () => {
  it("lists the organizations shell.context read, marks the current one and closes when one is chosen", async () => {
    renderSwitchers(listed, "core-platform");
    const tile = screen.getByRole("button", { name: /^Switch organization/ });
    expect(tile).toHaveTextContent("Acme Robotics");
    const dialog = await openDialog("Switch organization");
    const links = within(dialog).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/acme",
      "/globex",
    ]);
    expect(links[0]).toHaveAttribute("aria-current", "true");
    expect(links[0]).toHaveTextContent("current");
    expect(links[1]).not.toHaveAttribute("aria-current");
    await userEvent.click(within(dialog).getByRole("link", { name: /Globex/ }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});

describe("workspace switcher", () => {
  it("names the workspace from shell.context and lists the organization's workspaces, the current one marked", async () => {
    renderSwitchers(listed, "finops");
    const tile = screen.getByRole("button", { name: /^Switch workspace/ });
    expect(tile).toHaveTextContent("FinOps");
    const dialog = await openDialog("Switch workspace");
    const links = within(dialog).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/acme/core-platform",
      "/acme/finops",
    ]);
    expect(links[1]).toHaveAttribute("aria-current", "true");
    expect(links[0]).not.toHaveAttribute("aria-current");
  });

  it("renders nothing without a workspace (negative)", () => {
    renderSwitchers(listed, null);
    expect(
      screen.queryByRole("button", { name: /^Switch workspace/ }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: /^Switch organization/ }),
    ).toBeInTheDocument();
  });
});

describe("a shell.context read that did not list", () => {
  it("denied: each dialog says the viewer may not list these, and the tiles still name where the page is (negative)", async () => {
    renderSwitchers(
      { ok: false, reason: "denied", permission: "org.read" },
      "core-platform",
    );
    expect(
      screen.getByRole("button", { name: /^Switch workspace/ }),
    ).toHaveTextContent("core-platform");
    const org = await openDialog("Switch organization");
    expect(within(org).getByRole("status")).toHaveTextContent(
      "You do not have permission to list these.",
    );
    expect(within(org).queryAllByRole("link")).toEqual([]);
  });

  it("error: the dialog says the list could not be loaded and lists nothing (negative)", async () => {
    renderSwitchers(
      readError("control_plane_unavailable", 503),
      "core-platform",
    );
    const ws = await openDialog("Switch workspace");
    expect(within(ws).getByRole("status")).toHaveTextContent(
      "This list could not be loaded. Reload the page to try again.",
    );
    expect(within(ws).queryAllByRole("link")).toEqual([]);
  });
});
