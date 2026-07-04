import { Hono } from "hono";
import { z } from "zod";
import { a2aCardGet } from "@oxagen/oxagen/contracts/a2a.card.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import { requestBaseUrl } from "./base-url";
import type { AppEnv } from "../../app";
import {
  A2A_ERROR,
  A2A_METHODS,
  A2A_TERMINAL_STATES,
  a2aMessageSendParams,
  a2aTaskIdParams,
  a2aTaskQueryParams,
  jsonRpcError,
  jsonRpcRequest,
  jsonRpcResult,
  type A2AArtifactUpdateEvent,
  type A2AMessage,
  type A2AStatusUpdateEvent,
  type JsonRpcId,
} from "./protocol";
import {
  createTask,
  loadContextHistory,
  loadTask,
  toA2ATask,
  updateTask,
} from "./task-store";
import { runA2ATask } from "./bridge";

export const a2aRpcRoute = new Hono<AppEnv>();

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

/** Normalize an inbound A2A message: force kind and bind the contextId. */
function normalizeUserMessage(
  message: A2AMessage,
  contextId: string,
): A2AMessage {
  return { ...message, kind: "message", role: "user", contextId };
}

/** Mint a fresh A2A conversation id when the client does not supply one. */
function mintContextId(): string {
  return `ctx_${crypto.randomUUID().replace(/-/g, "")}`;
}

