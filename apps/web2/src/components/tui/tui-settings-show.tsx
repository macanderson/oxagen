import { TuiFrame } from "./tui-frame";
import { tuiColors, tuiGlyphs } from "./tui-theme";

interface SettingRow {
  key: string;
  value: string;
  scope: "user" | "project" | "local" | "default";
}

const SCOPE_COLOR: Record<SettingRow["scope"], string> = {
  user: tuiColors.blue,
  project: tuiColors.green,
  local: tuiColors.amber,
  default: tuiColors.dim,
};

/** Mirrors the merged-view shape `oxagen settings show` prints — see the
 *  scopes table in the Configuration doc page. */
const ROWS: readonly SettingRow[] = [
  { key: "model", value: "anthropic/claude-sonnet-5", scope: "project" },
  { key: "apiUrl", value: "https://api.oxagen.sh", scope: "default" },
  { key: "permissions.defaultMode", value: "default", scope: "project" },
  { key: "env.AI_GATEWAY_API_KEY", value: "vck_••••••••", scope: "user" },
];

/**
 * TuiSettingsShow — `oxagen settings show`, the merged view of the layered
 * settings.json (user → project → local), each value tagged with the scope it
 * resolved from. Matches the CLI's status-view color grammar: cyan prompt,
 * violet keys, per-scope tag colors.
 */
export function TuiSettingsShow({ className }: { className?: string }) {
  return (
    <TuiFrame
      id="tui-settings"
      title="~/acme-web — oxagen"
      width={560}
      height={228}
      className={className}
    >
      <text x={20} y={48} fontSize={13}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.pointer}{" "}
        </tspan>
        <tspan fill="#f5f5f5">oxagen settings show</tspan>
      </text>

      <text x={20} y={72} fontSize={11} fill={tuiColors.dim}>
        KEY
      </text>
      <text x={220} y={72} fontSize={11} fill={tuiColors.dim}>
        VALUE
      </text>
      <text x={470} y={72} fontSize={11} fill={tuiColors.dim}>
        SCOPE
      </text>

      {ROWS.map((row, i) => {
        const y = 94 + i * 20;
        return (
          <g key={row.key}>
            <text x={20} y={y} fontSize={12} fill={tuiColors.violet}>
              {row.key}
            </text>
            <text x={220} y={y} fontSize={12} fill="#e6e6e6">
              {row.value}
            </text>
            <text
              x={470}
              y={y}
              fontSize={11.5}
              fill={SCOPE_COLOR[row.scope]}
              fontWeight={700}
            >
              {row.scope}
            </text>
          </g>
        );
      })}

      <text x={20} y={190} fontSize={11} fill={tuiColors.dim}>
        4 keys resolved · `oxagen settings path` shows the three files
      </text>

      <text x={20} y={214} fontSize={13}>
        <tspan fill={tuiColors.cyan} fontWeight={700}>
          {tuiGlyphs.pointer}{" "}
        </tspan>
      </text>
      <rect
        className="tui-caret"
        x={34}
        y={202}
        width={7}
        height={15}
        fill={tuiColors.cyan}
        opacity={0.85}
      />
    </TuiFrame>
  );
}
