/**
 * diff-panel.tsx — the `/diff` interactive panel.
 *
 * Shown in place of the prompt input (same takeover pattern as ConfigPanel):
 * a keyboard-navigable review of the working tree's changes vs HEAD. Two modes
 * in one component:
 *
 *   • List mode — every changed file with its status char and +/- line counts.
 *     ↑/↓ move (wrapping), Enter/→ open the diff, `r` refresh, Esc close.
 *
 *   • Diff mode — the selected file's unified diff, syntax-highlighted with an
 *     old/new line-number gutter. ↑/↓ scroll a line, PgUp/PgDn a page, ^U/^D a
 *     half page, g/G jump to top/bottom, [ / ] / Tab cycle files, ←/Esc back to
 *     the list. Scrolling is line-exact: we parse the diff once and render only
 *     the visible slice, rather than handing the whole thing to DiffView.
 *
 * git work (listing files, loading a diff) is subprocess-backed (git-diff.ts)
 * and async — a mounted/request guard drops any result that resolves after the
 * panel unmounts or the user switches files. The `listFiles`/`loadDiff` props
 * are test seams (mirroring ConfigPanel's `resolveOpts`) so tests inject canned
 * git data without spawning subprocesses. While mounted, interactive.tsx's
 * central useInput yields the keyboard entirely (diffOpenRef gate).
 */
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
import {
  parseDiffLines,
  numberDiffLines,
  computeGutterWidths,
  languageForPath,
  resolveHighlightTheme,
  DiffLineRow,
} from "./diff-view.js";
import { resolveGitInfo } from "./git-info.js";
import { listChangedFiles, getFileDiff, type ChangedFile } from "./git-diff.js";
import { visibleWindow } from "./slash-menu.js";

/** Max file rows shown at once in list mode; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_DIFF_FILES = 12;

/** Per-status display color for the list's leading status char. */
const STATUS_COLOR: Record<string, string> = {
  M: theme.amber,
  A: theme.green,
  "?": theme.green,
  D: theme.red,
  R: theme.cyan,
  C: theme.cyan,
};

export interface DiffPanelProps {
  cwd: string;
  onClose: () => void;
  /** False while another surface owns the keyboard; the panel stays visible but ignores keys. */
  active?: boolean;
  width?: number;
  /** Max diff-body rows rendered at once in diff mode (the scroll window height). */
  maxBodyRows?: number;
  /** Open straight into this file's diff (suffix-matched); falls back to the list with a notice. */
  initialPath?: string;
  /** Test seam: list the working tree's changed files. */
  listFiles?: typeof listChangedFiles;
  /** Test seam: load a single file's diff. */
  loadDiff?: typeof getFileDiff;
}

type Mode = "list" | "diff";

/** Does `path` end with `needle` at a path boundary (exact, or `.../needle`)? */
function pathMatches(path: string, needle: string): boolean {
  return (
    path === needle || path.endsWith("/" + needle) || path.endsWith(needle)
  );
}

