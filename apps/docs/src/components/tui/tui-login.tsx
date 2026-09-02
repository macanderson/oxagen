import { TuiFrame } from "./tui-frame";
import { tuiColors, tuiGlyphs } from "./tui-theme";

/**
 * TuiLogin — `oxagen login`, the browser-based OAuth flow: a pulsing "waiting
 * for the browser" status while the picker resolves org + workspace, then the
 * confirmed session. Matches the account-setup doc page's example org/
 * workspace slugs (acme/eng) and email conventions.
 */
export function TuiLogin({ className }: { className?: string }) {
  return (
    <TuiFrame
      id="tui-login"
      title="~/acme-web — oxagen"
      width={560}
      height={226}
      className={className}
    >
      <text x={20} y={48} fontSize={12.5}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.pointer}{" "}
        </tspan>
        <tspan fill="#f5f5f5">oxagen login --org acme --workspace eng</tspan>
      </text>

      <text x={20} y={74} fontSize={12} fill={tuiColors.dim}>
        Opening browser for authentication…
      </text>
      <text x={20} y={96} fontSize={12}>
        <tspan className="tui-pulse" fill={tuiColors.amber} fontWeight={700}>
          {"● "}
        </tspan>
        <tspan fill={tuiColors.amber}>Waiting for browser confirmation…</tspan>
      </text>

      <text x={20} y={134} fontSize={13}>
        <tspan fill={tuiColors.green} fontWeight={700}>
          {"✓ "}
        </tspan>
        <tspan fill="#f5f5f5" fontWeight={700}>
          Logged in as mac@oxagen.ai
        </tspan>
      </text>
      <text x={34} y={154} fontSize={12}>
        <tspan fill={tuiColors.dim}>org </tspan>
        <tspan fill={tuiColors.cyan}>acme</tspan>
      </text>
      <text x={34} y={172} fontSize={12}>
        <tspan fill={tuiColors.dim}>workspace </tspan>
        <tspan fill={tuiColors.cyan}>eng</tspan>
      </text>

      <text x={20} y={202} fontSize={13}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.pointer}{" "}
        </tspan>
      </text>
      <rect
        className="tui-caret"
        x={34}
        y={190}
        width={7}
        height={15}
        fill={tuiColors.cyan}
        opacity={0.85}
      />
    </TuiFrame>
  );
}
