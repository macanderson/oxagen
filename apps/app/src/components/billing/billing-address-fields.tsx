"use client";
/**
 * BillingAddressFields — reusable address section used on the org-creation
 * onboarding screen (and future billing-settings surfaces).
 *
 * Google Places autocomplete pre-fills the address when the Maps key is
 * present.  The Google layer is entirely optional: if the key is absent, the
 * library fails to load, or autocomplete throws, the failure is swallowed
 * silently and all fields remain fully editable.  Manual entry is ALWAYS
 * available regardless of Google's status.
 *
 * Values are stored in React state and sync to hidden/visible form inputs so
 * they are picked up by a plain FormData from the wrapping <form>.  All
 * fields use the canonical name attributes expected by createOrgAction.
 */
import * as React from "react";
import { APIProvider, useMapsLibrary } from "@vis.gl/react-google-maps";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectPopup,
  SelectItem,
} from "@/components/ui/select";
import { COUNTRY_OPTIONS, US_STATE_OPTIONS } from "@oxagen/config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BillingAddressValue {
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  placeId: string;
}

const EMPTY: BillingAddressValue = {
  line1: "",
  line2: "",
  city: "",
  region: "",
  postalCode: "",
  country: "",
  placeId: "",
};

// ---------------------------------------------------------------------------
// Inner component — requires the Maps library to already be loaded via
// APIProvider. Wrapped in a try/catch boundary further below so any failure
// does not propagate to the form.
// ---------------------------------------------------------------------------

function PlacesAutocomplete({
  line1Ref,
  onFill,
}: {
  line1Ref: React.RefObject<HTMLInputElement | null>;
  onFill: (v: Partial<BillingAddressValue>) => void;
}) {
  const places = useMapsLibrary("places");

  React.useEffect(() => {
    if (!places || !line1Ref.current) return;

    let autocomplete: google.maps.places.Autocomplete | undefined;

    try {
      autocomplete = new places.Autocomplete(line1Ref.current, {
        types: ["address"],
        fields: ["address_components", "place_id"],
      });

      autocomplete.addListener("place_changed", () => {
        try {
          const place = autocomplete!.getPlace();
          const comps = place.address_components ?? [];

          const get = (type: string, short = false) =>
            comps.find((c) => c.types.includes(type))?.[short ? "short_name" : "long_name"] ?? "";

          const streetNumber = get("street_number");
          const route = get("route");
          const line1 = [streetNumber, route].filter(Boolean).join(" ");

          onFill({
            line1: line1 || undefined,
            city: get("locality") || get("postal_town") || get("sublocality") || undefined,
            // ISO 3166-2: administrative_area_level_1 short_name gives the
            // two-letter US state code (e.g. "CA"), or the equivalent for other
            // countries.
            region: get("administrative_area_level_1", true) || undefined,
            postalCode: get("postal_code") || undefined,
            // ISO 3166-1 alpha-2: short_name gives "US", "GB", etc.
            country: get("country", true) || undefined,
            placeId: place.place_id ?? undefined,
          });
        } catch {
          // Silent — place_changed errors must never surface to the user.
          console.debug("[billing-address] place_changed error (suppressed)");
        }
      });
    } catch {
      console.debug("[billing-address] Autocomplete init error (suppressed)");
    }

    return () => {
      try {
        if (autocomplete) google.maps.event.clearInstanceListeners(autocomplete);
      } catch {
        // ignore
      }
    };
  }, [places, line1Ref, onFill]);

  return null; // renders nothing — purely an effect
}

// ---------------------------------------------------------------------------
// Error boundary — isolates Google Maps failures from the rest of the form
// ---------------------------------------------------------------------------

class MapsErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  override componentDidCatch(err: Error) {
    console.debug("[billing-address] Maps error boundary caught (suppressed)", err);
  }
  override render() {
    if (this.state.hasError) return null; // fail silently
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BillingAddressFields() {
  const [addr, setAddr] = React.useState<BillingAddressValue>(EMPTY);
  const line1Ref = React.useRef<HTMLInputElement | null>(null);

  const patch = React.useCallback((partial: Partial<BillingAddressValue>) => {
    setAddr((prev) => ({ ...prev, ...partial }));
  }, []);

  const mapsKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  const mapsEnabled = typeof mapsKey === "string" && mapsKey.length > 0;

  const isUS = addr.country === "US";

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm font-medium">Billing address</p>

      {/* Country */}
      <div className="space-y-1.5">
        <Label htmlFor="addressCountry">Country</Label>
        <Select
          value={addr.country || undefined}
          onValueChange={(v) => patch({ country: v ?? "", region: "" })}
        >
          <SelectTrigger id="addressCountry" size="lg" className="w-full">
            <SelectValue placeholder="Select country" />
          </SelectTrigger>
          <SelectPopup>
            {COUNTRY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {/* Hidden input so FormData always carries the value */}
        <input type="hidden" name="addressCountry" value={addr.country} readOnly />
      </div>

      {/* Address line 1 — Google autocomplete anchor */}
      <div className="space-y-1.5">
        <Label htmlFor="addressLine1">Address line 1</Label>
        <Input
          ref={line1Ref}
          id="addressLine1"
          name="addressLine1"
          placeholder="123 Main St"
          value={addr.line1}
          onChange={(e) => patch({ line1: e.target.value })}
          autoComplete="address-line1"
        />
      </div>

      {/* Address line 2 */}
      <div className="space-y-1.5">
        <Label htmlFor="addressLine2">Address line 2 <span className="text-muted-foreground font-normal">(optional)</span></Label>
        <Input
          id="addressLine2"
          name="addressLine2"
          placeholder="Suite 100"
          value={addr.line2}
          onChange={(e) => patch({ line2: e.target.value })}
          autoComplete="address-line2"
        />
      </div>

      {/* City */}
      <div className="space-y-1.5">
        <Label htmlFor="addressCity">City</Label>
        <Input
          id="addressCity"
          name="addressCity"
          placeholder="San Francisco"
          value={addr.city}
          onChange={(e) => patch({ city: e.target.value })}
          autoComplete="address-level2"
        />
      </div>

      {/* State / Region */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="addressRegion">{isUS ? "State" : "Region"}</Label>
          {isUS ? (
            <>
              <Select
                value={addr.region || undefined}
                onValueChange={(v) => patch({ region: v ?? "" })}
              >
                <SelectTrigger id="addressRegion" size="lg" className="w-full">
                  <SelectValue placeholder="State" />
                </SelectTrigger>
                <SelectPopup>
                  {US_STATE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <input type="hidden" name="addressRegion" value={addr.region} readOnly />
            </>
          ) : (
            <Input
              id="addressRegion"
              name="addressRegion"
              placeholder="Region / Province"
              value={addr.region}
              onChange={(e) => patch({ region: e.target.value })}
              autoComplete="address-level1"
            />
          )}
        </div>

        {/* Postal code */}
        <div className="space-y-1.5">
          <Label htmlFor="addressPostalCode">Postal code</Label>
          <Input
            id="addressPostalCode"
            name="addressPostalCode"
            placeholder="94105"
            value={addr.postalCode}
            onChange={(e) => patch({ postalCode: e.target.value })}
            autoComplete="postal-code"
          />
        </div>
      </div>

      {/* Hidden place_id — captured from Google; empty when manually entered */}
      <input type="hidden" name="addressPlaceId" value={addr.placeId} readOnly />

      {/* Google Places autocomplete — mounts only when key is present */}
      {mapsEnabled && (
        <MapsErrorBoundary>
          <APIProvider
            apiKey={mapsKey}
            onError={() => {
              console.debug("[billing-address] APIProvider error (suppressed)");
            }}
          >
            <PlacesAutocomplete line1Ref={line1Ref} onFill={patch} />
          </APIProvider>
        </MapsErrorBoundary>
      )}
    </div>
  );
}
