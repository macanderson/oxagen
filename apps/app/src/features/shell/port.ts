// The shell's read port (plan §4.5 `ShellReadPort`). Every read returns
// `Read<T>`: a store that is not wired or not backed says so, and the shell
// renders an honest state instead of a zero.
//
// PROMOTE: move to src/data/ports.ts as `ShellReadPort` (lane L1). Its query
// takes slugs plus the signed-in user's id because `requireViewer` and `Scope`
// (lane L4) have not landed; switch the argument to `Viewer`/`Scope` then.
import type { Read } from "@/data/not-backed";
import type {
  AccountView,
  AssistantEngine,
  CommandRun,
  NavCounts,
  NotificationFeed,
  ShellContext,
} from "./contracts";

export type ShellQuery = {
  org: string;
  /** The workspace slug, or null on an organization page. */
  ws: string | null;
  userId: string;
};

export interface ShellReadPort {
  /** The organization, its workspaces and the viewer. `error` 404 means no such organization for this viewer. */
  context(q: ShellQuery): Promise<Read<ShellContext>>;
  /** Counts beside the sidebar items, keyed by workspace slug (one read for the switcher and the sidebar). */
  navCounts(q: ShellQuery): Promise<Read<Record<string, NavCounts>>>;
  notifications(q: ShellQuery): Promise<Read<NotificationFeed>>;
  assistantEngine(q: ShellQuery): Promise<Read<AssistantEngine>>;
  recentRuns(q: ShellQuery): Promise<Read<CommandRun[]>>;
  account(q: ShellQuery): Promise<Read<AccountView>>;
}
