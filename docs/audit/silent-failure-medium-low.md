# Silent Failure Audit — Medium & Low findings (for ticketing)

Source: `silent-failure-sweep` multi-agent workflow, 2026-06-20. Critical + High are being fixed directly on branch `fix/silent-failures-critical-high`. This file tracks the remaining lower-severity work.

- **Medium (verified):** 30
- **Low (verified):** 18
- **Low flags (unverified leads):** 27

## Medium severity

### M1. `apps/api/src/routes/v1/chat.stream.ts:417`  — `bad-fallback`

- **What's wrong:** `loadWorkspacePromptConfig` failure returns an empty object `{}`, meaning any error — DB failure, invalid config, missing row — silently degrades to the baseline system prompt with no log, no metric, no error event emitted to the SSE stream.
- **Impact:** Workspace-level prompt customizations are silently ignored on any config load failure. Operators have no way to detect that `prompt.settings.write` changes are not taking effect. If the config store breaks, all workspaces fall back to the default prompt with no visibility.

  ```ts
  loadWorkspacePromptConfig(ctx.workspaceId).catch(() => ({}))
  ```

### M2. `apps/app/src/app/[orgSlug]/[workspaceSlug]/_shared/conversation-page.tsx:206`  — `bad-fallback`

- **What's wrong:** The conversation history list for the nav panel swallows all errors with .catch(() => ({ conversations: [], nextCursor: null })). DB failures, RLS violations, and capability errors all silently produce an empty conversation list.
- **Impact:** When the DB is degraded or RLS is misconfigured, users see an empty conversation history on the chat page with no indication that their history failed to load. They may believe their past conversations were deleted. No error is logged with the failure context.

  ```ts
  runInTenantScope(
          { orgId: tenant.id, workspaceId: workspace.id },
          () => conversationListHandler({ filter: "active", limit: 50, cursor: null }, userCtx),
        ).catch(() => ({ conversations: [], nextCursor: null })),
  ```

### M3. `apps/app/src/app/api/v1/chat/stream/route.ts:167`  — `swallowed-catch`

- **What's wrong:** The IDOR membership gate (assertOrgMember) and the org/workspace resolution are in the same catch block. A DB failure during assertOrgMember is indistinguishable from a legitimate 404, and a real authorization failure (assertOrgMember calling notFound()) also produces only a generic 404 with no server-side log entry.
- **Impact:** A transient DB error during the membership check causes the route to return 404 to the user as if they are not a member, silently dropping a valid request. Conversely, if resolveOrg or assertOrgMember throw for unexpected reasons, the error is also silently discarded with no server-side logging, making diagnosis impossible.

  ```ts
  try {
      tenant = await resolveOrg(orgSlug);
      await assertOrgMember(tenant.id, session.user.id);
      workspace = await resolveWorkspace(tenant.id, workspaceSlug);
    } catch {
      return NextResponse.json({ error: "Org or workspace not found" }, { status: 404 });
    }
  ```

### M4. `apps/app/src/components/billing/auto-reload-settings.tsx:137`  — `missing-propagation`

- **What's wrong:** The try block has no catch clause. If `updateAutoReloadAction` throws an exception (network error, server crash), the exception propagates uncaught from an async event handler — it becomes an unhandled promise rejection. The `finally` block still runs (spinner stops), but there is no error toast and no user feedback.
- **Impact:** A network failure or server error during auto-reload save silently resets the button to 'Save' with no error message. The user thinks the action failed softly but has no confirmation. This is a billing configuration path — a user may believe auto-reload is disabled/enabled when the opposite is true.

  ```ts
  try {
    const result = await updateAutoReloadAction({
      ...
    });
    if ("error" in result && result.error) {
      toast.add({ title: "Save failed", description: result.error, type: "error" });
    } else {
      toast.add({ title: "Auto-reload settings saved", type: "success" });
    }
  } finally {
    setSaving(false);
  }
  ```

### M5. `apps/app/src/components/chat/registry-components/research-swarm-card.tsx:165`  — `swallowed-catch`

- **What's wrong:** The swarm polling catch block silently retries on all errors with no error state update to the UI. When MAX_POLLS (180 polls = ~6 minutes) is exhausted the polling simply stops — the card remains frozen at whatever intermediate state it was in with no indication of failure.
- **Impact:** If polling fails permanently (e.g. the swarm API is down, or the swarm_id is invalid), the card is stuck at 0% indefinitely for up to 6 minutes, then silently freezes. The user cannot distinguish a stuck swarm from a genuinely slow one. No terminal error is shown even after all retries are exhausted.

  ```ts
  } catch {
          // Transient (the fan-out row may not be queryable for a beat after
          // dispatch, or a network blip). Back off and retry until the ceiling.
          if (!cancelled && polls < MAX_POLLS) {
            timer = setTimeout(() => void poll(), POLL_INTERVAL_MS * 2);
          }
        }
  ```

### M6. `apps/app/src/components/knowledge/sources/knowledge-sources-client.tsx:347`  — `swallowed-catch`

- **What's wrong:** Resync failures (both HTTP errors and network exceptions) are logged to the console but no toast or visible error is shown to the user. The UI shows a 'syncing' spinner for 3 seconds then silently clears it as if nothing happened, regardless of whether the resync actually started.
- **Impact:** A user clicking 're-sync' after an error or auth-required state has no way to know the resync was rejected. The connection status stays stale. Console.error is only visible to developers — not captured by the platform's ClickHouse observability pipeline and not surfaced to the user.

  ```ts
  if (!res.ok) {
    console.error("Resync failed:", await res.text());
  }
  ...
  } catch (e) {
    console.error("Resync error:", e);
  }
  ```

