import * as React from "react";

export type LogoVariant = "mark" | "wordmark" | "horizontal" | "vertical";
export type LogoTone = "gradient" | "mono-light" | "mono-dark" | "solid";

/**
 * Oxagen logo system. The MARK is a thick circle outline stroked in the nebula
 * gradient; the WORDMARK is "Oxagen" in Aeonik Fono. Lockups combine them.
 *
 *  - tone "gradient"   — full-color nebula ring (default)
 *  - tone "mono-light" — solid #F4F6FB (place on dark backgrounds)
 *  - tone "mono-dark"  — solid #0F0E15 (place on light backgrounds)
 *  - tone "solid"      — currentColor
 *
 * @startingPoint section="Brand" subtitle="Oxagen logo — nebula ring + Aeonik Fono wordmark" viewport="700x160"
 */
export interface OxagenLogoProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: LogoVariant;
  tone?: LogoTone;
  /** Mark height in px (wordmark scales from it). */
  size?: number;
}

export function OxagenLogo(props: OxagenLogoProps): React.ReactElement;
