/**
 * marketplace-panel.tsx — the `/marketplace` browser.
 *
 * A takeover panel that browses the plugin marketplace through an injected
 * {@link MarketplaceClient} (a parallel agent builds the real client; the
 * integrator adapts the live `browse`/`install` capability to this local
 * interface — these exported types are the contract). Two views in one
 * component:
 *
 *   • List — a type-filter tab row (All / MCP / Skills / Agents / Knowledge /
 *     Integrations; ←/→ or Tab cycles), a `/`-focused search line (debounced),
 *     ↑/↓ selection, `i` to install the highlighted entry, `n`/`p` (or
 *     PageDown/PageUp) to page when the result set is larger than one page.
 *   • Detail — the highlighted entry expanded: full description, categories,
 *     version, install state, and an inline install with pending + result
 *     notice. Esc/← steps back to the list.
 *
 * Browsing is async and request-guarded: a stale in-flight `browse` that
 * resolves after the filters changed (or the panel unmounted) is dropped. A
 * rejected `browse` surfaces a readable error with `r` to retry.
 */
import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { theme } from "../tui/theme.js";
import { visibleWindow } from "./slash-menu.js";

/** Max entry rows shown at once; the window scrolls to keep the selection visible. */
export const MAX_VISIBLE_PLUGINS = 10;

/** Default result-page size requested from the client. */
export const MARKETPLACE_PAGE_SIZE = 30;

/** Default search debounce (ms) — one browse per settled query, not per keystroke. */
export const MARKETPLACE_DEBOUNCE_MS = 250;

/** The five plugin kinds the marketplace serves. */
export type MarketplacePluginType =
  | "mcp_server"
  | "agent_capability"
  | "agent_skill"
  | "knowledge_source"
  | "integration";

/** One marketplace catalog entry — the local shape the panel renders against. */
export interface MarketplaceEntry {
  id: string;
  name: string;
  title?: string;
  description: string;
  pluginType: MarketplacePluginType;
  version: string;
  installed: boolean;
  categories: string[];
}

/** Filter/paging options passed to the client's `browse`. */
export interface MarketplaceBrowseOptions {
  pluginType?: MarketplacePluginType;
  search?: string;
  limit?: number;
  offset?: number;
}

/** A page of browse results. `nextOffset` is null when there is no next page. */
export interface MarketplaceBrowseResult {
  entries: MarketplaceEntry[];
  total: number;
  nextOffset: number | null;
}

/** The seam the panel drives — the integrator adapts the live capability to it. */
export interface MarketplaceClient {
  browse(opts: MarketplaceBrowseOptions): Promise<MarketplaceBrowseResult>;
  install(id: string): Promise<{ ok: boolean; error?: string }>;
}

/** The tab row — each tab narrows the browse to one plugin type (All = every type). */
interface MarketplaceTab {
  label: string;
  type?: MarketplacePluginType;
}
export const MARKETPLACE_TABS: readonly MarketplaceTab[] = [
  { label: "All" },
  { label: "MCP", type: "mcp_server" },
  { label: "Skills", type: "agent_skill" },
  { label: "Agents", type: "agent_capability" },
  { label: "Knowledge", type: "knowledge_source" },
  { label: "Integrations", type: "integration" },
];

/** Short human label for a plugin type — the per-row badge. */
export function pluginTypeLabel(type: MarketplacePluginType): string {
  switch (type) {
    case "mcp_server":
      return "mcp";
    case "agent_capability":
      return "agent";
    case "agent_skill":
      return "skill";
    case "knowledge_source":
      return "knowledge";
    case "integration":
      return "integration";
  }
}

export interface MarketplacePanelProps {
  /** False while another surface owns the keyboard; the panel ignores keys. */
  active?: boolean;
  onClose: () => void;
  width?: number;
  /** Data seam — browse + install. Must be referentially stable across renders. */
  client: MarketplaceClient;
  /** Test seam: search debounce window. */
  debounceMs?: number;
}