### M7. `apps/app/src/components/plugins/plugin-detail-panel.tsx:68`  — `bad-fallback`

- **What's wrong:** The catalog detail fetch does not check `r.ok` before calling `r.json()`. A 404, 403, or 500 response body is parsed directly as a `CatalogDetail` object. If the error response is not valid JSON, the `.catch` branch fires. If it happens to be JSON (e.g. a standard error envelope `{error: '...'}`) it is silently cast and rendered as plugin detail with undefined/missing fields.
- **Impact:** A 404 response that returns JSON (e.g. `{"error":"not found"}`) will be treated as a valid `CatalogDetail`, causing the panel to render with mostly undefined fields. The 'Install' button may be enabled for a non-existent plugin, and installing it will fail with an opaque error.

  ```ts
  .then((r) => r.json() as Promise<CatalogDetail>)
  .then((d) => {
    setDetail(d);
    setLoading(false);
  })
  ```

### M8. `packages/agent/src/handlers/agent.subagent.cancel.ts:28`  — `silent-default`

- **What's wrong:** The cancel handler deliberately maps 'cancel' operations to 'timed_out' (fanout) and 'failed' (runs) because the DB CHECK constraints do not include 'cancelled'. This is documented in the file-level comment, but it means agent.subagent.aggregate.deriveAggregateStatus() will report a cancelled fanout as 'timed_out' and cancelled runs as 'failed', making them indistinguishable from genuine timeout/failure events.
- **Impact:** The aggregate handler's status derivation returns 'timed_out' or 'failed' for user-cancelled fanouts. Downstream callers (and the user) cannot distinguish 'I cancelled it' from 'it failed/timed out'. ClickHouse telemetry records 'failed' events for intentional cancellations, inflating the failure rate metric. The comment documents this but the misclassification is permanent until a migration is applied.

  ```ts
  const FANOUT_CANCEL_STATUS = "timed_out" as const;
  const RUN_CANCEL_STATUS = "failed" as const;
  ```

### M9. `packages/agent/src/runtime/approval.ts:39`  — `missing-propagation`

- **What's wrong:** ensureListener() sets listenerStarted = true only AFTER the listenSql.listen() call. However if listenSql.listen() throws (e.g. DB unreachable, auth failure, max_connections exceeded), listenerStarted remains false and the error propagates to the waitForApproval caller — so far correct. But the partially-created listenSql postgres client instance leaks (it was constructed on line 44 before the throw), and a subsequent call to ensureListener() will create a second connection, potentially accumulating leaked connections on repeated failures.
- **Impact:** On repeated approval calls during a DB connectivity issue, each call that reaches ensureListener() leaks a postgres connection object. Under sustained load this can exhaust the connection pool or hit max_connections, causing the DB to refuse further connections. The leaked connections do not appear in normal pool monitoring.

  ```ts
  async function ensureListener(): Promise<void> {
    if (listenerStarted) return;
    ...
    listenerStarted = true;
  }
  ```

### M10. `packages/agent/src/runtime/materialize-tools.ts:460`  — `swallowed-catch`

- **What's wrong:** recordConsent() failure is entirely swallowed with no log at any level. The consent persistence is called with .catch(() => { /* ... */ }), so a persistent DB error (schema missing, connection exhaustion, constraint violation) produces no log entry, no metric, and no observable signal.
- **Impact:** If the mcp_consents upsert fails persistently, the user is re-prompted for consent on every single MCP tool invocation — indefinitely. Each re-prompt creates a new approval_requests row and blocks the agent turn. The accumulation of stale approval rows is invisible to ops. Because there is no log, this failure mode cannot be distinguished from 'user has never granted consent' by any monitoring system.

  ```ts
  ).catch(() => {
                  /* a failed grant write must not crash the turn — re-prompt next time */
                });
  ```

### M11. `packages/agent/src/runtime/materialize-tools.ts:349`  — `swallowed-catch`

- **What's wrong:** When a PluginTypeContributor's contributeTools() throws (e.g. the DB is unreachable at the start of a turn, or the MCP client list throws), the catch logs at error level and leaves 'contributed' as []. Execution continues as if the contributor produced no tools. No error is propagated to the caller or the model.
- **Impact:** The agent's tool set is silently incomplete for that turn. If the MCP contributor throws during a DB outage, all external MCP tools disappear from the model's available tools with no user-visible signal — the agent silently operates in a degraded state and cannot call any external tool. The user only notices when tool calls fail or the model states it cannot complete the task.

  ```ts
  } catch (err) {
        logger.error({ pluginType: contributor.type, err }, "plugin type contributor failed");
      }
  ```

### M12. `packages/ai/src/stream.ts:238`  — `bad-fallback`

- **What's wrong:** All three token-count fields default to 0 via `?? 0`. If the AI SDK's `totalUsage` object is present but has null/undefined fields (e.g. a provider that does not report usage in certain error paths, or an SDK version that renames the field), both the ClickHouse telemetry row and the credit charge (`chargeUsageCredits`) silently compute $0 cost. The org is billed 0 credits for the turn.
- **Impact:** The LLM call succeeds, the user gets a response, but the org is not charged and the `token_usage` row records zero cost. This is a revenue leak on every turn where the provider omits usage. The pattern is the same in `generate-object.ts` (lines 119-124) and would affect structured-output calls identically.

  ```ts
  const inputTokens = event.totalUsage.inputTokens ?? 0;
        const outputTokens = event.totalUsage.outputTokens ?? 0;
        const cachedTokens = event.totalUsage.cachedInputTokens ?? 0;
        const costUsdMicros = providerCostUsdMicros(usage);
  ```