export function DiffPanel({
  cwd,
  onClose,
  active = true,
  width = 84,
  maxBodyRows = 20,
  initialPath,
  listFiles = listChangedFiles,
  loadDiff = getFileDiff,
}: DiffPanelProps): React.ReactElement {
  const gitInfo = useMemo(() => resolveGitInfo(cwd), [cwd]);
  const root = gitInfo?.root ?? cwd;
  const branch = gitInfo?.branch;

  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [ready, setReady] = useState(false);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [diffText, setDiffText] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  // Drops async results that resolve after unmount, and (via diffReq) after the
  // user has switched to a different file's diff.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const diffReqRef = useRef(0);

  const diffTheme = useMemo(() => diffThemeFor(detectTerminalBackground()), []);
  const hlTheme = useMemo(
    () => resolveHighlightTheme(diffTheme.highlightjs),
    [diffTheme],
  );

  /** Load (or reload) the changed-file list. */
  const refresh = useCallback(async (): Promise<ChangedFile[]> => {
    const list = await listFiles(root);
    if (!mountedRef.current) return list;
    setFiles(list);
    setReady(true);
    setSelected((s) => Math.min(s, Math.max(0, list.length - 1)));
    return list;
  }, [listFiles, root]);

  /** Enter diff mode for `list[index]` and load its diff under a fresh request id. */
  const openDiff = useCallback(
    async (list: ChangedFile[], index: number): Promise<void> => {
      const file = list[index];
      if (!file) return;
      const reqId = ++diffReqRef.current;
      setSelected(index);
      setMode("diff");
      setScrollTop(0);
      setDiffText(null);
      const text = await loadDiff(root, file);
      if (!mountedRef.current || diffReqRef.current !== reqId) return;
      setDiffText(text);
    },
    [loadDiff, root],
  );

  // Initial load: list the files, then optionally jump straight into initialPath.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const list = await listFiles(root);
      if (cancelled || !mountedRef.current) return;
      setFiles(list);
      setReady(true);
      if (initialPath) {
        const idx = list.findIndex((f) => pathMatches(f.path, initialPath));
        if (idx >= 0) {
          await openDiff(list, idx);
        } else {
          setNotice(
            `No changed file matches "${initialPath}" — showing the full list.`,
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // openDiff/listFiles/root/initialPath are stable for the panel's lifetime.
  }, [initialPath, listFiles, openDiff, root]);

  const numberedLines = useMemo(() => {
    if (diffText === null || diffText.trim() === "") return [];
    return numberDiffLines(parseDiffLines(diffText));
  }, [diffText]);
  const gutter = useMemo(
    () => computeGutterWidths(numberedLines),
    [numberedLines],
  );

  const total = numberedLines.length;
  const maxTop = Math.max(0, total - maxBodyRows);

  const cycleFile = useCallback(
    (delta: number): void => {
      if (files.length === 0) return;
      const next = (selected + delta + files.length) % files.length;
      void openDiff(files, next);
    },
    [files, selected, openDiff],
  );

  useInput(
    (input, key) => {
      if (mode === "list") {
        if (key.escape) {
          onClose();
          return;
        }
        if (files.length === 0) return;
        if (key.upArrow) {
          setSelected((s) => (s - 1 + files.length) % files.length);
          return;
        }
        if (key.downArrow) {
          setSelected((s) => (s + 1) % files.length);
          return;
        }
        if (input === "r") {
          setNotice("refreshing…");
          void refresh().then(() => {
            if (mountedRef.current) setNotice(null);
          });
          return;
        }
        if (key.return || key.rightArrow) {
          void openDiff(files, selected);
        }
        return;
      }

      // diff mode
      if (key.escape || key.leftArrow) {
        setMode("list");
        return;
      }
      if (key.tab || input === "]") {
        cycleFile(1);
        return;
      }
      if (input === "[") {
        cycleFile(-1);
        return;
      }
      if (key.ctrl && input === "u") {
        setScrollTop((t) => Math.max(0, t - Math.floor(maxBodyRows / 2)));
        return;
      }
      if (key.ctrl && input === "d") {
        setScrollTop((t) => Math.min(maxTop, t + Math.floor(maxBodyRows / 2)));
        return;
      }
      if (key.upArrow) {
        setScrollTop((t) => Math.max(0, t - 1));
        return;
      }
      if (key.downArrow) {
        setScrollTop((t) => Math.min(maxTop, t + 1));
        return;
      }
      if (key.pageUp) {
        setScrollTop((t) => Math.max(0, t - maxBodyRows));
        return;
      }
      if (key.pageDown) {
        setScrollTop((t) => Math.min(maxTop, t + maxBodyRows));
        return;
      }
      // Home/End aren't surfaced as Ink key flags; g/G are the top/bottom jumps.
      if (input === "g") {
        setScrollTop(0);
        return;
      }
      if (input === "G") {
        setScrollTop(maxTop);
      }
    },
    { isActive: active },
  );

  const innerWidth = Math.max(width - 4, 20);

  if (mode === "diff") {
    const file = files[selected];
    const language = file ? languageForPath(file.path) : undefined;
    const clampedTop = Math.min(scrollTop, maxTop);
    const visible = numberedLines.slice(clampedTop, clampedTop + maxBodyRows);
    const from = total === 0 ? 0 : clampedTop + 1;
    const to = Math.min(total, clampedTop + maxBodyRows);

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.cyan}
        paddingX={1}
        width={width}
      >
        <Box>
          <Text color={theme.cyan} bold>
            {"± "}
            {file?.path ?? "(no file)"}{" "}
          </Text>
          <Text dimColor>
            · {selected + 1}/{files.length}
          </Text>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          {diffText === null ? (
            <Text dimColor>loading…</Text>
          ) : total === 0 ? (
            <Text dimColor>(binary or empty diff)</Text>
          ) : (
            visible.map((line, i) => (
              <DiffLineRow
                key={clampedTop + i}
                line={line}
                theme={diffTheme}
                language={language}
                hlTheme={hlTheme}
                gutter={gutter}
              />
            ))
          )}
        </Box>

        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            ↑↓ scroll · PgUp/PgDn page · ^U/^D half · g/G top/bottom · [ ] Tab
            file · ← back
            {total > 0 ? ` · line ${from}–${to} of ${total}` : ""}
          </Text>
        </Box>
      </Box>
    );
  }

  // list mode
  const { start, end } = visibleWindow(
    files.length,
    selected,
    MAX_VISIBLE_DIFF_FILES,
  );
  const visibleFiles = files.slice(start, end);
  const countsWidth = 12;
  const pathWidth = Math.max(innerWidth - 2 - 2 - countsWidth, 10); // pointer(2) + status(2)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.cyan}
      paddingX={1}
      width={width}
    >
      <Box>
        <Text color={theme.cyan} bold>
          {"± changes "}
        </Text>
        {branch ? <Text dimColor>· {branch}</Text> : null}
      </Box>

      {!ready ? (
        <Box marginTop={1}>
          <Text dimColor>loading…</Text>
        </Box>
      ) : files.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>Working tree clean — no changes vs HEAD.</Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {visibleFiles.map((file, i) => {
            const idx = start + i;
            const isSelected = idx === selected;
            const statusColor = STATUS_COLOR[file.status] ?? theme.dim;
            const known =
              file.insertions !== undefined || file.deletions !== undefined;
            return (
              <Box key={file.path} width={innerWidth}>
                <Text
                  color={isSelected ? theme.cyan : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Box width={2}>
                  <Text color={statusColor} bold>
                    {file.status}
                  </Text>
                </Box>
                <Box width={pathWidth}>
                  <Text
                    color={isSelected ? theme.cyan : undefined}
                    bold={isSelected}
                    wrap="truncate-end"
                  >
                    {file.path}
                  </Text>
                </Box>
                <Box width={countsWidth} justifyContent="flex-end">
                  {known ? (
                    <Text>
                      <Text color={theme.green}>+{file.insertions ?? 0}</Text>
                      <Text dimColor>/</Text>
                      <Text color={theme.red}>-{file.deletions ?? 0}</Text>
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

      {notice ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {notice}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor>
          {files.length > MAX_VISIBLE_DIFF_FILES
            ? `${selected + 1}/${files.length} · `
            : ""}
          ↑↓ navigate · ↵/→ view diff · r refresh · esc close
        </Text>
      </Box>
    </Box>
  );
}
