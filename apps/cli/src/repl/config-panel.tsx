/**
 * config-panel.tsx — The `/config` interactive panel.
 *
 * Shown in place of the prompt input (same takeover pattern as
 * ApprovalPrompt): a keyboard-navigable list of every resolved config value
 * across the four governed tiers (repo ▸ workspace ▸ user ▸ org managed —
 * see ../config/resolve.ts), each row showing its value, the scope that won,
 * and a lock marker when the win was governance-driven.
 *
 * Keys: ↑/↓ move the highlight · `e` (or Enter) edits the highlighted value
 * inline · `x` unsets it from the scope file that set it · Esc closes (or
 * cancels an in-progress edit). Rows owned by the org tier (managed.json)
 * refuse both `e` and `x` with an explanatory notice — that file is
 * provisioned by the organization and read-only to the CLI.
 *
 * All list/row semantics live in ../config/panel-model.ts (pure, tested
 * without a TTY); this component only maps keystrokes to the write.ts
 * operations and re-resolves after each mutation. While the panel is
 * mounted, interactive.tsx's central useInput yields the keyboard entirely
 * (configOpenRef gate) — except while a permission prompt is up, when
 * `active` is false so ApprovalPrompt alone owns the keys.
 */
import { Box, Text, useInput } from "ink";
import React, { useCallback, useState } from "react";
import { theme } from "../tui/theme.js";
import {
  resolveWorkspaceConfig,
  buildConfigRows,
  formatRowValue,
  setPath,
  unsetPath,
  addLanguageItem,
  removeItem,
  type ConfigPanelRow,
  type ConfigScope,
  type LanguageItem,
  type ResolveWorkspaceConfigOptions,
} from "../config/index.js";
import { visibleWindow } from "./slash-menu.js";

/** Max rows shown at once; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_CONFIG_ROWS = 10;

const SCOPE_COLOR: Record<ConfigScope, string> = {
  org: theme.violet,
  user: theme.cyan,
  workspace: theme.green,
  repo: theme.amber,
};

/** Monochrome lock (text presentation) — same glyph convention as slash-menu.tsx. */
const LOCK = "\u{1F512}︎";

const ORG_READONLY_NOTICE =
  "locked by managed.json (org) — enforced org-wide and read-only here; ask an org admin to change it.";

export interface ConfigPanelProps {
  cwd: string;
  onClose: () => void;
  /**
   * False while another surface (the permission ApprovalPrompt) owns the
   * keyboard — the panel stays visible but ignores keys. Defaults to true.
   */
  active?: boolean;
  /** Test seam: override the org/user scope file paths (see resolve.ts). */
  resolveOpts?: ResolveWorkspaceConfigOptions;
  width?: number;
}

interface EditState {
  row: ConfigPanelRow;
  buffer: string;
}

function loadRows(cwd: string, resolveOpts?: ResolveWorkspaceConfigOptions): ConfigPanelRow[] {
  return buildConfigRows(resolveWorkspaceConfig(cwd, { ...resolveOpts, noCache: true }));
}

/** The scope a row's edit/unset should target, or null with a notice when refused. */
function writableTarget(row: ConfigPanelRow): { scope: ConfigScope } | { refusal: string } {
  if (row.kind === "list-value") {
    return { refusal: "list entries are managed via `oxagen config set` with an explicit --scope." };
  }
  if (row.scope === "org") return { refusal: ORG_READONLY_NOTICE };
  return { scope: row.scope ?? "workspace" };
}