### M13. `packages/billing/src/subscriptions.ts:660`  — `empty-catch`

- **What's wrong:** Bare `catch {}` in `previewPlanChange` swallows ANY error from `resolveCustomerId` or `resolveDefaultCard`, not just the expected "no customer yet" case. A transient Stripe API error, DB connectivity failure, or programming mistake will all silently map to `card: null`, indistinguishable from a legitimate first-time user.
- **Impact:** A Stripe timeout or DB outage during plan-change preview silently returns `card: null` to the UI. The upgrade-confirm screen shows "no card on file" when the customer actually has one, causing them to abort a legitimate upgrade or add a duplicate card.

  ```ts
  } catch {
        // No customer yet — no card on file.
      }
  ```

### M14. `packages/config/src/env.ts:236`  — `silent-default`

- **What's wrong:** The JSDoc comment on normalizeEnv explicitly promises: "(b) warn once, listing exactly what was stripped, so a legitimately-quoted value isn't silently mutated." The implementation builds the `stripped` array but never reads it — no console.warn, no logger call, no throw. The mutation of env values is completely silent. An operator who pastes a legitimately-quoted value (e.g. a password containing surrounding quotes as part of its content) will have the quotes stripped without any indication that this happened.
- **Impact:** If an env var's true value happens to start and end with double-quotes (e.g. a password like `"secret"`) it will be silently rewritten to `secret` at every boot. Authentication or connection failures will occur with no log entry pointing to the env normalization step as the cause, making the root cause extremely hard to diagnose. Additionally, operators have no visibility into which env vars were modified during startup normalization.

  ```ts
  export function normalizeEnv(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = {};
    const stripped: string[] = [];
    for (const [key, value] of Object.entries(source)) {
      if (KNOWN_ENV_KEYS.has(key) && typeof value === "string") {
        const stripped_value = stripOneQuotePair(value);
        if (stripped_value !== value) {
          out[key] = stripped_value;
          stripped.push(key);
        } else {
          out[key] = value;
        }
      } else {
        out[key] = value;
      }
    }
    return out;
  }
  ```

### M15. `packages/database/src/security.ts:115`  — `silent-default`

- **What's wrong:** emitSecurityEvent is fire-and-forget by design, swallowing all DB failures via the .catch() in recordSecurityEvent that only writes to process.stderr. Every caller in packages/handlers (plugin installs, org member add/remove, billing credit purchase, privacy export, workspace invite) uses this path for SOC2-critical security audit rows. A transient DB error, a connection pool exhaustion, or a partitioned-table miss silently loses the audit record with no caller-visible signal and no retry.
- **Impact:** Security audit rows for privileged mutations (member removal, plugin enable/disable, credit purchase) are silently dropped on any DB error. The caller returns 200/success while the audit trail has a gap. SOC2 CC6/CC7 evidence is missing; forensic reconstruction becomes impossible for the affected events.

  ```ts
  export function emitSecurityEvent(event: SecurityEventInput): void {
    recordSecurityEvent(registryInserter(), event);
  }
  ```

### M16. `packages/handlers/src/agent.compose.ts:160`  — `bad-fallback`

- **What's wrong:** readWorkspacePrompt swallows all errors from invoke("prompt.settings.read") and returns an empty string with no logging. Any failure — IAM misconfiguration, DB outage, missing handler registration — is indistinguishable from "no workspace instructions configured".
- **Impact:** Workspace-level agent instructions configured by the operator are silently dropped during any transient failure, causing the AI planner to ignore configured context. There is no way to detect this from logs or metrics.

  ```ts
  } catch {
      return "";
    }
  ```

### M17. `packages/handlers/src/form.fill.ts:163`  — `bad-fallback`

- **What's wrong:** Any error from generateObjectFor — including billing/quota errors — returns a successful response where all fields show changed:false with reason "Model error — field left unchanged.". The caller receives HTTP 200 with a structurally valid but semantically empty result.
- **Impact:** A billing quota failure or invalid model is indistinguishable from a successful run that found no fields to change. Automated workflows that chain on form.fill output will silently proceed with unchanged (potentially stale) form data without knowing the AI step failed.

  ```ts
  } catch (err) {
      // Model error → return all fields unchanged, no throw (policy §0.5).
      logger.warn(
        { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
        "form.fill: generateObjectFor failed — returning fields unchanged",
      );
      return {
        fields: fields.map((f) => ({ name: f.name, current: f.current, proposed: f.current, changed: false, reason: "Model error — field left unchanged." })),
      };
    }
  ```

### M18. `packages/handlers/src/graph.ingest.ts:167`  — `missing-propagation`

- **What's wrong:** Individual graph.edge.upsert failures are logged at WARN and silently skipped, same pattern as entity upserts. The caller receives a successful response with a partial relationship set.
- **Impact:** Relationships between entities are silently dropped on any edge upsert failure. Knowledge graph queries that traverse these missing edges return incorrect or incomplete results.

  ```ts
  } catch (err) {
        logger.warn({ err, from: r.fromName, to: r.toName }, "graph.ingest: edge upsert failed");
      }
  ```

### M19. `packages/handlers/src/image.analyze.ts:67`  — `bad-fallback`

- **What's wrong:** loadWorkspacePromptConfig failure is swallowed and replaced with an empty object with no logging. The empty catch drops the error entirely — no log, no context, no way to distinguish a transient DB failure from a workspace with no prompt config. The resulting empty PromptConfig silently bypasses any workspace-level system prompt override or autoImprovePrompts setting.
- **Impact:** If the config load fails due to a DB error, the analysis proceeds with zero workspace customization and autoImprovePrompts defaults to true (from the ?? true in the caller), meaning the analysis prompt override configured by the workspace owner is silently dropped without any observability signal.

  ```ts
  const promptConfig = await loadWorkspacePromptConfig(ctx.workspaceId).catch(() => ({}));
  ```