export function MarketplacePanel({
  active = true,
  onClose,
  width = 84,
  client,
  debounceMs = MARKETPLACE_DEBOUNCE_MS,
}: MarketplacePanelProps): React.ReactElement {
  const [tab, setTab] = useState(0);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [offset, setOffset] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);

  const [entries, setEntries] = useState<MarketplaceEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [view, setView] = useState<"list" | "detail">("list");
  const [installing, setInstalling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const reqRef = useRef(0);

  // Debounce the search box: one browse per settled query, and reset to page 1
  // whenever the query changes so results don't land on a stale offset.
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(search);
      setOffset(0);
    }, debounceMs);
    return () => clearTimeout(t);
  }, [search, debounceMs]);

  // Browse whenever the filters, page, or a manual reload change. Request-guarded
  // so a stale resolution (filters moved on, or unmounted) is dropped.
  useEffect(() => {
    const reqId = ++reqRef.current;
    setLoading(true);
    setError(null);
    Promise.resolve(
      client.browse({
        ...(MARKETPLACE_TABS[tab]?.type
          ? { pluginType: MARKETPLACE_TABS[tab]!.type }
          : {}),
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
        limit: MARKETPLACE_PAGE_SIZE,
        offset,
      }),
    )
      .then((res) => {
        if (!mountedRef.current || reqRef.current !== reqId) return;
        setEntries(res.entries);
        setTotal(res.total);
        setNextOffset(res.nextOffset);
        setSelected(0);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!mountedRef.current || reqRef.current !== reqId) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [client, tab, debouncedSearch, offset, reloadNonce]);

  const clampedSelected = Math.min(selected, Math.max(0, entries.length - 1));
  const current = entries[clampedSelected];

  function cycleTab(delta: number): void {
    setTab(
      (t) => (t + delta + MARKETPLACE_TABS.length) % MARKETPLACE_TABS.length,
    );
    setOffset(0);
  }

  function nextPage(): void {
    if (nextOffset !== null) setOffset(nextOffset);
  }

  function prevPage(): void {
    if (offset > 0) setOffset(Math.max(0, offset - MARKETPLACE_PAGE_SIZE));
  }

  function retry(): void {
    setReloadNonce((n) => n + 1);
  }

  function install(): void {
    if (!current || installing) return;
    const entry = current;
    setInstalling(true);
    setNotice(`installing ${entry.name}…`);
    Promise.resolve(client.install(entry.id))
      .then((res) => {
        if (!mountedRef.current) return;
        if (res.ok) {
          setNotice(`installed ${entry.name}`);
          setReloadNonce((n) => n + 1); // re-browse so the installed flag flips
        } else {
          setNotice(res.error ?? `could not install ${entry.name}`);
        }
      })
      .catch((err: unknown) => {
        if (!mountedRef.current) return;
        setNotice(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (mountedRef.current) setInstalling(false);
      });
  }

  // List navigation — inactive while the search box or the detail view own keys.
  useInput(
    (input, key) => {
      if (key.escape) {
        onClose();
        return;
      }
      if (input === "/") {
        setSearchFocused(true);
        return;
      }
      if (key.leftArrow) {
        cycleTab(-1);
        return;
      }
      if (key.rightArrow || key.tab) {
        cycleTab(1);
        return;
      }
      if (input === "r") {
        retry();
        return;
      }
      if (input === "n" || key.pageDown) {
        nextPage();
        return;
      }
      if (input === "p" || key.pageUp) {
        prevPage();
        return;
      }
      if (entries.length === 0) return;
      if (key.upArrow) {
        setSelected((clampedSelected - 1 + entries.length) % entries.length);
        return;
      }
      if (key.downArrow) {
        setSelected((clampedSelected + 1) % entries.length);
        return;
      }
      if (key.return) {
        if (current) setView("detail");
        return;
      }
      if (input === "i") {
        install();
      }
    },
    { isActive: active && view === "list" && !searchFocused },
  );

  // Search box — captures typing while focused; Esc/Enter hand keys back.
  useInput(
    (input, key) => {
      if (key.escape || key.return) {
        setSearchFocused(false);
        return;
      }
      if (key.backspace || key.delete) {
        setSearch((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearch((s) => s + input);
      }
    },
    { isActive: active && searchFocused },
  );

  // Detail view — Esc/← steps back; `i` still installs the shown entry.
  useInput(
    (input, key) => {
      if (key.escape || key.leftArrow) {
        setView("list");
        return;
      }
      if (input === "i") {
        install();
      }
    },
    { isActive: active && view === "detail" },
  );

  const innerWidth = Math.max(width - 4, 20);
  const pageStart = entries.length === 0 ? 0 : offset + 1;
  const pageEnd = offset + entries.length;

  // Detail view.
  if (view === "detail" && current) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={theme.cyan}
        paddingX={1}
        width={width}
      >
        <Box gap={1}>
          <Text color={theme.cyan} bold wrap="truncate-end">
            {current.title ?? current.name}
          </Text>
          <Text color={theme.violet}>
            [{pluginTypeLabel(current.pluginType)}]
          </Text>
        </Box>
        <Box marginTop={1} flexDirection="column" width={innerWidth}>
          <Box gap={1}>
            <Text dimColor>id</Text>
            <Text>{current.name}</Text>
            <Text dimColor>·</Text>
            <Text dimColor>v{current.version}</Text>
            <Text dimColor>·</Text>
            {current.installed ? (
              <Text color={theme.green}>installed</Text>
            ) : (
              <Text dimColor>not installed</Text>
            )}
          </Box>
          {current.categories.length > 0 ? (
            <Box marginTop={1}>
              <Text dimColor wrap="truncate-end">
                {current.categories.join(" · ")}
              </Text>
            </Box>
          ) : null}
          <Box marginTop={1}>
            <Text wrap="wrap">{current.description}</Text>
          </Box>
        </Box>
        {notice ? (
          <Box marginTop={1}>
            <Text dimColor wrap="truncate-end">
              {notice}
            </Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text dimColor>
            {current.installed ? "" : "i install · "}esc/← back to the list
          </Text>
        </Box>
      </Box>
    );
  }

  // List view.
  const { start, end } = visibleWindow(
    entries.length,
    clampedSelected,
    MAX_VISIBLE_PLUGINS,
  );
  const visible = entries.slice(start, end);

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
          {"Marketplace "}
        </Text>
        <Text dimColor>· {total} plugins</Text>
      </Box>

      {/* Type-filter tabs. */}
      <Box marginTop={1} gap={1}>
        {MARKETPLACE_TABS.map((t, i) => {
          const isActive = i === tab;
          return (
            <Text
              key={t.label}
              color={isActive ? theme.cyan : undefined}
              bold={isActive}
              dimColor={!isActive}
            >
              {isActive ? `[${t.label}]` : ` ${t.label} `}
            </Text>
          );
        })}
      </Box>

      {/* Search line. */}
      <Box marginTop={1} width={innerWidth}>
        <Text color={searchFocused ? theme.cyan : theme.dim}>{"search "}</Text>
        <Text>
          {search || (searchFocused ? "" : "")}
          {searchFocused ? <Text color={theme.cyan}>█</Text> : null}
        </Text>
        {!search && !searchFocused ? <Text dimColor>/ to search</Text> : null}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {loading && entries.length === 0 ? (
          <Text dimColor>loading…</Text>
        ) : error ? (
          <Box flexDirection="column">
            <Text color={theme.red} wrap="truncate-end">
              {error}
            </Text>
            <Text dimColor>press r to retry</Text>
          </Box>
        ) : entries.length === 0 ? (
          <Text dimColor>No plugins match this filter.</Text>
        ) : (
          visible.map((entry, i) => {
            const idx = start + i;
            const isSelected = idx === clampedSelected;
            return (
              <Box key={entry.id} width={innerWidth}>
                <Text
                  color={isSelected ? theme.cyan : undefined}
                  bold={isSelected}
                >
                  {isSelected ? "❯ " : "  "}
                </Text>
                <Box width={13}>
                  <Text
                    color={theme.violet}
                    dimColor={!isSelected}
                    wrap="truncate-end"
                  >
                    [{pluginTypeLabel(entry.pluginType)}]
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text
                    color={isSelected ? theme.cyan : undefined}
                    bold={isSelected}
                    wrap="truncate-end"
                  >
                    {entry.title ?? entry.name}
                  </Text>
                </Box>
                <Box marginLeft={1}>
                  {entry.installed ? (
                    <Text color={theme.green}>✓ installed</Text>
                  ) : (
                    <Text dimColor>v{entry.version}</Text>
                  )}
                </Box>
              </Box>
            );
          })
        )}
      </Box>

      {notice ? (
        <Box marginTop={1}>
          <Text dimColor wrap="truncate-end">
            {notice}
          </Text>
        </Box>
      ) : null}

      <Box marginTop={1}>
        <Text dimColor wrap="truncate-end">
          {entries.length > 0 ? `${pageStart}–${pageEnd} of ${total} · ` : ""}
          ↑↓ select · ↵ details · i install · / search · ←→ type
          {nextOffset !== null || offset > 0 ? " · n/p page" : ""} · esc close
        </Text>
      </Box>
    </Box>
  );
}
