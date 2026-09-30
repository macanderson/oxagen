// @vitest-environment jsdom
// The On disk panel (roadmap pages/steering-records.md) on a read tree. A
// steering repository lists its steering/ tree and a legacy one its .oxagen/
// tree, each rooted where get_repository_tree read it, and the governance
// file's comment names the mode it declares (#4821). axe checks the state
// each test ends in (INV-26).
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { OxagenTree } from "@/data/contracts/steering";
import { readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { OnDisk } from "./records-panels";

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

function renderTree(tree: OxagenTree) {
  render(
    <IntlProvider>
      <OnDisk tree={readOk(tree)} />
    </IntlProvider>,
  );
  return screen.getByTestId("records-on-disk");
}

describe("OnDisk", () => {
  it("lists a steering repository's steering/ tree and the mode its governance file declares", () => {
    const panel = renderTree({
      state: "read",
      repository: "acme/platform",
      branch: "main",
      head: "4d5e6f7a8b9c",
      root: "steering",
      files: ["constraints/ctx.core.no-force-push.md", "governance.toml"],
      governancePath: "steering/governance.toml",
      mode: "solo",
    });
    const tree = panel.querySelector('[data-tree="read"]');
    expect(tree?.textContent).toMatch(/^steering\//);
    expect(tree?.textContent).not.toContain(".oxagen/");
    expect(tree).toHaveTextContent("governance.toml");
    expect(tree).toHaveTextContent("mode = solo");
  });

  it("lists a legacy repository's .oxagen/ tree", () => {
    const panel = renderTree({
      state: "read",
      repository: "acme/platform",
      branch: "main",
      head: "4d5e6f7a8b9c",
      root: ".oxagen",
      files: ["rules/governance.toml", "workspace.toml"],
      governancePath: ".oxagen/rules/governance.toml",
      mode: "team",
    });
    const tree = panel.querySelector('[data-tree="read"]');
    expect(tree?.textContent).toMatch(/^\.oxagen\//);
    expect(tree).toHaveTextContent("mode = team");
  });

  it("says the branch holds neither directory", () => {
    const panel = renderTree({
      state: "read",
      repository: "acme/platform",
      branch: "main",
      head: "4d5e6f7a8b9c",
      root: ".oxagen",
      files: [],
      governancePath: ".oxagen/rules/governance.toml",
      mode: "absent",
    });
    expect(panel.querySelector('[data-tree="absent"]')).toHaveTextContent(
      "main on acme/platform has no steering/ or .oxagen/ directory.",
    );
  });
});
