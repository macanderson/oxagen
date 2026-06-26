import { ConversationPage } from "../_shared/conversation-page";
import {
  cancelBackgroundTaskAction,
  readBackgroundTaskAction,
  resolveApprovalAction,
  resolveConsentAction,
  resolvePlanAction,
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

  return (
    <div className="flex h-full min-h-0 flex-col">
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
          }}
        />
      </div>
    </div>
  );
}
