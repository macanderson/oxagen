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
    { slug: "acme", name: "Acme Robotics", avatarUrl: null },
    { slug: "globex", name: "Globex", avatarUrl: null },
  ],
  workspaces: [
    { slug: "core-platform", name: "Core platform", avatarUrl: null },
    { slug: "finops", name: "FinOps", avatarUrl: null },
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
    // The mock's `a-intel · Team`: the slug alone, since list_orgs returns no
    // plan, and no placeholder where the plan would go (#3861).
    expect(within(tile).getByText("acme")).toBeInTheDocument();
    expect(tile).not.toHaveTextContent("?");
    expect(tile).not.toHaveTextContent("·");
    const dialog = await openDialog("Switch organization");
    const links = within(dialog).getAllByRole("link");
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/acme",
      "/globex",
    ]);
    expect(links[0]).toHaveAttribute("aria-current", "true");
    expect(links[0]).toHaveTextContent("current");
    expect(links[1]).not.toHaveAttribute("aria-current");
    // The mock's note under the list, with the count the read returned.
    expect(dialog).toHaveTextContent(
      "An organization owns a key-encryption key, a Postgres partition, a billing account, and optionally a dedicated data plane. You belong to 2 here.",
    );
    // The plan and agent count are not returned by list_orgs, and the dialog says so.
    expect(
      within(dialog).getByTestId("switcher-meta-not-backed"),
    ).toHaveAttribute("data-gap", "#3861");
    await userEvent.click(within(dialog).getByRole("link", { name: /Globex/ }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("narrows the list as you search organizations, by name or slug", async () => {
    renderSwitchers(listed, "core-platform");
    const dialog = await openDialog("Switch organization");
    const search = within(dialog).getByRole("searchbox", {
      name: "Search organizations",
    });
    await userEvent.type(search, "glob");
    expect(
      within(dialog)
        .getAllByRole("link")
        .map((l) => l.getAttribute("href")),
    ).toEqual(["/globex"]);
    await userEvent.clear(search);
    await userEvent.type(search, "nothing-like-this");
    expect(within(dialog).queryAllByRole("link")).toEqual([]);
    expect(dialog).toHaveTextContent("Nothing matches “nothing-like-this”.");
  });
});

