// @vitest-environment jsdom
/**
 * page-header.test.tsx — render tests for the PageHeader component.
 */

import { render, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, afterEach, vi } from "vitest";
import { PageHeader } from "./page-header";

afterEach(cleanup);

describe("PageHeader — render", () => {
  it("renders the title as an h1", () => {
    const { getByRole } = render(<PageHeader title="Billing" />);
    expect(
      getByRole("heading", { level: 1, name: "Billing" }),
    ).toBeInTheDocument();
  });

  it("does not render description when omitted", () => {
    const { container } = render(<PageHeader title="Title" />);
    expect(container.querySelector("p")).toBeNull();
  });

  it("renders description when provided", () => {
    const { getByText } = render(
      <PageHeader title="Title" description="Manage your account." />,
    );
    expect(getByText("Manage your account.")).toBeInTheDocument();
  });

  it("renders breadcrumb slot", () => {
    const { getByText } = render(
      <PageHeader title="Title" breadcrumb={<nav>Breadcrumb</nav>} />,
    );
    expect(getByText("Breadcrumb")).toBeInTheDocument();
  });

  it("renders actions slot", () => {
    const { getByRole } = render(
      <PageHeader
        title="Title"
        actions={<button type="button">Upgrade</button>}
      />,
    );
    expect(getByRole("button", { name: "Upgrade" })).toBeInTheDocument();
  });

  it("does not render Ask button when onAskAboutThis is not provided", () => {
    const { queryByRole } = render(<PageHeader title="Title" />);
    expect(queryByRole("button", { name: "Ask about this page" })).toBeNull();
  });

  it("renders Ask button when onAskAboutThis is provided", () => {
    const { getByRole } = render(
      <PageHeader title="Title" onAskAboutThis={vi.fn()} />,
    );
    expect(
      getByRole("button", { name: "Ask about this page" }),
    ).toBeInTheDocument();
  });

  it("calls onAskAboutThis when Ask button is clicked", async () => {
    const onAsk = vi.fn();
    const { getByRole } = render(
      <PageHeader title="Title" onAskAboutThis={onAsk} />,
    );
    await userEvent.click(getByRole("button", { name: "Ask about this page" }));
    expect(onAsk).toHaveBeenCalledOnce();
  });

  it("merges custom className", () => {
    const { container } = render(
      <PageHeader title="T" className="my-header" />,
    );
    expect((container.firstChild as HTMLElement).className).toContain(
      "my-header",
    );
  });
});
