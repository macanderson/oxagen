/**
 * github-connection-wizard-types.ts — Shared types and constants for the GitHub
 * connection wizard.
 */

// ── Step ──────────────────────────────────────────────────────────────────────

export type WizardStep = "connect" | "select-repos" | "confirm";

// ── API shapes ────────────────────────────────────────────────────────────────

export interface Installation {
  id: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string;
  avatarUrl: string | null;
}

export interface Repository {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
}

// ── Sync depth ────────────────────────────────────────────────────────────────

export const SYNC_DEPTH_OPTIONS = [30, 60, 90, 180] as const;
export type SyncDepth = (typeof SYNC_DEPTH_OPTIONS)[number];

// ── API base ──────────────────────────────────────────────────────────────────

// Use relative /api/v1 so requests stay same-origin and the Better Auth session
// cookie is forwarded automatically. next.config.mjs rewrites these to the Hono API.
export const API_BASE = "/api";
