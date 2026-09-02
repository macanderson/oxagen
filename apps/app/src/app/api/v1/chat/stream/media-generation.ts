import { randomUUID } from "node:crypto";
import {
  selectImageModel,
  imageTierModelId,
  videoTierModelId,
  generateImageFor,
} from "@oxagen/ai";
import {
  persistGeneratedAsset,
  createPendingGeneratedAsset,
} from "@oxagen/handlers";
import { eventClient } from "@/event-client";
import type { StreamEvent } from "@/components/chat/stream-event-types";
import { formatStreamError } from "./stream-parts";

/**
 * Stream a media-generation turn as text/event-stream, mirroring the text path's
 * SSE framing (`data: <StreamEvent>\n\n` … `event: done\ndata: [DONE]\n\n`) so
 * the client's `useToolStream` consumes both paths identically.
 *
 *  - image: resolve the media model (explicit id or basic/advanced tier), call
 *    the @oxagen/ai image chokepoint (telemetry + billing live inside it), and
 *    emit a `component` event the registry renders via "image-preview".
 *  - video: Veo renders take minutes, so we do not block the request — create a
 *    pending generated_assets row, dispatch the `agent/video.render` Inngest job
 *    (which generates, uploads to blob, and flips the row to `ready`), and emit a
 *    `video-result` component that polls the serving route until the asset is ready.
 */
export function streamMediaGeneration(args: {
  kind: "image" | "video";
  prompt: string;
  mediaModel: string | null;
  mediaTier: "basic" | "advanced";
  userId: string;
  conversationId: string | null;
  messageId: string | null;
  telemetry: { orgId: string; workspaceId: string; executionStepId: string };
}): Response {
  const encoder = new TextEncoder();
  const responseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Enqueue-safe emit, mirroring the text route: once the client
      // disconnects the controller is closed and enqueue THROWS. An unguarded
      // throw here escapes into the catch below, which emits again, throws
      // again, and leaves start() rejecting. Latch `closed` instead.
      let closed = false;
      function emit(event: StreamEvent): void {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          closed = true;
        }
      }
      const toolCallId = randomUUID();
      try {
        if (args.kind === "image") {
          const modelId = args.mediaModel ?? imageTierModelId(args.mediaTier);
          const imageModel = selectImageModel({ model: modelId });
          try {
            const { images } = await generateImageFor({
              model: imageModel,
              prompt: args.prompt,
              n: 1,
              size: "1024x1024",
              telemetry: {
                orgId: args.telemetry.orgId,
                workspaceId: args.telemetry.workspaceId,
                surface: "app",
                executionStepId: args.telemetry.executionStepId,
              },
            });
            const b64 = images[0];
            if (!b64) {
              emit({
                type: "component",
                toolCallId,
                componentId: "image-preview",
                props: {
                  placeholder: true,
                  prompt: args.prompt,
                  alt: args.prompt,
                },
              });
            } else {
              // Persist to blob storage + a generated_assets row, then render via
              // the access-controlled serving route (never the raw blob URL).
              const asset = await persistGeneratedAsset({
                orgId: args.telemetry.orgId,
                workspaceId: args.telemetry.workspaceId,
                userId: args.userId,
                kind: "image",
                accessPolicy: "org",
                bytes: Buffer.from(b64, "base64"),
                mimeType: "image/png",
                prompt: args.prompt,
                model: modelId,
                conversationId: args.conversationId,
                messageId: args.messageId,
              });
              emit({
                type: "component",
                toolCallId,
                componentId: "image-preview",
                props: { url: asset.serveUrl, alt: args.prompt },
              });
            }
          } catch (genErr) {
            // Generation failed (no key / unsupported model / provider error):
            // render the image-preview empty-state with the reason instead of
            // failing the turn.
            const reason =
              genErr instanceof Error ? genErr.message : "Generation failed";
            emit({
              type: "component",
              toolCallId,
              componentId: "image-preview",
              props: {
                placeholder: true,
                prompt: args.prompt,
                alt: args.prompt,
                errorReason: reason,
              },
            });
          }
        } else {
          // video — asynchronous render. Create a pending generated_assets row,
          // dispatch the `agent/video.render` Inngest job, and emit a video-result
          // component that polls the serving route until the asset is ready.
          const modelId = args.mediaModel ?? videoTierModelId(args.mediaTier);
          const pending = await createPendingGeneratedAsset({
            orgId: args.telemetry.orgId,
            workspaceId: args.telemetry.workspaceId,
            userId: args.userId,
            kind: "video",
            accessPolicy: "org",
            mimeType: "video/mp4",
            prompt: args.prompt,
            model: modelId,
            conversationId: args.conversationId,
            messageId: args.messageId,
          });
          await eventClient.send({
            name: "agent/video.render",
            data: {
              assetId: pending.id,
              orgId: args.telemetry.orgId,
              workspaceId: args.telemetry.workspaceId,
              userId: args.userId,
              prompt: args.prompt,
              model: modelId,
              mediaTier: args.mediaTier,
            },
          });
          emit({
            type: "component",
            toolCallId,
            componentId: "video-result",
            props: { url: pending.serveUrl, prompt: args.prompt },
          });
        }
      } catch (err) {
        // Emit a structured `error` event so a media-generation failure shows as
        // a readable toast, never a raw envelope rendered inline in the chat.
        const { code, message } = formatStreamError(err);
        emit({
          type: "error",
          messageId: toolCallId,
          message,
          ...(code !== undefined ? { code } : {}),
        });
      } finally {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode("event: done\ndata: [DONE]\n\n"));
          } catch {
            // Controller may already be errored.
            closed = true;
          }
        }
        // close() THROWS on an already-closed/errored controller, and a throw
        // out of start() surfaces as an unhandled rejection.
        if (!closed) {
          try {
            controller.close();
          } catch {
            // Already closed by a client disconnect — nothing left to do.
          }
        }
      }
    },
  });

  return new Response(responseStream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