### M20. `packages/handlers/src/image.generate.ts:89`  — `swallowed-catch`

- **What's wrong:** Any image generation failure (network error, provider error, rate-limit, quota exhaustion) is caught, logged at WARN, and converted into a success response with `{ placeholder: true }`. The MCP tool `apps/mcp/src/tools/image.generate.ts` returns this to the caller as a successful invocation. The caller (an LLM agent) has no mechanism to detect that the image was not generated.
- **Impact:** A transient provider failure or billing quota exhaustion silently returns a placeholder to the agent. The agent treats generation as successful and may embed the placeholder in downstream artifacts. Real generation errors — including billing overages or provider outages — produce no error signal at the MCP layer. The `placeholder: true` flag in the render component props is the only signal, and it is only visible if the client renders the component.

  ```ts
  } catch (err) {
      // Generation failed — return placeholder, never throw.
      const reason = err instanceof Error ? err.message : "unknown error";
      logger.warn(
        { orgId: ctx.orgId, workspaceId: ctx.workspaceId, reason },
        "image.generate: generation failed — returning placeholder",
  ```

### M21. `packages/ingestion/src/connectors/linear/index.ts:132`  — `swallowed-catch`

- **What's wrong:** Same pattern as the Slack connector: `timingSafeEqual` is called without first checking that `Buffer.from(sig)` and `Buffer.from(expected)` have equal `.length`. The Linear HMAC is a raw hex string (64 bytes), and an attacker-controlled `linear-signature` header of a different byte length causes Node to throw `ERR_CRYPTO_TIMINGSAFEEQUAL_LENGTH`, which is silently swallowed. GitHub's connector (line 425) demonstrates the correct pattern: compare `sigBuf.length !== expBuf.length` and return `false` explicitly before the `timingSafeEqual` call.
- **Impact:** Signature length mismatches are invisible to observability. The webhook is rejected, but no one knows why. An actual key-rotation bug that changes the HMAC length would surface as random webhook failures with no error logged, making it extremely hard to diagnose.

  ```ts
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
  ```

### M22. `packages/ingestion/src/connectors/slack/index.ts:113`  — `swallowed-catch`

- **What's wrong:** `timingSafeEqual` throws `ERR_CRYPTO_TIMINGSAFEEQUAL_LENGTH` when its two arguments have different byte lengths. Unlike the GitHub connector (which explicitly normalizes buffer lengths before calling `timingSafeEqual`), the Slack connector passes raw `sig` and `expected` strings without a length check. When an attacker — or a misconfigured Slack app — sends a signature of a different length than the expected HMAC hex string, the Node error is swallowed by the bare `catch {}` and the function returns `false`. The call appears to work correctly (webhook is rejected), but the error is invisible: no log, no metric, no alert.
- **Impact:** An inbound webhook with a mismatched signature length is silently rejected with no observable signal. Operations cannot distinguish a real HMAC length mismatch (possibly indicating a misconfigured signing secret rotation or a Slack API change) from a deliberate forgery attempt. If the secret is ever `null` or empty the outer guard returns `false` before reaching this path, but the silent swallow masks a genuine operational error class.

  ```ts
  try {
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
  ```

### M23. `packages/ingestion/src/dedup/resolve.ts:118`  — `swallowed-catch`

- **What's wrong:** When a stored EntityNode's `properties` field cannot be JSON-parsed, the catch block silently skips the property-based scoring (email/URL exact-match component). No log is emitted, no metric is incremented. The alias scoring silently degrades to only the embedding similarity component (weight 0.4), losing the 0.4 email/URL weight that would otherwise confirm or reject an alias. This means a node with corrupt properties will produce alias decisions driven almost entirely by embedding cosine similarity alone.
- **Impact:** Corrupt property blobs (e.g. from a double-serialization bug or a direct Neo4j write from a different code path) silently lower the quality of alias matching. Alias edges that should have been auto-confirmed (score >= 0.92) may fall below the confirm threshold and be flagged for human review, or alias edges that would have been rejected may be created. No telemetry allows operators to discover which nodes have corrupt properties.

  ```ts
  try {
    parsedProps = JSON.parse(rawProperties) as Record<string, unknown>;
  } catch {
    // malformed stored properties — skip property scoring
  }
  ```

### M24. `packages/notifications/src/smtp-transport.ts:66`  — `ignored-return`

- **What's wrong:** The SMTP transport populates `result.rejected` and logs its count, but never throws or signals an error when `rejected` is non-empty. A partial or total rejection (e.g. all recipients rejected by the SMTP server) returns a successful `SendEmailResult` to the caller. The caller in `notifyOrgManagers` discards the return value entirely (`await sendEmail(...)` with no result check), so a fully-rejected send is indistinguishable from a success.
- **Impact:** If the SMTP server rejects a recipient (e.g. mailbox full, domain blocked, rate-limited), the send appears to have succeeded. For security-critical emails (MCP reauth alerts, payment-failed, low-balance), the recipient never gets the email and no error propagates to the caller. The only signal is a log line with `rejected: 1` buried in structured logs — no alert, no retry, no caller-visible failure.

  ```ts
  const result: SendEmailResult = {
            id: info.messageId,
            accepted: toAddressStrings(info.accepted),
            rejected: toAddressStrings(info.rejected),
          };
  ```