export function ConfigPanel({
  cwd,
  onClose,
  active = true,
  resolveOpts,
  width = 84,
}: ConfigPanelProps): React.ReactElement {
  const [rows, setRows] = useState<ConfigPanelRow[]>(() => loadRows(cwd, resolveOpts));
  const [selected, setSelected] = useState(0);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    const next = loadRows(cwd, resolveOpts);
    setRows(next);
    setSelected((s) => Math.min(s, Math.max(0, next.length - 1)));
  }, [cwd, resolveOpts]);

  const handleUnset = useCallback(
    (row: ConfigPanelRow): void => {
      if (row.scope === null) {
        setNotice(`${row.path} isn't set in any tier — nothing to unset.`);
        return;
      }
      const target = writableTarget(row);
      if ("refusal" in target) {
        setNotice(target.refusal);
        return;
      }
      try {
        if (row.kind === "item" && row.item) {
          const result = removeItem(target.scope, row.item.id, { cwd, ...resolveOpts });
          setNotice(
            result.removed
              ? `✓ removed ${row.item.id} from ${target.scope} scope.`
              : `${row.item.id} isn't in the ${target.scope} file (it may come from another tier).`,
          );
        } else {
          const result = unsetPath(target.scope, row.path, { cwd, ...resolveOpts });
          setNotice(
            result.removed
              ? `✓ unset ${row.path} from ${target.scope} scope — a lower-tier value may resurface.`
              : `${row.path} isn't in the ${target.scope} file (it may come from another tier).`,
          );
        }
        refresh();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
    },
    [cwd, refresh, resolveOpts],
  );

  const beginEdit = useCallback((row: ConfigPanelRow): void => {
    const target = writableTarget(row);
    if ("refusal" in target) {
      setNotice(target.refusal);
      return;
    }
    const initial =
      row.kind === "item"
        ? ((row.value as LanguageItem | undefined)?.text ?? "")
        : row.value === undefined
          ? ""
          : formatRowValue(row.value);
    setNotice(null);
    setEdit({ row, buffer: initial });
  }, []);

  const commitEdit = useCallback(
    (state: EditState): void => {
      const value = state.buffer.trim();
      if (value === "") {
        setNotice("empty value — press x on the row to unset it instead.");
        setEdit(null);
        return;
      }
      const target = writableTarget(state.row);
      if ("refusal" in target) {
        setNotice(target.refusal);
        setEdit(null);
        return;
      }
      try {
        if (state.row.kind === "item" && state.row.item) {
          const existing = state.row.value as LanguageItem | undefined;
          const item: LanguageItem = existing
            ? { ...existing, text: value }
            : { id: state.row.item.id, kind: "rule", text: value, origin: "manual" };
          addLanguageItem(target.scope, state.row.item.lang, item, { cwd, ...resolveOpts });
        } else {
          setPath(target.scope, state.row.path, value, { cwd, ...resolveOpts });
        }
        setNotice(`✓ ${state.row.path} saved to ${target.scope} scope.`);
        refresh();
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
      setEdit(null);
    },
    [cwd, refresh, resolveOpts],
  );

  useInput(
    (input, key) => {
      if (edit) {
        if (key.return) {
          commitEdit(edit);
          return;
        }
        if (key.escape) {
          setEdit(null);
          setNotice("edit cancelled.");
          return;
        }
        if (key.backspace || key.delete) {
          setEdit((e) => (e ? { ...e, buffer: e.buffer.slice(0, -1) } : e));
          return;
        }
        if (input && !key.ctrl && !key.meta && !key.upArrow && !key.downArrow && !key.tab) {
          setEdit((e) => (e ? { ...e, buffer: e.buffer + input } : e));
        }
        return;
      }

      if (key.escape) {
        onClose();
        return;
      }
      if (rows.length === 0) return;
      if (key.upArrow) {
        setSelected((s) => (s - 1 + rows.length) % rows.length);
        return;
      }
      if (key.downArrow) {
        setSelected((s) => (s + 1) % rows.length);
        return;
      }
      const row = rows[selected];
      if (!row) return;
      if (input === "x") {
        handleUnset(row);
        return;
      }
      if (input === "e" || key.return) {
        beginEdit(row);
      }
    },
    { isActive: active },
  );

  const { start, end } = visibleWindow(rows.length, selected, MAX_VISIBLE_CONFIG_ROWS);
  const visible = rows.slice(start, end);
  const innerWidth = Math.max(width - 4, 20);
  const pathWidth = Math.min(
    Math.max(...(visible.length > 0 ? visible.map((r) => r.path.length) : [10])) + 1,
    Math.floor(innerWidth * 0.5),
  );
  // pointer(2) + lock(2) + path + gap(2) + scope chip(11 incl. brackets)
  const valueWidth = Math.max(innerWidth - 2 - 2 - pathWidth - 2 - 11, 8);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.violet} paddingX={1} width={width}>
      <Box>
        <Text color={theme.violet} bold>
          {"⚙ config "}
        </Text>
        <Text dimColor>· tiers: repo ▸ workspace ▸ user ▸ org (managed, enforced)</Text>
      </Box>

      {rows.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No config found. Run `oxagen config init` to create a scope file.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visible.map((row, i) => {
            const idx = start + i;
            const isSelected = idx === selected;
            return (
              <Box key={row.path} width={innerWidth}>
                <Text color={isSelected ? theme.cyan : undefined} bold={isSelected}>
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Box width={2}>
                  <Text dimColor>{row.locked ? LOCK : ""}</Text>
                </Box>
                <Box width={pathWidth}>
                  <Text color={theme.amber} bold={isSelected} wrap="truncate-end">
                    {row.path}
                  </Text>
                </Box>
                <Box width={valueWidth}>
                  <Text dimColor={row.value === undefined} wrap="truncate-end">
                    {" "}
                    {row.display}
                  </Text>
                </Box>
                <Box width={11} justifyContent="flex-end">
                  <Text color={row.scope ? SCOPE_COLOR[row.scope] : undefined} dimColor={!row.scope}>
                    [{row.scope ?? "unset"}]
                  </Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {edit ? (
        <Box marginTop={1}>
          <Text color={theme.green}>{"✎ "}</Text>
          <Text color={theme.amber}>{edit.row.path}</Text>
          <Text> = </Text>
          <Text>{edit.buffer}</Text>
          <Text color={theme.cyan}>█</Text>
        </Box>
      ) : null}

      {notice ? (
        <Box marginTop={edit ? 0 : 1}>
          <Text dimColor wrap="truncate-end">
            {notice}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {rows.length > MAX_VISIBLE_CONFIG_ROWS ? `${selected + 1}/${rows.length} · ` : ""}
          {edit ? "↵ save · esc cancel" : `↑↓ navigate · e edit · x unset · esc close · ${LOCK} = enforced`}
        </Text>
      </Box>
    </Box>
  );
}
