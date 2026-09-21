"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { PreferencesDraft } from "./account-actions";

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

type PreferencesState =
  | { kind: "loading" | "denied" | "failed" }
  | { kind: "ready"; draft: PreferencesDraft };
export type PreferencesSnapshot = {
  state: PreferencesState;
  outcome: "saved" | "invalid" | "denied" | "failed" | null;
  revision: number;
  dirty: boolean;
};
const INITIAL_PREFERENCES: PreferencesSnapshot = {
  state: { kind: "loading" },
  outcome: null,
  revision: 0,
  dirty: false,
};
const preferencesByAccount = new Map<string, PreferencesSnapshot>();
const avatarsByAccount = new Map<
  string,
  { value: string; previous: string | null }
>();

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
    preferencesByAccount.clear();
    avatarsByAccount.clear();
    emit();
  },
  readPreferences(userId: string): PreferencesSnapshot {
    return preferencesByAccount.get(userId) ?? INITIAL_PREFERENCES;
  },
  setPreferences(
    userId: string,
    update: (current: PreferencesSnapshot) => PreferencesSnapshot,
  ): void {
    preferencesByAccount.set(userId, update(this.readPreferences(userId)));
    emit();
  },
  readAvatar(
    userId: string,
  ): { value: string; previous: string | null } | null {
    return avatarsByAccount.get(userId) ?? null;
  },
  setAvatar(userId: string, value: string, previous: string | null): void {
    avatarsByAccount.set(userId, { value, previous });
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
  readExport(userId: string, orgKey: string): AccountExportState {
    return exportsByAccount.get(keyOf(userId, orgKey)) ?? IDLE;
  },
  setExport(userId: string, orgKey: string, state: AccountExportState): void {
    exportsByAccount.set(keyOf(userId, orgKey), state);
    emit();
  },
  beginExport(userId: string, orgKey: string, scope: "user" | "org"): boolean {
    const state = this.readExport(userId, orgKey);
    if (state.kind === "pending" || state.kind === "queued") return false;
    this.setExport(userId, orgKey, { kind: "pending", scope });
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
    end: () => {
      accountOperations.end(userId, operation);
    },
  };
}

export function useAccountExport(userId: string, orgKey: string) {
  const state = useSyncExternalStore(
    subscribe,
    () => accountOperations.readExport(userId, orgKey),
    () => IDLE,
  );
  const begin = useCallback(
    (scope: "user" | "org") =>
      accountOperations.beginExport(userId, orgKey, scope),
    [userId, orgKey],
  );
  const setState = useCallback(
    (next: AccountExportState) => {
      accountOperations.setExport(userId, orgKey, next);
    },
    [userId, orgKey],
  );
  return { state, begin, setState };
}

export function useAccountPreferences(userId: string) {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => accountOperations.readPreferences(userId),
    () => INITIAL_PREFERENCES,
  );
  const update = useCallback(
    (change: (current: PreferencesSnapshot) => PreferencesSnapshot) => {
      accountOperations.setPreferences(userId, change);
    },
    [userId],
  );
  return { ...snapshot, update };
}

export function useAccountAvatar(userId: string) {
  return useSyncExternalStore(
    subscribe,
    () => accountOperations.readAvatar(userId),
    () => null,
  );
}
