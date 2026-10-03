import type { ReactNode } from "react";
import { TUI_MONO, tuiChrome } from "./tui-theme";

/**
 * TuiFrame — the reusable macOS-style terminal window every full-screen TUI
 * screenshot composes inside. Mirrors `.lp-term` (apps/docs/src/app/global.css)
 * and `TypewriterTerminal` (apps/docs/src/components/landing/typewriter-terminal.tsx):
 * a dark rounded panel, a hairline top border under three traffic-light dots,
 * and a warm ember drop shadow — so a TUI screen reads as a sibling of the
 * landing-page hero terminal.
 *
 * Children render inside a `<g>` in the same viewBox coordinate space; callers
 * lay out their own SVG content below the title bar.
 *
 * The SVG is marked `aria-hidden` and every screen is decorative: it recreates
 * a terminal a reader is not expected to operate, and the surrounding MDX
 * always states the same information in prose. The `<title>` is therefore NOT
 * an accessible name — `aria-hidden` removes the whole subtree from the
 * accessibility tree — it only supplies the browser's hover tooltip. Any screen
 * that ever carries information the prose does not must drop `aria-hidden`, not
 * rely on the `<title>` being read.
 */
export function TuiFrame({
  id,
  title,
  width = 560,
  height,
  children,
  className,
}: {
  /** Unique id prefix for this screen's `<defs>` (e.g. "tui-banner"). */
  id: string;
  /** Window title drawn in the chrome bar (also the SVG's hover tooltip). */
  title: string;
  width?: number;
  height: number;
  children: ReactNode;
  className?: string;
}): ReactNode {
  const shadowId = `${id}-shadow`;
  return (
    <svg
      role="img"
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      className={className ?? "h-auto w-full"}
    >
      <title>{title}</title>
      <defs>
        <filter id={shadowId} x="-20%" y="-30%" width="140%" height="170%">
          <feDropShadow
            dx="0"
            dy="16"
            stdDeviation="20"
            floodColor={tuiChrome.shadowColor}
            floodOpacity="0.26"
          />
        </filter>
      </defs>

      <g filter={`url(#${shadowId})`}>
        <rect
          x={0.75}
          y={0.75}
          width={width - 1.5}
          height={height - 1.5}
          rx={12}
          fill={tuiChrome.background}
          fillOpacity={tuiChrome.backgroundOpacity}
          stroke={tuiChrome.border}
        />
      </g>

      {/* Title bar */}
      <line x1={0} y1={32} x2={width} y2={32} stroke={tuiChrome.border} />
      <circle cx={20} cy={16} r={5} fill={tuiChrome.trafficRed} />
      <circle cx={38} cy={16} r={5} fill={tuiChrome.trafficAmber} />
      <circle cx={56} cy={16} r={5} fill={tuiChrome.trafficGreen} />
      <text
        x={78}
        y={20.5}
        fontFamily={TUI_MONO}
        fontSize={11}
        fill={tuiChrome.titleColor}
      >
        {title}
      </text>

      <g fontFamily={TUI_MONO}>{children}</g>
    </svg>
  );
}

/**
 * TuiZoom — a magnified crop of one region of a TUI screen, with no window
 * chrome (no traffic lights, no title bar): just a bordered panel and a small
 * corner-bracket "zoom" affordance, signalling "this is a close-up, not the
 * whole window." Used when a doc section covers one specific part of a screen
 * (e.g. the slash-command menu) and a full terminal window would be mostly
 * empty space around it.
 *
 * Decorative and `aria-hidden`, on the same terms as TuiFrame above.
 */
export function TuiZoom({
  id,
  title,
  width = 560,
  height,
  children,
  className,
}: {
  /** Unique id prefix for this screen's `<defs>` (e.g. "tui-slash-menu"). */
  id: string;
  /** Label for the crop (hover tooltip only — the SVG is `aria-hidden`). */
  title: string;
  width?: number;
  height: number;
  children: ReactNode;
  className?: string;
}): ReactNode {
  const shadowId = `${id}-shadow`;
  const bracket = 14;
  return (
    <svg
      role="img"
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      className={className ?? "h-auto w-full"}
    >
      <title>{title}</title>
      <defs>
        <filter id={shadowId} x="-20%" y="-30%" width="140%" height="170%">
          <feDropShadow
            dx="0"
            dy="12"
            stdDeviation="16"
            floodColor={tuiChrome.shadowColor}
            floodOpacity="0.2"
          />
        </filter>
      </defs>

      <g filter={`url(#${shadowId})`}>
        <rect
          x={0.75}
          y={0.75}
          width={width - 1.5}
          height={height - 1.5}
          rx={10}
          fill={tuiChrome.background}
          fillOpacity={tuiChrome.backgroundOpacity}
          stroke={tuiChrome.border}
        />
      </g>

      {/* Corner "zoom" brackets — a close-up, not a full window. */}
      <g
        stroke="#7CE8F4"
        strokeWidth={2}
        strokeLinecap="round"
        fill="none"
        opacity={0.5}
      >
        <path d={`M ${8} ${8 + bracket} L 8 8 L ${8 + bracket} 8`} />
        <path
          d={`M ${width - 8 - bracket} ${height - 8} L ${width - 8} ${height - 8} L ${width - 8} ${height - 8 - bracket}`}
        />
      </g>

      <g fontFamily={TUI_MONO}>{children}</g>
    </svg>
  );
}