a2aRpcRoute.post("/", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, A2A_ERROR.parseError, "Invalid JSON"), 200);
  }

  // JSON-RPC batching is not supported by the A2A binding.
  if (Array.isArray(rawBody)) {
    return c.json(
      jsonRpcError(null, A2A_ERROR.invalidRequest, "Batch requests are not supported"),
      200,
    );
  }

  const envelope = jsonRpcRequest.safeParse(rawBody);
  if (!envelope.success) {
    return c.json(
      jsonRpcError(null, A2A_ERROR.invalidRequest, "Malformed JSON-RPC request"),
      200,
    );
  }

  const { id = null, method, params } = envelope.data;
  const rpcId: JsonRpcId = id ?? null;

  // capabilityContext throws 400 when the API key did not bind org+workspace.
  const ctx = capabilityContext(c);

  try {
    switch (method) {
      case A2A_METHODS.messageSend: {
        const parsed = a2aMessageSendParams.safeParse(params);
        if (!parsed.success) {
          return c.json(
            jsonRpcError(
              rpcId,
              A2A_ERROR.invalidParams,
              "Invalid message/send params",
              parsed.error.issues,
            ),
            200,
          );
        }
        const contextId = parsed.data.message.contextId ?? mintContextId();
        const userMessage = normalizeUserMessage(parsed.data.message, contextId);
        const task = await createTask(ctx, { contextId, userMessage });
        const history = await loadContextHistory(ctx, contextId);
        const final = await runA2ATask({ ctx, task, history });
        return c.json(jsonRpcResult(rpcId, toA2ATask(final)), 200);
      }

      case A2A_METHODS.messageStream: {
        const parsed = a2aMessageSendParams.safeParse(params);
        if (!parsed.success) {
          return c.json(
            jsonRpcError(
              rpcId,
              A2A_ERROR.invalidParams,
              "Invalid message/stream params",
              parsed.error.issues,
            ),
            200,
          );
        }
        const contextId = parsed.data.message.contextId ?? mintContextId();
        const userMessage = normalizeUserMessage(parsed.data.message, contextId);
        const task = await createTask(ctx, { contextId, userMessage });
        const history = await loadContextHistory(ctx, contextId);

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const send = (result: unknown): void => {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(jsonRpcResult(rpcId, result))}\n\n`,
                ),
              );
            };
            // A2A: the first stream event is the initial Task (submitted).
            send(toA2ATask(task));
            try {
              await runA2ATask({
                ctx,
                task,
                history,
                onEvent: (
                  event: A2AStatusUpdateEvent | A2AArtifactUpdateEvent,
                ) => send(event),
              });
            } catch (err) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify(
                    jsonRpcError(
                      rpcId,
                      A2A_ERROR.internalError,
                      err instanceof Error ? err.message : "Task failed",
                    ),
                  )}\n\n`,
                ),
              );
            } finally {
              controller.close();
            }
          },
        });
        return new Response(stream, { headers: SSE_HEADERS });
      }

      case A2A_METHODS.tasksGet: {
        const parsed = a2aTaskQueryParams.safeParse(params);
        if (!parsed.success) {
          return c.json(
            jsonRpcError(rpcId, A2A_ERROR.invalidParams, "Invalid tasks/get params"),
            200,
          );
        }
        const row = await loadTask(ctx, parsed.data.id);
        if (!row) {
          return c.json(
            jsonRpcError(rpcId, A2A_ERROR.taskNotFound, "Task not found"),
            200,
          );
        }
        return c.json(
          jsonRpcResult(rpcId, toA2ATask(row, parsed.data.historyLength)),
          200,
        );
      }

      case A2A_METHODS.tasksCancel: {
        const parsed = a2aTaskIdParams.safeParse(params);
        if (!parsed.success) {
          return c.json(
            jsonRpcError(rpcId, A2A_ERROR.invalidParams, "Invalid tasks/cancel params"),
            200,
          );
        }
        const row = await loadTask(ctx, parsed.data.id);
        if (!row) {
          return c.json(
            jsonRpcError(rpcId, A2A_ERROR.taskNotFound, "Task not found"),
            200,
          );
        }
        if (A2A_TERMINAL_STATES.has(row.state)) {
          return c.json(
            jsonRpcError(
              rpcId,
              A2A_ERROR.taskNotCancelable,
              `Task is already ${row.state}`,
            ),
            200,
          );
        }
        const canceled = await updateTask(ctx, parsed.data.id, {
          state: "canceled",
        });
        return c.json(
          jsonRpcResult(rpcId, toA2ATask(canceled ?? row)),
          200,
        );
      }

      case A2A_METHODS.tasksResubscribe: {
        const parsed = a2aTaskIdParams.safeParse(params);
        if (!parsed.success) {
          return c.json(
            jsonRpcError(rpcId, A2A_ERROR.invalidParams, "Invalid tasks/resubscribe params"),
            200,
          );
        }
        const row = await loadTask(ctx, parsed.data.id);
        if (!row) {
          return c.json(
            jsonRpcError(rpcId, A2A_ERROR.taskNotFound, "Task not found"),
            200,
          );
        }
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const statusEvent: A2AStatusUpdateEvent = {
              kind: "status-update",
              taskId: row.publicId,
              contextId: row.contextId,
              status: {
                state: row.state,
                ...(row.statusMessage ? { message: row.statusMessage } : {}),
                timestamp: row.updatedAt.toISOString(),
              },
              final: A2A_TERMINAL_STATES.has(row.state),
            };
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify(jsonRpcResult(rpcId, statusEvent))}\n\n`,
              ),
            );
            controller.close();
          },
        });
        return new Response(stream, { headers: SSE_HEADERS });
      }

      case A2A_METHODS.authExtendedCard: {
        const card = await invoke(
          a2aCardGet.name,
          { baseUrl: requestBaseUrl(c) },
          ctx,
          { surface: "api" },
        );
        return c.json(jsonRpcResult(rpcId, card), 200);
      }

      default: {
        // Push-notification config methods are advertised as unsupported.
        if (method.startsWith("tasks/pushNotificationConfig")) {
          return c.json(
            jsonRpcError(
              rpcId,
              A2A_ERROR.pushNotificationNotSupported,
              "Push notifications are not supported",
            ),
            200,
          );
        }
        return c.json(
          jsonRpcError(rpcId, A2A_ERROR.methodNotFound, `Unknown method: ${method}`),
          200,
        );
      }
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json(
        jsonRpcError(rpcId, A2A_ERROR.invalidParams, "Invalid params", err.issues),
        200,
      );
    }
    console.error("[a2a.rpc] internal error:", err);
    return c.json(
      jsonRpcError(
        rpcId,
        A2A_ERROR.internalError,
        err instanceof Error ? err.message : "Internal error",
      ),
      200,
    );
  }
});
