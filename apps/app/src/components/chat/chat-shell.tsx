import { Suspense } from "react";
import { MessageTree } from "./message-tree";
import { type ChatMessage } from "./message-bubble";
import { MessageComposer, type ComposerAction } from "./message-composer";
import { Skeleton } from "@/components/ui/skeleton";

export { type ChatMessage } from "./message-bubble";

export interface ChatShellProps {
  conversationId: string | null;
  activeLeafMessageId: string | null;
  messagesPromise: Promise<ChatMessage[]>;
  sendAction: ComposerAction;
}

// RSC streaming: the messages promise resolves inside a Suspense boundary
// so the composer paints immediately and the active-leaf path streams in
// as Postgres returns rows. New tokens from the AI SDK are rendered by
// `messagesPromise` being recomputed after the server action revalidates.
export function ChatShell({ conversationId, activeLeafMessageId, messagesPromise, sendAction }: ChatShellProps) {
  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-4">
      <div className="min-h-0 flex-1 overflow-y-auto pr-2">
        <Suspense fallback={<MessagesSkeleton />}>
          <AsyncMessages promise={messagesPromise} />
        </Suspense>
      </div>
      <MessageComposer
        conversationId={conversationId}
        parentMessageId={activeLeafMessageId}
        action={sendAction}
      />
    </div>
  );
}

async function AsyncMessages({ promise }: { promise: Promise<ChatMessage[]> }) {
  const messages = await promise;
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-center text-sm text-muted-foreground">
        <p className="font-medium">Start a conversation.</p>
        <p>Send a message below to begin.</p>
      </div>
    );
  }
  return <MessageTree messages={messages} />;
}

function MessagesSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-16 w-2/3" />
      <Skeleton className="h-12 w-1/2 self-end" />
      <Skeleton className="h-20 w-3/4" />
    </div>
  );
}
