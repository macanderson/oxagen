/**
 * login-panel.tsx — the REPL's Ink-native `/login` panel.
 *
 * The one-shot `oxagen login` CLI defaults to a browser-based PKCE flow
 * (auth/loopback-login.ts) that needs zero typed input — the browser handles
 * auth, a loopback HTTP server on 127.0.0.1 receives the callback. That makes
 * it the right flow to drive from inside the REPL too: unlike the headless
 * `--token` paste fallback (which uses `node:readline` and would conflict
 * with Ink owning raw mode — see the architecture note in CLAUDE.md), the
 * browser flow only needs a status display and a way to cancel. No text
 * input, no readline, ever.
 *
 * Takes over the input row (same takeover pattern as ApprovalPrompt /
 * ConfigPanel): opens the browser, shows the fallback URL plus a spinner
 * while waiting for the loopback callback, and Esc cancels the pending wait.
 * On success the session is already persisted — `commands/auth.ts`'s
 * `runBrowserLogin` is the exact same persistence path `oxagen login` uses —
 * this component just reports the result and calls `onLoggedIn` so the REPL
 * can update its live session state (header display + AI port routing; see
 * interactive.tsx's `/login` handler and `handleLoggedIn`).
 */
import { Box, Text, useInput } from "ink";
import React, { useEffect, useRef, useState } from "react";
import { theme } from "../tui/theme.js";
import { SPINNER_FRAMES } from "../tui/activity.js";
import {
  runBrowserLogin,
  type InteractiveLoginResult,
} from "../commands/auth.js";

function maskToken(token: string): string {
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

export interface LoginPanelProps {
  onClose: () => void;
  /** Called once with the persisted session on a successful login. */
  onLoggedIn: (result: InteractiveLoginResult) => void;
  /** False while another surface (an approval prompt) owns the keyboard. */
  active?: boolean;
  width?: number;
}

type PanelState =
  | { kind: "running" }
  | { kind: "success"; result: InteractiveLoginResult }
  | { kind: "error"; message: string };

export function LoginPanel({
  onClose,
  onLoggedIn,
  active = true,
  width = 84,
}: LoginPanelProps): React.ReactElement {
  const [state, setState] = useState<PanelState>({ kind: "running" });
  const [lines, setLines] = useState<string[]>([]);
  const [frame, setFrame] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  // Guards against a double-invoke of the effect (React StrictMode / a parent
  // re-render before the browser tab is even opened) — the loopback flow
  // binds a real HTTP server and opens a real browser tab, so it must run
  // exactly once per panel mount, not once per render.
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    void (async () => {
      try {
        const result = await runBrowserLogin((line) => {
          setLines((prev) => [...prev, line]);
        }, controller.signal);
        setState({ kind: "success", result });
        onLoggedIn(result);
      } catch (err) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => controller.abort();
    // Deliberately empty: `onLoggedIn` is a stable callback from the parent,
    // and this effect must run exactly once per mount — it binds a real HTTP
    // server and opens a real browser tab, so re-running it on a parent
    // re-render would restart a live login flow (see `startedRef` above,
    // which also guards the same thing defensively).
  }, []);

  useEffect(() => {
    if (state.kind !== "running") return;
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      100,
    );
    return () => clearInterval(timer);
  }, [state.kind]);

  useInput(
    (_input, key) => {
      if (state.kind === "running") {
        if (key.escape) {
          controllerRef.current?.abort();
          onClose();
        }
        return;
      }
      // Login already finished (success or error) — any key dismisses.
      onClose();
    },
    { isActive: active },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.violet}
      paddingX={1}
      width={width}
    >
      <Box>
        <Text color={theme.violet} bold>
          {"⚿ login "}
        </Text>
        <Text dimColor>· browser-based PKCE — same flow as `oxagen login`</Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {lines.length === 0 ? (
          <Text dimColor>Starting…</Text>
        ) : (
          lines.map((line, i) => (
            <Text key={i} dimColor wrap="wrap">
              {line}
            </Text>
          ))
        )}
      </Box>

      {state.kind === "running" ? (
        <Box marginTop={1}>
          <Text color={theme.cyan}>{SPINNER_FRAMES[frame]}</Text>
          <Text dimColor> waiting for the browser callback… (esc cancels)</Text>
        </Box>
      ) : state.kind === "success" ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.green} bold>
            ✓ Logged in to Oxagen
          </Text>
          <Text dimColor>
            {`token: ${maskToken(state.result.token)}  org: ${state.result.orgSlug}  workspace: ${state.result.workspaceSlug}`}
          </Text>
          <Text dimColor>press any key to continue</Text>
        </Box>
      ) : (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.red} bold>
            {"✗ "}
            {state.message}
          </Text>
          <Text dimColor>press any key to close</Text>
        </Box>
      )}
    </Box>
  );
}
