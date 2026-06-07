// @vitest-environment jsdom
/**
 * billing-address-fields.test.tsx — render tests for BillingAddressFields.
 *
 * Covers:
 *   - Renders "Billing address" section heading
 *   - Renders Country combobox
 *   - Renders Address line 1 field
 *   - Renders Address line 2 field
 *   - Renders City field
 *   - Renders Postal code field
 *   - Works without Google Maps API key (mapsEnabled=false)
 *   - Renders without crashing when NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is undefined
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { BillingAddressFields } from "./billing-address-fields";

afterEach(cleanup);

// Mock @vis.gl/react-google-maps (not available in jsdom)
vi.mock("@vis.gl/react-google-maps", () => ({
  APIProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useMapsLibrary: () => null,
}));

// Mock @oxagen/config constants
vi.mock("@oxagen/config", () => ({
  COUNTRY_OPTIONS: [
    { value: "US", label: "United States" },
    { value: "GB", label: "United Kingdom" },
  ],
  US_STATE_OPTIONS: [
    { value: "CA", label: "California" },
    { value: "NY", label: "New York" },
  ],
}));

// Mock combobox (portals break in jsdom)
vi.mock("@/components/ui/combobox", () => ({
  Combobox: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComboboxTrigger: ({ children, id }: { children: React.ReactNode; id?: string }) => (
    <button id={id}>{children}</button>
  ),
  ComboboxValue: ({ placeholder }: { placeholder: string }) => <span>{placeholder}</span>,
  ComboboxPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComboboxItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe("BillingAddressFields — rendering", () => {
  it("renders the 'Billing address' heading", () => {
    render(<BillingAddressFields />);
    expect(screen.getByText("Billing address")).toBeInTheDocument();
  });

  it("renders Country label", () => {
    render(<BillingAddressFields />);
    expect(screen.getByText("Country")).toBeInTheDocument();
  });

  it("renders Address line 1 field", () => {
    render(<BillingAddressFields />);
    expect(screen.getByLabelText(/address line 1/i)).toBeInTheDocument();
  });

  it("renders Address line 2 field", () => {
    render(<BillingAddressFields />);
    expect(screen.getByLabelText(/address line 2/i)).toBeInTheDocument();
  });

  it("renders City field", () => {
    render(<BillingAddressFields />);
    expect(screen.getByLabelText(/city/i)).toBeInTheDocument();
  });

  it("renders Postal code field", () => {
    render(<BillingAddressFields />);
    expect(screen.getByLabelText(/postal code/i)).toBeInTheDocument();
  });

  it("renders without crashing when no Google Maps key is set", () => {
    // NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is undefined in test env
    expect(() => render(<BillingAddressFields />)).not.toThrow();
  });
});
