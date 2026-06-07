// @vitest-environment jsdom
/**
 * alert.test.tsx — render tests for Alert, AlertTitle, AlertDescription.
 *
 * Covers: role=alert, variant → class, children, sub-parts.
 */

import { render, screen, cleanup } from "@testing-library/react";
import { describe, expect, it, afterEach } from "vitest";
import { Alert, AlertTitle, AlertDescription, alertVariants } from "./alert";

afterEach(cleanup);

// ── Variant map ──────────────────────────────────────────────────────────────

describe("alertVariants — class map", () => {
  it("default includes bg-card", () => {
    expect(alertVariants({})).toContain("bg-card");
  });
  it("info includes bg-info/10", () => {
    expect(alertVariants({ variant: "info" })).toContain("bg-info/10");
  });
  it("success includes bg-success/10", () => {
    expect(alertVariants({ variant: "success" })).toContain("bg-success/10");
  });
  it("warning includes bg-warning/10", () => {
    expect(alertVariants({ variant: "warning" })).toContain("bg-warning/10");
  });
  it("error includes bg-destructive/10", () => {
    expect(alertVariants({ variant: "error" })).toContain("bg-destructive/10");
  });
  it("semantic variants preserve text-foreground for readability", () => {
    for (const v of ["info", "success", "warning", "error"] as const) {
      expect(alertVariants({ variant: v })).toContain("text-foreground");
    }
  });
  it("includes rounded-xl and border base classes", () => {
    const cls = alertVariants({});
    expect(cls).toContain("rounded-xl");
    expect(cls).toContain("border");
  });
});

// ── Render tests ─────────────────────────────────────────────────────────────

describe("Alert — render", () => {
  it("renders with role=alert", () => {
    const { getByRole } = render(<Alert>Something happened</Alert>);
    expect(getByRole("alert")).toBeInTheDocument();
  });

  it("renders children", () => {
    const { getByText } = render(<Alert>Alert message</Alert>);
    expect(getByText("Alert message")).toBeInTheDocument();
  });

  it("applies variant class", () => {
    const { getByRole } = render(<Alert variant="info">Info</Alert>);
    expect(getByRole("alert").className).toContain("bg-info/10");
  });

  it("merges custom className", () => {
    const { getByRole } = render(<Alert className="my-alert">Test</Alert>);
    expect(getByRole("alert").className).toContain("my-alert");
  });
});

describe("AlertTitle — render", () => {
  it("renders an h5 with font-semibold", () => {
    const { getByText } = render(<AlertTitle>Alert Title</AlertTitle>);
    const el = getByText("Alert Title");
    expect(el.tagName.toLowerCase()).toBe("h5");
    expect(el.className).toContain("font-semibold");
  });
});

describe("AlertDescription — render", () => {
  it("renders with muted-foreground class", () => {
    const { getByText } = render(<AlertDescription>Detailed info</AlertDescription>);
    const el = getByText("Detailed info");
    expect(el.className).toContain("text-muted-foreground");
  });
});

describe("Alert — composition", () => {
  it("renders title and description inside alert", () => {
    const { getByRole, getByText } = render(
      <Alert variant="success">
        <AlertTitle>Success</AlertTitle>
        <AlertDescription>Your changes were saved.</AlertDescription>
      </Alert>
    );
    expect(getByRole("alert")).toBeInTheDocument();
    expect(getByText("Success")).toBeInTheDocument();
    expect(getByText("Your changes were saved.")).toBeInTheDocument();
  });
});