### M25. `packages/oxagen/src/kernel.ts:547`  — `missing-propagation`

- **What's wrong:** When the IAM checkFn throws (DB timeout, network blip, resolver crash) and enforcement is OFF (_iamEnforced=false), the code logs the error via console.error but then falls through: the first guard (iamCheckThrew && _iamEnforced) is false, and iamResult is null so the second guard (iamResult !== null) is also false. The call proceeds to the handler with no emitSecurityEvent call for the IAM-error case. The audit chain has no record that IAM resolution was bypassed due to an error.
- **Impact:** An IAM resolver outage during the default enforcement-off period causes every capability call to silently skip the authz audit event entirely. Unlike the normal would-deny path (which at least calls emitSecurityEvent before proceeding), this path emits nothing. The SOC 2 audit log shows the call as never having occurred. In a DB-outage scenario, all requests during that window appear to have no IAM evaluation at all — forensically indistinguishable from calls that bypassed IAM intentionally.

  ```ts
  // Fail closed on resolver error when enforcement is enabled.
  if (iamCheckThrew && _iamEnforced) {
    // ... emit + throw ...
  }
  
  if (iamResult !== null && iamResult.outcome !== "allow") {
    // ... enforcement logic ...
  }
  ```

### M26. `packages/plugins/src/oauth/state-store.ts:63`  — `missing-propagation`

- **What's wrong:** JSON.parse on the raw database-sourced string has no try/catch guard. If the stored value is malformed (partial write, manual edit, schema migration that changed the value column format, or a truncated row from a prior bug), it throws a SyntaxError that propagates out of loadOAuthState with no contextual information about which state key failed, what the raw value was, or that this was a JSON parse failure at all.
- **Impact:** An OAuth PKCE callback with a malformed state entry causes an unhandled SyntaxError surfacing as a 500 with no actionable diagnostic. The user sees a generic error during the OAuth connect flow. The error log at the route level lacks context about the raw payload, making debugging difficult. The PKCE verifier is unrecoverable for that session.

  ```ts
  if (!row) return null;
    return JSON.parse(row.value) as OAuthStateData;
  ```

### M27. `packages/skills/src/loader.ts:64`  — `bad-fallback`

- **What's wrong:** When a skill reference file is missing (ENOENT) the error is completely silent — no log is emitted and the reference body is replaced with an empty string. A skill author who typos a reference path will see the reference silently load as empty content, and the agent will operate as if the reference document contains nothing.
- **Impact:** Skill reference content silently disappears. The agent prompt built from the skill will be missing the referenced document's content with no indication why, leading to degraded or incorrect agent responses. There is no way to diagnose the gap without inspecting the filesystem manually.

  ```ts
  body: await readFile(resolvePath(baseDir, ref.path), "utf8").catch(
    (err: unknown) => {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        console.warn(...);
      }
      return "";
    },
  ),
  ```

### M28. `packages/skills/src/seed.ts:95`  — `silent-default`

- **What's wrong:** After upsertSkill(), findSkillId() is expected to return the row's UUID. If it returns undefined (race condition, adapter bug, or DB connectivity issue), the seeder silently skips writing the skill_version row and continues without logging a warning. The processed count still increments, so the caller sees a normal result.
- **Impact:** A skill_version row can be permanently missing for a built-in skill while the seeder reports success. When an agent subsequently calls agent.skill.load, the skill exists in the skills table but has no version body, causing the load to fail or return empty content. The seed script is typically a one-time deploy step, so the gap may not be noticed until an agent fails in production.

  ```ts
  const skillId = await adapter.findSkillId(BUILTIN_WORKSPACE_ID, skill.slug);
  if (!skillId) continue;
  ```

### M29. `packages/ui/src/components/theme-provider.tsx:81`  — `missing-propagation`

- **What's wrong:** decodeURIComponent is called directly on the cookie value with no try/catch. A malformed percent-encoded cookie value (e.g. %zz, a truncated %, or a cookie set by another tool) causes decodeURIComponent to throw a URIError. This throw is unhandled and propagates out of the readThemeCookie call inside a useEffect on mount, crashing the React subtree. Because no error boundary wraps ThemeProvider in the documented usage, the thrown URIError surfaces as an unhandled exception, triggering the global error boundary (GlobalErrorPage) with no actionable message.
- **Impact:** A malformed theme cookie — trivially set by a browser extension, a CDN edge rewrite, or a prior deployment — causes the entire Next.js app to crash to the GlobalErrorPage on mount. The root cause (a bad cookie value) is completely invisible in the error UI. Users cannot recover without manually clearing cookies.

  ```ts
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? parseTheme(decodeURIComponent(match[1] ?? "")) : null;
  ```

### M30. `packages/ui/src/components/theme-provider.tsx:175`  — `bad-fallback`

- **What's wrong:** The BroadcastChannel message handler accepts any MessageEvent on the channel named 'oxagen-theme'. When e.data is not a string (e.g. a message from a browser extension, another tab, or a future code path that posts a structured object), the ternary short-circuits to parseTheme(undefined), which silently returns 'system'. setThemeState is then called unconditionally, overwriting the user's explicit 'light' or 'dark' preference with 'system' — the wrong theme — with no log, no guard, and no way for the user to know why their theme changed.
- **Impact:** Any non-string BroadcastChannel message on the 'oxagen-theme' channel (from an extension, a future code path, or a tab sending structured data) silently resets the user's theme to 'system'. The cookie is NOT updated (only state is), so a page reload will restore the correct theme, but until then the user sees the wrong theme with no explanation. The condition is triggered silently and leaves no trace.

  ```ts
  const onMessage = (e: MessageEvent) => {
    const next = parseTheme(typeof e.data === "string" ? e.data : undefined);
    setThemeState(next);
  };
  ```

