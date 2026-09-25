"use client";
// A provider's icon (#4132): the https icon its registry entry names, or its
// initial on a tile when there is none or the image fails to load. The Tools
// page draws it beside a server, and a record picker beside each tool that
// server provides, in the list and on the chip.
//
// The image is the vendor's own URL, loaded by the viewer's browser, so it is
// fetched with no referrer: the vendor learns an Oxagen page showed its icon,
// not which workspace. Only an https URL reaches here (the view model refuses
// the rest).
import { useState } from "react";

export function ProviderIcon({
  name,
  iconUrl,
  size = 28,
}: {
  name: string;
  iconUrl: string | null;
  size?: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const side = { width: size, height: size };
  const box =
    "inline-grid flex-none place-items-center overflow-hidden rounded-md border border-border bg-muted align-middle";
  if (iconUrl !== null && iconUrl !== failed) {
    return (
      /* A registry icon is on an arbitrary vendor host, so it cannot be in
         next.config's image allowlist, and it is a small ornament. */
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={iconUrl}
        alt=""
        data-provider-icon="image"
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        style={side}
        className={`${box} object-contain p-0.5`}
        onError={() => {
          setFailed(iconUrl);
        }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      data-provider-icon="initial"
      style={side}
      className={`${box} text-xs font-semibold text-muted-foreground`}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}
