/**
 * files-panel.tsx — the `/files` "Files Touched" panel.
 *
 * Shown in place of the prompt input (same takeover pattern as the `/diff`
 * panel): every file the agent touched this session, one row each —
 *
 *   ❯ [C,U] @oxagen/app: components/thing.tsx                +100/-44
 *
 * with the CRUD ops it saw, the owning workspace package, the path after that
 * package's `src/`, and the file's +/- line counts vs HEAD. ↑/↓ move the
 * selection (wrapping), Enter/→ opens the file's diff in the `/diff` panel,
 * `r` re-reads git, Esc closes — and Ctrl-O pressed TWICE within
 * {@link CTRL_O_OPEN_WINDOW_MS} opens the highlighted file in the user's
 * editor ($VISUAL → $EDITOR → OS default). Double-press because a single
 * Ctrl-O is the REPL's global verbose toggle: while this panel owns the
 * keyboard the first press only ARMS (with a hint), so a stray Ctrl-O never
 * launches an editor by surprise.
 *
 * All colors that carry meaning (op letters, +/- counts) resolve per detected
 * terminal background — bright tones on dark terminals, deeper shades on
 * light — mirroring DARK_DIFF_THEME / LIGHT_DIFF_THEME so the panel stays
 * legible either way. git work and filesystem probes are injectable seams
 * (`listFiles`, `io`, `resolvePackage`, `now`), matching diff-panel.tsx, so
 * tests drive the panel without subprocesses or a checkout.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Box, Text, useInput } from "ink";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { theme } from "../tui/theme.js";
import {
  detectTerminalBackground,
  diffThemeFor,
} from "../tui/terminal-theme.js";
import { listChangedFiles } from "./git-diff.js";
import type { ChangedFile } from "./git-diff.js";
import {
  createPackageResolver,
  hydrateTouchedFiles,
  type HydrateIo,
  type HydratedTouchedFile,
  type PackageLabel,
  type TouchOp,
  type TouchedFile,
} from "./files-touched.js";
import { visibleWindow } from "./slash-menu.js";

/** Max rows shown at once; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_TOUCHED_FILES = 12;

/** Window (ms) a second Ctrl-O must land within to open the editor. */
export const CTRL_O_OPEN_WINDOW_MS = 1500;

/**
 * The pure double-press decision (same shape as resolveCtrlC): the first
 * Ctrl-O arms, a second within the window opens.
 */
export function resolveCtrlO(
  lastCtrlOMs: number | null,
  now: number,
): "arm" | "open" {
  if (lastCtrlOMs !== null && now - lastCtrlOMs <= CTRL_O_OPEN_WINDOW_MS) {
    return "open";
  }
  return "arm";
}

/** Don't line-count untracked files bigger than this (matches git-diff's cap). */
const MAX_COUNT_BYTES = 2 * 1024 * 1024;

export interface FilesPanelProps {
  /** Workspace root — git calls and package resolution run relative to it. */
  cwd: string;
  /** The session's touched-file entries (the interactive.tsx store's values). */
  entries: TouchedFile[];
  onClose: () => void;
  /** Open this (repo-relative) path's diff — the parent hands off to /diff. */
  onShowDiff: (path: string) => void;
  /** Open this (repo-relative) path in the user's editor. */
  onOpenFile: (path: string) => void;
  /** False while another surface owns the keyboard. */
  active?: boolean;
  width?: number;
  /** Test seam: list the working tree's changed files. */
  listFiles?: typeof listChangedFiles;
  /** Test seam: filesystem probes used to hydrate rows. */
  io?: HydrateIo;
  /** Test seam: repo-relative path → package label. */
  resolvePackage?: (relPath: string) => PackageLabel;
  /** Test seam: clock for the double-Ctrl-O window. */
  now?: () => number;
}

/** Count a small text file's lines, standing in for numstat on untracked files. */
function countFileLines(absPath: string): number | undefined {
  try {
    if (statSync(absPath).size > MAX_COUNT_BYTES) return undefined;
    const text = readFileSync(absPath, "utf8");
    if (text === "") return 0;
    const lines = text.split("\n");
    return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  } catch {
    return undefined;
  }
}