## Low severity (verified)

### L1. `apps/api/src/routes/v1/chat.stream.ts:280`  — `bad-fallback`
- `loadEffectiveModelDefaults` failure (e.g. DB error, missing config, billing lookup fault) is silently swallowed. The code falls through to `selectModel({})` with no model or tier override.

### L2. `apps/app/src/app/[orgSlug]/[workspaceSlug]/_shared/conversation-page.tsx:243`  — `bad-fallback`
- The MCP server list query (used to populate the per-turn MCP activation picker) silently swallows all DB and RLS errors, returning an empty array. The catch has no logging call.

### L3. `apps/app/src/components/chat/chat-shell-client.tsx:874`  — `swallowed-catch`
- Inside sseToEvents, any JSON.parse failure on an SSE data line silently skips that event. There is no logging, no counter, and no way to distinguish a genuinely malformed line from a corrupted event that should have triggered an approval gate, a tool-call-end, or a usage event.

### L4. `apps/app/src/components/chat/registry-components/billing-upgrade-inline.tsx:51`  — `bad-fallback`
- When changePlanAction returns ok=true but no URL (result.url is undefined/null), the component transitions to the 'success' state showing 'Redirecting to checkout…' but never actually redirects. The user is stuck on a success screen with no redirect.

### L5. `apps/app/src/components/shell/notifications-bell.tsx:46`  — `swallowed-catch`
- The notification load catch block is entirely empty — no logging, no error state, no user feedback. The comment says the bell is 'non-critical', but unread count in the badge also silently stays at 0, and errors (including auth failures or token expiry) leave no trace in any observability channel.

### L6. `apps/app/src/components/shell/user-switcher.tsx:79`  — `missing-propagation`
- The sign-out catch path is absent. If `signOut()` throws (e.g. network failure, auth server error), the `finally` block resets the spinner but the user is NOT redirected to /login. There is no error display, no log, and the session is in an unknown state — the user appears to still be logged in but the sign-out may have partially executed.

### L7. `packages/agent/src/dispatch/mcp-client.ts:108`  — `bad-fallback`
- healthcheck() converts every possible failure — wrong credentials, TLS cert mismatch, DNS failure, schema error — into the same { status: 'unreachable', discoveredTools: [], descriptors: [] } shape. The register handler (agent.mcp.register) persists the server row with healthStatus: 'unreachable' regardless. Auth misconfiguration is indistinguishable from transient network failure.

### L8. `packages/agent/src/handlers/agent.skill.list.ts:47`  — `silent-default`
- When the LEFT JOIN to skillVersions returns no row (skill has no versions — can happen if a seed migration is incomplete or a version row is deleted while the skill row survives), version is silently defaulted to the string "1". The agent receives a plausible-looking version string for a skill that has no published content.

### L9. `packages/ai/src/prompts/auto-improve.ts:78`  — `empty-catch`
- The catch block is completely bare (no bound variable, no logging). Any error thrown by `generateObjectFor` — including transient LLM errors, schema validation failures, or billing/metering exceptions thrown inside the call — is silently swallowed. The caller receives `{ enhanced: false }` with no observable signal that the judge ran and failed.

### L10. `packages/billing/src/subscriptions.ts:393`  — `swallowed-catch`
- After a successful plan upgrade the prorated credit grant is caught and swallowed. The error is logged but the `err` field passed to the logger is the raw caught value, not `err instanceof Error ? err.message : String(err)` — so in pino/structured-log environments the `err` key may serialize as `{}` for non-Error throws, giving no stack trace or message.

### L11. `packages/handlers/src/graph.ingest.ts:44`  — `bad-fallback`
- readWorkspacePrompt in graph.ingest.ts (identical pattern to agent.compose.ts) swallows all errors from invoke("prompt.settings.read") with no log, returning an empty string.

### L12. `packages/handlers/src/svg.generate.ts:103`  — `bad-fallback`
- All generateObjectFor errors including billing quota exhaustion, invalid API key, or model provider downtime produce a static placeholder SVG with a WARN log. The response is HTTP 200 with a valid SVG payload.

### L13. `packages/iam/src/emit-audit.ts:67`  — `bad-fallback`
- If the SHA-256 computation for the audit chain hash fails, the error is silently swallowed and an empty string is stored as chain_hash in the audit row. No log or metric is emitted. This second silent catch is structurally identical to line 52.

### L14. `packages/iam/src/fetch-authz.ts:65`  — `bad-fallback`
- When the IAM migration has not been applied (Postgres error 42P01), fetchAuthz returns EMPTY_AUTHZ which causes the resolver to fall through to each contract's defaultEffect. For a production environment where migrations were not applied (e.g. a partial deployment), all capabilities silently revert to their default effects, which may be 'allow'.

### L15. `packages/notifications/src/notifications/notify-org-managers.ts:82`  — `bad-fallback`
- When the org row is not found in the DB (orgId references a deleted or non-existent org), `orgRow` is undefined and the `?? {}` fallback silently treats the missing org as one with no alert settings, defaulting to Owner/Admin roles and email enabled. No error is thrown or logged for the missing org.

### L16. `packages/notifications/src/notifications/notify-org-managers.ts:170`  — `swallowed-catch`
- The `emailedAt` DB update (lines 164-169) is inside the same try block as `sendEmail`. If `sendEmail` succeeds but the `withSystemDb` update throws, the error is caught here, logged once, and silently discarded. The email was delivered but `emailedAt` stays null — the row permanently shows the email was never sent.