describe("workspace switcher", () => {
  it("names the workspace from shell.context and lists the organization's workspaces, the current one marked", async () => {
    renderSwitchers(listed, "finops");
    const tile = screen.getByRole("button", { name: /^Switch workspace/ });
    expect(tile).toHaveTextContent("FinOps");
    // The mock's `a-intel/platform · main`: the path alone, since
    // list_workspaces returns no branch, and no placeholder where the branch
    // would go (#3861).
    expect(within(tile).getByText("acme/finops")).toBeInTheDocument();
    expect(tile).not.toHaveTextContent("?");
    expect(tile).not.toHaveTextContent("·");
    const dialog = await openDialog("Switch workspace");
    const links = within(dialog)
      .getAllByRole("link")
      .filter((l) => !l.hasAttribute("data-testid"));
    expect(links.map((l) => l.getAttribute("href"))).toEqual([
      "/acme/core-platform",
      "/acme/finops",
    ]);
    expect(links[1]).toHaveAttribute("aria-current", "true");
    expect(links[0]).not.toHaveAttribute("aria-current");
    // The workspace dialog has no search, as the mock draws it.
    expect(within(dialog).queryByRole("searchbox")).toBeNull();
    expect(
      within(dialog).getByTestId("switcher-meta-not-backed"),
    ).toHaveTextContent(
      "The main repository, its branch and the agent count of each workspace are not recorded with this list yet.",
    );
  });

  it("ends on Create a workspace, which goes to the Workspaces section of the Organization page", async () => {
    renderSwitchers(listed, "finops");
    const dialog = await openDialog("Switch workspace");
    const create = within(dialog).getByRole("link", {
      name: "Create a workspace",
    });
    expect(create).toHaveAttribute("href", "/acme?tab=workspaces");
    await userEvent.click(create);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
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

describe("switcher avatars", () => {
  const withAvatars = readOk({
    orgs: [
      {
        slug: "acme",
        name: "Acme Robotics",
        avatarUrl: "https://example.test/acme.png",
      },
      {
        slug: "globex",
        name: "Globex",
        avatarUrl: 'avatar:v1:{"kind":"icon","icon":"rocket","tone":"gold"}',
      },
    ],
    workspaces: [
      {
        slug: "core-platform",
        name: "Core platform",
        avatarUrl: 'avatar:v1:{"kind":"icon","icon":"satellite","tone":"soft"}',
      },
      {
        slug: "finops",
        name: "FinOps",
        avatarUrl: "https://example.test/finops.png",
      },
    ],
  });

  it("draws the organization's and the workspace's stored avatars on the tiles", () => {
    renderSwitchers(withAvatars, "finops");
    const org = screen.getByTestId("org-switcher-avatar");
    expect(org).toHaveAttribute("data-avatar", "image");
    expect(org).toHaveAttribute("src", "https://example.test/acme.png");
    const ws = screen.getByTestId("workspace-switcher-avatar");
    expect(ws).toHaveAttribute("data-avatar", "image");
    expect(ws).toHaveAttribute("src", "https://example.test/finops.png");
  });

  it("draws a designed avatar as its glyph on the workspace tile", () => {
    renderSwitchers(withAvatars, "core-platform");
    const ws = screen.getByTestId("workspace-switcher-avatar");
    expect(ws).toHaveAttribute("data-avatar", "icon");
    expect(ws).toHaveAttribute("data-icon", "satellite");
  });

  it("draws each row's avatar in the organization dialog", async () => {
    renderSwitchers(withAvatars, "finops");
    const orgs = await openDialog("Switch organization");
    const [acme, globex] = within(orgs).getAllByRole("link");
    expect(acme?.querySelector("[data-avatar]")).toHaveAttribute(
      "data-avatar",
      "image",
    );
    expect(globex?.querySelector("[data-avatar]")).toHaveAttribute(
      "data-icon",
      "rocket",
    );
  });

  it("draws each row's avatar in the workspace dialog", async () => {
    renderSwitchers(withAvatars, "finops");
    const wss = await openDialog("Switch workspace");
    const [core, finops] = within(wss)
      .getAllByRole("link")
      .filter((l) => !l.hasAttribute("data-testid"));
    expect(core?.querySelector("[data-avatar]")).toHaveAttribute(
      "data-icon",
      "satellite",
    );
    expect(finops?.querySelector("[data-avatar]")).toHaveAttribute(
      "data-avatar",
      "image",
    );
  });

  it("keeps the letter tiles when none is set: one letter on gold, two mono letters (negative)", async () => {
    renderSwitchers(listed, "finops");
    const org = screen.getByTestId("org-switcher-avatar");
    expect(org).toHaveAttribute("data-avatar", "initials");
    expect(org).toHaveAttribute("data-tone", "gold");
    expect(org).toHaveTextContent(/^A$/);
    const ws = screen.getByTestId("workspace-switcher-avatar");
    expect(ws).toHaveAttribute("data-avatar", "initials");
    expect(ws).toHaveAttribute("data-font", "mono");
    expect(ws).toHaveTextContent(/^fi$/);
    const dialog = await openDialog("Switch workspace");
    for (const link of within(dialog)
      .getAllByRole("link")
      .filter((l) => !l.hasAttribute("data-testid")))
      expect(link.querySelector("[data-avatar]")).toHaveAttribute(
        "data-avatar",
        "initials",
      );
  });

  it("falls back to the letter tiles when the read did not list (negative)", () => {
    renderSwitchers(
      readError("control_plane_unavailable", 503),
      "core-platform",
    );
    expect(screen.getByTestId("org-switcher-avatar")).toHaveAttribute(
      "data-avatar",
      "initials",
    );
    expect(screen.getByTestId("workspace-switcher-avatar")).toHaveTextContent(
      /^co$/,
    );
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
