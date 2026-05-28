import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

export interface ChatMessage {
  publicId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  branchReason: string | null;
  siblingCount: number;
}

export function MessageBubble({ message, children }: { message: ChatMessage; children?: React.ReactNode }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-4 py-3 text-sm shadow-sm",
          isUser ? "bg-accent text-accent-foreground" : "glass",
        )}
      >
        <div className="mb-1 flex items-center gap-2 text-xs opacity-80">
          <span className="font-semibold capitalize">{message.role}</span>
          {message.branchReason ? <Badge variant="muted">{message.branchReason}</Badge> : null}
        </div>
        <div className="whitespace-pre-wrap leading-relaxed">{message.content}</div>
        {children}
      </div>
    </div>
  );
}
