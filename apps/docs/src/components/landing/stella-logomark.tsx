import type { ReactNode } from "react";

/**
 * StellaLogomark — the official Stella mark (8-chevron starburst, orange east
 * chevron + core), adapted from crates/site/assets/stella-mark.svg. Neutral
 * strokes follow currentColor so the mark reads on both light and dark pages;
 * the accent chevron and core stay Stella brand orange (#FFAC26).
 */
export function StellaLogomark({ className }: { className?: string }): ReactNode {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      className={className}
      aria-hidden="true"
    >
      <g transform="translate(256,256) scale(2.1)" fill="none" strokeLinecap="round" strokeLinejoin="miter" strokeMiterlimit="6">
        <path d="M 58.66 -20.17 L 100.00 0.00 L 58.66 20.17" stroke="#FFAC26" strokeWidth="15" />
        <path d="M 20.17 58.66 L 0.00 100.00 L -20.17 58.66" stroke="currentColor" strokeWidth="15" />
        <path d="M -58.66 20.17 L -100.00 0.00 L -58.66 -20.17" stroke="currentColor" strokeWidth="15" />
        <path d="M -20.17 -58.66 L -0.00 -100.00 L 20.17 -58.66" stroke="currentColor" strokeWidth="15" />
        <path d="M 37.67 17.83 L 48.08 48.08 L 17.83 37.67" stroke="currentColor" strokeWidth="12" />
        <path d="M -17.83 37.67 L -48.08 48.08 L -37.67 17.83" stroke="currentColor" strokeWidth="12" />
        <path d="M -37.67 -17.83 L -48.08 -48.08 L -17.83 -37.67" stroke="currentColor" strokeWidth="12" />
        <path d="M 17.83 -37.67 L 48.08 -48.08 L 37.67 -17.83" stroke="currentColor" strokeWidth="12" />
        <circle cx="0" cy="0" r="10.5" fill="#FFAC26" />
      </g>
    </svg>
  );
}
