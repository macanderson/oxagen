import { MessageBubble, type ChatMessage, type MessageBubbleCallbacks } from "./message-bubble";

// The chat DAG (spec §6.9) stores siblings per parent. To render the
// active branch we walk from the conversation's active_leaf back to the
// root and reverse. Branch siblings are surfaced via siblingCount so the
// switcher can offer navigation without re-fetching the whole tree.
export function MessageTree({
  messages,
  callbacks,
}: {
  messages: ChatMessage[];
  callbacks?: MessageBubbleCallbacks;
}) {
  return (
    <div className="flex flex-col gap-4">
      {messages.map((m) => (
        <MessageBubble key={m.publicId} message={m} callbacks={callbacks} />
      ))}
    </div>
  );
}
