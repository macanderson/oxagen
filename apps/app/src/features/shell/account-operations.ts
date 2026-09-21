"use client";

import { useCallback, useSyncExternalStore } from "react";

type AccountOperation = "profile" | "preferences" | "avatar";
type AccountExportState =
  | { kind: "idle" }
  | { kind: "pending"; scope: "user" | "org" }
  | {
      kind: "queued" | "ready" | "expired";
      scope: "user" | "org";
      exportId: string;
    }
  | { kind: "denied" | "failed"; scope: "user" | "org" };

const IDLE: AccountExportState = { kind: "idle" };
const pending = new Set<string>();
const exportsByAccount = new Map<string, AccountExportState>();
const listeners = new Set<() => void>();
const keyOf = (...parts: string[]) => JSON.stringify(parts);
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// Account panels unmount on tab changes. The request and queued export belong
// to the signed-in account, so their state lives outside the panel's lifetime.
export const accountOperations = {
  resetForTests(): void {
    pending.clear();
    exportsByAccount.clear();
    emit();
  },
  isPending(userId: string, operation: AccountOperation): boolean {
    return pending.has(keyOf(userId, operation));
  },
  begin(userId: string, operation: AccountOperation): boolean {
    const key = keyOf(userId, operation);
    if (pending.has(key)) return false;
    pending.add(key);
    emit();
    return true;
  },
  end(userId: string, operation: AccountOperation): void {
    pending.delete(keyOf(userId, operation));
    emit();
  },
  readExport(userId: string, orgSlug: string): AccountExportState {
    return exportsByAccount.get(keyOf(userId, orgSlug)) ?? IDLE;
  },
  setExport(userId: string, orgSlug: string, state: AccountExportState): void {
    exportsByAccount.set(keyOf(userId, orgSlug), state);
    emit();
  },
  beginExport(userId: string, orgSlug: string, scope: "user" | "org"): boolean {
    const state = this.readExport(userId, orgSlug);
    if (state.kind === "pending" || state.kind === "queued") return false;
    this.setExport(userId, orgSlug, { kind: "pending", scope });
    return true;
  },
};

export function useAccountOperation(
  userId: string,
  operation: AccountOperation,
) {
  const isPending = useSyncExternalStore(
    subscribe,
    () => accountOperations.isPending(userId, operation),
    () => false,
  );
  return {
    pending: isPending,
    begin: () => accountOperations.begin(userId, operation),
    end: () => accountOperations.end(userId, operation),
  };
}

export function useAccountExport(userId: string, orgSlug: string) {
  const state = useSyncExternalStore(
    subscribe,
    () => accountOperations.readExport(userId, orgSlug),
    () => IDLE,
  );
  const begin = useCallback(
    (scope: "user" | "org") =>
      accountOperations.beginExport(userId, orgSlug, scope),
    [userId, orgSlug],
  );
  const setState = useCallback(
    (next: AccountExportState) =>
      accountOperations.setExport(userId, orgSlug, next),
    [userId, orgSlug],
  );
  return { state, begin, setState };
}
