import { ConversationPage } from "../_shared/conversation-page";
import { PageTabs } from "@/components/ui/page-tabs";
import { workspace } from "@/lib/routes";
import type { ScopeContext } from "@/lib/scope";
import {
  cancelBackgroundTaskAction,
  readBackgroundTaskAction,
  resolveApprovalAction,
  resolveConsentAction,
  resolvePlanAction,
  saveMessageAsKnowledgeAction,
  saveMessageAsMemoryAction,
  sendMessageAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function AskPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ c?: string; new?: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const ctx: Required<ScopeContext> = { orgSlug, workspaceSlug };
  const tabs = [
    { label: "Ask", href: workspace.ask(ctx) },
    { label: "Explore", href: workspace.explore(ctx) },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageTabs tabs={tabs} className="mb-3 shrink-0" />
      <div className="min-h-0 flex-1">
        <ConversationPage
          params={Promise.resolve({ orgSlug, workspaceSlug })}
          searchParams={searchParams}
          actions={{
            sendMessageAction,
            resolveApprovalAction,
            resolveConsentAction,
            resolvePlanAction,
            cancelBackgroundTaskAction,
            readBackgroundTaskAction,
            saveMessageAsKnowledgeAction,
            saveMessageAsMemoryAction,
          }}
        />
      </div>
    </div>
  );
}
