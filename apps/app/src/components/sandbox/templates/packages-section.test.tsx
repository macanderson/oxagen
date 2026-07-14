// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PackagesSection } from "./packages-section";
import type { SandboxTemplatePackageGroup } from "@oxagen/oxagen/contracts/sandbox-template-manifest";

afterEach(cleanup);

/** Controlled wrapper so interactions flow back through onPackagesChange. */
function Harness({
  initial = [],
}: {
  initial?: SandboxTemplatePackageGroup[];
}) {
  const [packages, setPackages] =
    React.useState<SandboxTemplatePackageGroup[]>(initial);
  return <PackagesSection packages={packages} onPackagesChange={setPackages} />;
}

describe("PackagesSection", () => {
  it("adds a manager row via the add button, defaulting to a real manager", () => {
    render(<Harness />);
    expect(
      screen.queryByTestId("sandbox-template-package-manager-0"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("sandbox-template-add-package"));

    const select = screen.getByTestId(
      "sandbox-template-package-manager-0",
    ) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    // Defaults to the first schema-derived manager (apt).
    expect(select.value).toBe("apt");
  });

  it("chips packages typed with a trailing space and dedupes repeats", () => {
    render(<Harness initial={[{ manager: "pip", names: [] }]} />);
    const input = screen.getByTestId("sandbox-template-package-input-0");

    // Trailing separator commits both completed tokens.
    fireEvent.change(input, { target: { value: "fastapi pydantic==2.5 " } });
    expect(screen.getByText("fastapi")).toBeInTheDocument();
    expect(screen.getByText("pydantic==2.5")).toBeInTheDocument();

    // A duplicate is ignored (still exactly one "fastapi" chip).
    fireEvent.change(input, { target: { value: "fastapi " } });
    expect(screen.getAllByText("fastapi")).toHaveLength(1);
  });

  it("commits the current draft on Enter", () => {
    render(<Harness initial={[{ manager: "npm", names: [] }]} />);
    const input = screen.getByTestId("sandbox-template-package-input-0");
    fireEvent.change(input, { target: { value: "react" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("react")).toBeInTheDocument();
  });

  it("removes a chip via its ✕ button", () => {
    render(
      <Harness initial={[{ manager: "pip", names: ["fastapi", "numpy"] }]} />,
    );
    expect(screen.getByText("fastapi")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove fastapi" }));
    expect(screen.queryByText("fastapi")).not.toBeInTheDocument();
    expect(screen.getByText("numpy")).toBeInTheDocument();
  });

  it("removes the last chip on Backspace when the field is empty", () => {
    render(
      <Harness initial={[{ manager: "pip", names: ["fastapi", "numpy"] }]} />,
    );
    const input = screen.getByTestId("sandbox-template-package-input-0");
    fireEvent.keyDown(input, { key: "Backspace" });
    expect(screen.queryByText("numpy")).not.toBeInTheDocument();
    expect(screen.getByText("fastapi")).toBeInTheDocument();
  });

  it("removes an entire manager row", () => {
    render(<Harness initial={[{ manager: "pip", names: ["fastapi"] }]} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Remove package manager" }),
    );
    expect(
      screen.queryByTestId("sandbox-template-package-manager-0"),
    ).not.toBeInTheDocument();
  });
});
