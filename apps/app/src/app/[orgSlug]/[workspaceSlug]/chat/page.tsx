import { ConversationPage } from "../_shared/conversation-page";
import {
  cancelBackgroundTaskAction,
  readBackgroundTaskAction,
  resolveApprovalAction,
  resolvePlanAction,
  sendMessageAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  return (
    <ConversationPage
      params={params}
      searchParams={searchParams}
      actions={{
        sendMessageAction,
        resolveApprovalAction,
        resolvePlanAction,
        cancelBackgroundTaskAction,
        readBackgroundTaskAction,
      }}
    />
  );
}