export function FilesPanel({
  cwd,
  entries,
  onClose,
  onShowDiff,
  onOpenFile,
  active = true,
  width = 84,
  listFiles = listChangedFiles,
  io,
  resolvePackage,
  now = Date.now,
}: FilesPanelProps): React.ReactElement {
  const [changed, setChanged] = useState<ChangedFile[]>([]);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [armedPath, setArmedPath] = useState<string | null>(null);
  const lastCtrlORef = useRef<number | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Meaning-bearing colors per detected background (resolved once per mount),
  // mirroring DARK_DIFF_THEME / LIGHT_DIFF_THEME: bright on dark, deep on light.
  const bg = useMemo(() => detectTerminalBackground(), []);
  const diffTheme = useMemo(() => diffThemeFor(bg), [bg]);
  const opColors = useMemo<Record<TouchOp, string>>(
    () =>
      bg === "light"
        ? { C: "#15803D", R: "#0E7490", U: "#B45309", D: "#B91C1C" }
        : { C: theme.green, R: theme.cyan, U: theme.amber, D: theme.red },
    [bg],
  );
  const accent = bg === "light" ? "#0E7490" : theme.cyan;

  const hydrateIo = useMemo<HydrateIo>(
    () =>
      io ?? {
        fileExists: (rel) => {
          try {
            return existsSync(join(cwd, rel));
          } catch {
            return false;
          }
        },
        countLines: (rel) => countFileLines(join(cwd, rel)),
      },
    [io, cwd],
  );
  const packageFor = useMemo(
    () => resolvePackage ?? createPackageResolver(cwd),
    [resolvePackage, cwd],
  );

  /** Re-read git's view of the working tree. */
  const refresh = useCallback(async (): Promise<void> => {
    const list = await listFiles(cwd);
    if (!mountedRef.current) return;
    setChanged(list);
    setReady(true);
  }, [listFiles, cwd]);

  // Load on mount, and again whenever the agent touches more files while the
  // panel is open (entries.length only ever grows within a session).
  useEffect(() => {
    void refresh();
  }, [refresh, entries.length]);

  const rows: HydratedTouchedFile[] = useMemo(
    () => hydrateTouchedFiles(entries, changed, hydrateIo),
    [entries, changed, hydrateIo],
  );
  const clampedSelected = Math.min(selected, Math.max(0, rows.length - 1));

  const disarm = useCallback((): void => {
    lastCtrlORef.current = null;
    setArmedPath(null);
  }, []);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "o") {
        const row = rows[clampedSelected];
        if (!row) return;
        const t = now();
        if (resolveCtrlO(lastCtrlORef.current, t) === "open") {
          disarm();
          onOpenFile(row.path);
        } else {
          lastCtrlORef.current = t;
          setArmedPath(row.path);
        }
        return;
      }
      // Any other key breaks the double-press chain.
      disarm();

      if (key.escape) {
        onClose();
        return;
      }
      if (input === "r") {
        setNotice("refreshing…");
        void refresh().then(() => {
          if (mountedRef.current) setNotice(null);
        });
        return;
      }
      if (rows.length === 0) return;
      if (key.upArrow) {
        setSelected((clampedSelected - 1 + rows.length) % rows.length);
        return;
      }
      if (key.downArrow) {
        setSelected((clampedSelected + 1) % rows.length);
        return;
      }
      if (key.return || key.rightArrow) {
        const row = rows[clampedSelected];
        if (!row) return;
        if (row.gitStatus === undefined && !row.untracked) {
          setNotice(
            `No working-tree changes for ${row.path} — nothing to diff.`,
          );
          return;
        }
        onShowDiff(row.path);
      }
    },
    { isActive: active },
  );

  const innerWidth = Math.max(width - 4, 20);
  const opsWidth = 10; // "[C,R,U,D]" + pad
  const countsWidth = 12;
  const labelWidth = Math.max(innerWidth - 2 - opsWidth - countsWidth, 10);

  const { start, end } = visibleWindow(
    rows.length,
    clampedSelected,
    MAX_VISIBLE_TOUCHED_FILES,
  );
  const visibleRows = rows.slice(start, end);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={accent}
      paddingX={1}
      width={width}
    >
      <Box>
        <Text color={accent} bold>
          {"Files Touched "}
        </Text>
        <Text dimColor>
          · {rows.length} file{rows.length === 1 ? "" : "s"} this session
        </Text>
      </Box>

      {!ready ? (
        <Box marginTop={1}>
          <Text dimColor>loading…</Text>
        </Box>
      ) : rows.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>
            No files touched yet — the agent's reads, writes, and deletes will
            appear here as it works.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visibleRows.map((row, i) => {
            const idx = start + i;
            const isSelected = idx === clampedSelected;
            const label = packageFor(row.path);
            const known =
              row.insertions !== undefined || row.deletions !== undefined;
            return (
              <Box key={row.path} width={innerWidth}>
                <Text color={isSelected ? accent : undefined} bold={isSelected}>
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Box width={opsWidth}>
                  <Text>
                    <Text dimColor>[</Text>
                    {row.ops.map((op, j) => (
                      <Text key={op}>
                        {j > 0 ? <Text dimColor>,</Text> : null}
                        <Text color={opColors[op]} bold>
                          {op}
                        </Text>
                      </Text>
                    ))}
                    <Text dimColor>]</Text>
                  </Text>
                </Box>
                <Box width={labelWidth}>
                  <Text wrap="truncate-end">
                    {label.pkg ? (
                      <Text color={theme.violet} dimColor={!isSelected}>
                        {label.pkg}
                        {": "}
                      </Text>
                    ) : null}
                    <Text
                      color={isSelected ? accent : undefined}
                      bold={isSelected}
                    >
                      {label.display}
                    </Text>
                  </Text>
                </Box>
                <Box width={countsWidth} justifyContent="flex-end">
                  {known ? (
                    <Text>
                      <Text color={diffTheme.add}>+{row.insertions ?? 0}</Text>
                      <Text dimColor>/</Text>
                      <Text color={diffTheme.del}>-{row.deletions ?? 0}</Text>
                    </Text>
                  ) : (
                    <Text dimColor>—</Text>
                  )}
                </Box>
              </Box>
            );
          })}
        </Box>
      )}

      {armedPath ? (
        <Box marginTop={1}>
          <Text color={theme.amber} wrap="truncate-end">
            ctrl+o again to open {armedPath} in your editor
          </Text>
        </Box>
      ) : notice ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {notice}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {rows.length > MAX_VISIBLE_TOUCHED_FILES
            ? `${clampedSelected + 1}/${rows.length} · `
            : ""}
          ↑↓ navigate · ↵/→ diff · ctrl+o ctrl+o editor · r refresh · esc close
        </Text>
      </Box>
    </Box>
  );
}