### L17. `packages/plugins/src/credentials/credential-service.ts:89`  — `bad-fallback`
- decryptCredentialSecrets silently returns an all-null secrets object when tokenKmsKeyId is absent. The comment says these are 'rows predating encryption', but the same code path executes for any row where tokenKmsKeyId was written as null due to a bug, a failed partial write, or a schema issue. The caller (getWorkspaceSecret) returns a WorkspaceSecret struct with all secret fields null and status 'active', which is indistinguishable from a valid credential row where no secrets were provided.

### L18. `packages/sandbox/src/docker.ts:291`  — `swallowed-catch`
- In the streaming code path, container.wait() rejection is silently swallowed. If the Docker daemon returns an error (e.g. the container was force-removed externally, socket disconnected), the error is discarded and the stream is simply marked done. The caller's async iterator exits cleanly with no indication that the container run failed.

## Low-severity flags (unverified leads)

| File | Line | Category | Note |
|---|---|---|---|
| `apps/app/src/lib/command-menu/use-recent.ts` | 77 | `empty-catch` | The localStorage.removeItem() failure is silently swallowed with a comment 'ignore'. If localStorage is in a broken state (e.g. SecurityError from a corrupted origin), the in-memory state is cleared but the persisted entries survive, causing the recent list to reappear on the next page load. |
| `apps/app/src/components/chat/registry-components/automation-create-inline.tsx` | 204 | `swallowed-catch` | updateStepConfig silently discards JSON parse errors during step config editing. This is intentional for live-typing, but there is no error indicator shown to the user even after they have finished typing invalid JSON and attempt to submit the form. |
| `apps/app/src/components/chat/mermaid-diagram.tsx` | 88 | `swallowed-catch` | Clipboard write failure is silently swallowed with no user feedback. The comment acknowledges this is intentional, but the button gives no visual indication that the copy failed — the 'Copy' label does not change to 'Failed' or similar. |
| `apps/app/src/components/shell/notifications-bell.tsx` | 78 | `swallowed-catch` | The mark-read and archive catch blocks have no error logging. The revert is triggered (a reload), but the original error — potentially an auth failure or a server error — is silently swallowed with no log entry and no toast to the user. |
| `apps/app/src/components/plugins/marketplace-modal.tsx` | 150 | `unhandled-promise` | The debounced `fetchServers` call inside `setTimeout` is not awaited and any rejection from it is not chained to `.catch()`. Since `fetchServers` itself handles errors internally (sets `error` state), this is low severity, but the floating promise means any unexpected exception (e.g. if the function itself throws before entering the try/catch) is silently dropped. |
| `apps/app/src/components/billing/buy-credits.tsx` | 57 | `swallowed-catch` | The discount preview catch block silently discards all errors including the dynamic import failure, server action exceptions, and network errors. `setPreview(null)` hides any loading state without indication that the preview is unavailable vs simply not applicable. |
| `packages/handlers/src/image.create.ts` | 69 | `bad-fallback` | When the DB call to load workspace prompt config fails, the handler silently defaults to `autoImprovePrompts: true`, overriding any explicit admin setting that disables prompt enhancement. An LLM call to enhance the prompt is made unnecessarily, consuming credits and latency, with no indication that the config could not be loaded. |
| `apps/mcp/src/tools/workspace.invite.send.ts` | 8 | `missing-propagation` | workspace.invite.send.ts defines its MCP tool schema inline (hand-rolling the same fields as the contract) instead of spreading workspaceInviteSend.input.shape. Every other MCP tool in the codebase uses the contract's shape spread. If the contract's input schema gains, removes, or renames a field, this tool's schema will silently drift and the MCP surface will accept/reject different inputs than the kernel contract expects. |
| `apps/mcp/src/tools/workspace.member.list.ts` | 8 | `missing-propagation` | workspace.member.list.ts also defines its MCP tool schema inline rather than spreading workspaceMemberList.input.shape from the contract. Same schema drift risk as workspace.invite.send.ts. |
| `apps/api/src/routes/v1/agent.tool.list.ts` | 10 | `bad-fallback` | A JSON parse error on the request body is swallowed and treated identically to an empty body `{}`. The schema parse then runs against `{}` and either succeeds with defaults or throws a Zod validation error — the original network/content-type error is lost. |
| `apps/api/src/routes/v1/github-oauth.ts` | 540 | `swallowed-catch` | The GitHub `/user` API call to resolve a stable `providerUserId` can fail (network error, token scope issue, rate limit) and the error is swallowed. The fallback `providerUserId` is `github:{connectionPublicId}` which is not a stable GitHub user identifier. |
| `apps/api/src/routes/v1/chat.stream.ts` | 553 | `swallowed-catch` | The `finally` block enqueuing the SSE `[DONE]` terminal event wraps the enqueue in a try/catch that swallows all errors — including scenarios where the error is NOT a closed-controller (e.g., the encoder throws on unexpected input). |
| `packages/oxagen/src/iam/conditions.ts` | 126 | `swallowed-catch` | The localTimeOfDay function wraps the Intl.DateTimeFormat call in a catch block that silently returns null with no logging. When the timezone string in a grant row's conditionsJsonb is invalid or Intl is unavailable, the exception is swallowed. The null propagates to evalTimeWindow which returns null, which evaluateConditions treats as false, causing a silent deny. |
| `packages/handlers/src/agent.compose.ts` | 411 | `bad-fallback` | The summarize() fallback catch has no logging. When generateObjectFor fails for the summary call, the error is silently swallowed with zero observability — no log, no metric, no error class captured. |
| `packages/ui/src/components/theme-provider.tsx` | 78 | `silent-default` | The cookieName parameter is interpolated directly into a RegExp constructor without escaping. If cookieName contains regex metacharacters (e.g. a dot, bracket, or parenthesis from a misconfigured prop), the RegExp will match unintended cookie names or throw a SyntaxError. The THEME_COOKIE_NAME default ('theme') is safe, but callers can pass any string via the cookieName prop. A malformed regex silently either matches the wrong cookie (returning a wrong theme value) or throws an uncaught SyntaxError. |
| `packages/database/src/client.ts` | 24 | `missing-propagation` | closeDatabase sets _client and _db to null before awaiting the pool shutdown, but only does so after the await, which is correct. However, if _client.end() rejects (e.g. timeout exceeded, network error during shutdown), the error propagates unhandled to the caller. The seed.ts entry-point chains .then(() => closeDatabase()) after seed() without a specific catch for closeDatabase failures, meaning a shutdown error after a successful seed exits 0 in the .then() chain only if the promise resolves, but the rejection would fall through to the outer .catch() and log 'Seed failed' — masking the fact that seeding itself succeeded. |
| `packages/inngest-functions/src/functions/ingestion.semantic-edge-infer.ts` | 162 | `bad-fallback` | The `connectionId` field on `InferredEdge` nodes is taken from `propertiesSnapshot["connectionId"]` with a `""` fallback. If the ingested entity's property snapshot does not carry a `connectionId` key (many entity types won't), all inferred edge nodes silently receive `connectionId = ""`. This is a structural property set at CREATE time in the MERGE, so a later re-infer on the same entity will not fix it (ON MATCH does not re-set connectionId). |
| `packages/inngest-functions/src/functions/billing.dunning-sweep.ts` | 34 | `swallowed-catch` | Failures in `isLowBalance` or `notifyLowBalance` for individual orgs are caught and logged as `warn` with no further action. While a per-org failure is arguably non-fatal, if `notifyLowBalance` throws after `isLowBalance` returns `low: true`, the failure count is not incremented and the swallowed error means the org is silently skipped without any retry scheduling. The warning has no `orgId`-indexed deduplication, so repeated failures accumulate silently. |
| `packages/ingestion/src/parsers/index.ts` | 112 | `swallowed-catch` | When a tree-sitter query string fails to compile (grammar version mismatch, malformed S-expression, wrong node type name), the error is silently swallowed and the query is skipped. The comment explains the intent, but there is no logging, counter, or fallback to a known-good query pattern. A grammar version bump that breaks one of the four TypeScript query patterns would silently drop the entire symbol kind (functions, classes, methods, or interfaces) from all parse results without any signal. |
| `packages/billing/src/billing-settings.ts` | 179 | `swallowed-catch` | When enabling auto-reload and no explicit payment method is in the request, the code tries to look up the Stripe default via `billingProvider().getDefaultPaymentMethodId`. If this Stripe call throws (network error, invalid customer id), the exception is caught and `hasValidPaymentMethod` stays `false`, causing the entire `updateAutoReloadSettings` call to throw the misleading user-facing error "cannot enable auto-reload without a saved payment method" — even when one exists. |
| `packages/notifications/src/notifications/notify-org-managers.ts` | 143 | `missing-propagation` | When `createNotification` fails for a recipient, the error is logged and the loop continues to the next recipient without any aggregate failure signal. The function returns `void` with no way for callers to know that one or more in-app notifications failed to persist. |
| `packages/plugins/src/registry/readme.ts` | 76 | `missing-propagation` | The fetch calls inside the candidate README loop only check res.ok for HTTP-level non-success responses. A network-level failure (DNS error, connection refused, timeout) throws a TypeError from fetch() directly with no catch. This propagates out of fetchAndRenderReadme with no context about which GitHub URL was being fetched or which candidate filename failed. |
| `packages/ai/src/stream.ts` | 198 | `bad-fallback` | When the `messages` array contains no user-role message, `lastUserMessage` is `undefined` and `promptTextForHash` is set to `JSON.stringify("")` which equals `""""`. All such turns (tool-only callbacks, system-only messages) hash to the same constant in ClickHouse. The `??` fallback makes distinct failure modes (missing user message vs. present but empty content) indistinguishable. |
| `packages/storage/src/ingest.ts` | 94 | `swallowed-catch` | Network errors during avatar ingestion are silently swallowed with no logging. Three catch blocks in this function (lines 94, 111, 119) each discard the error without any log or metric, returning null silently. |
| `packages/sandbox/src/vercel.ts` | 146 | `swallowed-catch` | sandbox.stop() errors are swallowed silently in both the run() and stream() paths. If the Vercel sandbox fails to stop, the microVM may remain running and accumulate cost, but no error is logged or propagated. |
| `packages/sandbox/src/docker.ts` | 183 | `swallowed-catch` | The kill call when MAX_OUTPUT_BYTES is exceeded swallows all errors silently. If the kill fails (container already exited, Docker daemon error), the container may continue running and producing output that will be dropped, but the host-side buffer will stop growing. No log is emitted when the kill attempt fails. |
| `packages/web/src/fetch.ts` | 98 | `missing-propagation` | decodeEntities replaces numeric HTML character references (&#NNN; and &#xHHH;) by calling String.fromCodePoint() with the parsed integer. The regex \d+ has no upper bound — a malformed or adversarial page can include &#9999999999; which parses to an integer exceeding the Unicode maximum (0x10FFFF = 1,114,111). String.fromCodePoint() throws a RangeError on out-of-range values. There is no try/catch around extractMarkdownFromHtml in webFetch, so the RangeError propagates uncaught through the handler and crashes the capability invocation. |

