"use client";
// The OAuth popup, as the wizard and a provider's Reconnect drive it (#4132).
//
// The popup is opened on the click, before the server is asked for the
// sign-in URL, because a browser blocks a window opened after an await. It
// shows a blank page for the moment the URL takes to arrive, then the
// provider's sign-in. If the browser blocked it anyway, the wizard offers the
// URL as a link, which is a fresh click and opens.
//
// The outcome arrives from the callback page on a BroadcastChannel and on
// `window.opener`, whichever survives the provider's opener policy, and is
// matched to this flow by its `state`.
import { useCallback, useEffect, useRef, useState } from "react";
import { type ProviderUrl, parseProviderUrl } from "@/shared/provider-url";
import { navigatePopup } from "@/ui/navigation";
import { MCP_OAUTH_CHANNEL, OAuthOutcome } from "./oauth-flow";
import {
  type AuthorizationDraft,
  startProviderAuthorization,
} from "./provider-auth-actions";
import type { ToolsAt } from "./view";

export type OAuthSuccess = {
  serverId: string;
  name: string;
  discoveredTools: readonly string[];
};

export type OAuthPhase =
  | { kind: "idle" }
  | { kind: "starting" }
  /** Waiting on the person in the popup. `blockedUrl` is set when no popup opened. */
  | { kind: "waiting"; blockedUrl: ProviderUrl | null }
  /** The server registers no clients: the workspace brings an OAuth app. */
  | { kind: "client_required"; scopes: string; redirectUrl: string }
  | { kind: "not_oauth" }
  /** A failure code: an ActionResult code or the callback's. */
  | { kind: "failed"; code: string };

const POPUP_FEATURES = "popup=yes,width=560,height=720";

export function useProviderOAuth(
  at: ToolsAt,
  onAuthorized: (done: OAuthSuccess) => void,
) {
  const [phase, setPhase] = useState<OAuthPhase>({ kind: "idle" });
  const pendingStateRef = useRef<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const doneRef = useRef(onAuthorized);
  useEffect(() => {
    doneRef.current = onAuthorized;
  }, [onAuthorized]);

  const settle = useCallback((raw: unknown) => {
    const parsed = OAuthOutcome.safeParse(raw);
    if (!parsed.success) return;
    const outcome = parsed.data;
    if (outcome.state !== pendingStateRef.current) return;
    pendingStateRef.current = null;
    popupRef.current?.close();
    popupRef.current = null;
    if (outcome.ok) {
      setPhase({ kind: "idle" });
      doneRef.current({
        serverId: outcome.serverId,
        name: outcome.name,
        discoveredTools: outcome.discoveredTools,
      });
    } else {
      setPhase({ kind: "failed", code: outcome.code });
    }
  }, []);

  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(MCP_OAUTH_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        settle(event.data);
      };
    } catch {
      channel = null;
    }
    // Only this origin's callback page is heard; `settle` checks the shape.
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.origin) return;
      settle(event.data);
    };
    window.addEventListener("message", onMessage);
    return () => {
      channel?.close();
      window.removeEventListener("message", onMessage);
    };
  }, [settle]);

  const start = useCallback(
    async (draft: AuthorizationDraft) => {
      let opened: Window | null = null;
      try {
        opened = window.open("about:blank", "oxagen-mcp-oauth", POPUP_FEATURES);
      } catch {
        opened = null;
      }
      popupRef.current = opened;
      setPhase({ kind: "starting" });
      const closeOpened = () => {
        opened?.close();
        popupRef.current = null;
      };
      try {
        const result = await startProviderAuthorization(at.org, at.ws, draft);
        if (!result.ok) {
          closeOpened();
          setPhase({
            kind: "failed",
            code: "code" in result ? result.code : result.reason,
          });
          return;
        }
        const out = result.value;
        switch (out.status) {
          case "redirect": {
            const target = parseProviderUrl(out.authorizationUrl);
            if (target === null) {
              closeOpened();
              setPhase({ kind: "failed", code: "authorization_url_invalid" });
              return;
            }
            pendingStateRef.current = out.state;
            if (opened !== null && !opened.closed) {
              navigatePopup(opened, target);
              setPhase({ kind: "waiting", blockedUrl: null });
            } else {
              setPhase({ kind: "waiting", blockedUrl: target });
            }
            return;
          }
          case "authorized":
            closeOpened();
            setPhase({ kind: "idle" });
            doneRef.current({
              serverId: out.serverId,
              name: draft.mode === "add" ? draft.name : "",
              discoveredTools: out.discoveredTools,
            });
            return;
          case "client_required":
            closeOpened();
            setPhase({
              kind: "client_required",
              scopes: out.scopesSupported.join(" "),
              redirectUrl: out.redirectUrl,
            });
            return;
          case "not_oauth":
            closeOpened();
            setPhase({ kind: "not_oauth" });
            return;
        }
      } catch {
        closeOpened();
        setPhase({ kind: "failed", code: "action_failed" });
      }
    },
    [at.org, at.ws],
  );

  const reset = useCallback(() => {
    pendingStateRef.current = null;
    popupRef.current?.close();
    popupRef.current = null;
    setPhase({ kind: "idle" });
  }, []);

  return { phase, start, reset };
}
