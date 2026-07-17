import { ConversationPage } from "../_shared/conversation-page";
import {
  cancelBackgroundTaskAction,
  readBackgroundTaskAction,
  resolveApprovalAction,
  resolveConsentAction,
  resolvePlanAction,
  sendMessageAction,
} from "./actions";

export default async function SessionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  // `?agent=<publicId>` binds this session to a published agent (see
  // ConversationPage → ChatShell). Optional — absent ⇒ normal unbound chat.
  searchParams: Promise<{ c?: string; new?: string; agent?: string }>;
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
