"use client";

import * as React from "react";
import { motion } from "motion/react";
import { fadeInUp } from "@oxagen/ui/lib/motion";
import {
  MessageBubble,
  type ChatMessage,
  type MessageBubbleCallbacks,
} from "./message-bubble";

// The chat DAG (spec §6.9) stores siblings per parent. To render the
// active branch we walk from the conversation's active_leaf back to the
// root and reverse. Branch siblings are surfaced via siblingCount so the
// switcher can offer navigation without re-fetching the whole tree.
//
// Memoized: the parent chat shell re-renders on every streaming token, but the
// persisted message tree only changes when `messages` changes. With a stable
// `callbacks` identity (memoized by the parent), React.memo keeps the whole
// tree from re-rendering on each token.
function MessageTreeImpl({
  messages,
  callbacks,
  orgSlug,
  workspaceSlug,
}: {
  messages: ChatMessage[];
  callbacks?: MessageBubbleCallbacks;
  orgSlug?: string;
  workspaceSlug?: string;
}) {
  return (
    <div className="flex flex-col gap-4">
      {messages.map((m) => (
        // `initial`/`animate` only fire on mount, so existing messages stay
        // put while a newly-appended one rises in. `layout` keeps the column
        // reflow smooth as the list grows. Reduced motion is honoured via the
        // app MotionProvider (reducedMotion="user").
        <motion.div
          key={m.publicId}
          layout="position"
          initial="hidden"
          animate="visible"
          variants={fadeInUp}
        >
          <MessageBubble
            message={m}
            callbacks={callbacks}
            orgSlug={orgSlug}
            workspaceSlug={workspaceSlug}
          />
        </motion.div>
      ))}
    </div>
  );
}

export const MessageTree = React.memo(MessageTreeImpl);
