import { env } from "cloudflare:workers";
import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { relayAttachments, relayMessages, relayTasks } from "../../../../../db/schema";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_ATTACHMENT_BYTES,
  normalizedMimeType,
  safeFileName,
  type AttachmentView,
} from "../../../../../lib/attachments";

const allowedRoles = new Set(["user", "kimi", "codex"]);

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin;
}

async function ownedTask(id: string, ownerId: string) {
  const [task] = await getDb()
    .select({ id: relayTasks.id })
    .from(relayTasks)
    .where(and(eq(relayTasks.id, id), eq(relayTasks.ownerId, ownerId)))
    .limit(1);
  return task;
}

function attachmentView(row: typeof relayAttachments.$inferSelect): AttachmentView {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.createdAt,
  };
}

async function sha256(bytes: ArrayBuffer) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id: taskId } = await context.params;
  if (!(await ownedTask(taskId, ownerId))) return Response.json({ error: "找不到對話" }, { status: 404 });
  const [messages, attachments] = await Promise.all([
    getDb()
      .select()
      .from(relayMessages)
      .where(and(eq(relayMessages.taskId, taskId), eq(relayMessages.ownerId, ownerId)))
      .orderBy(asc(relayMessages.createdAt), asc(relayMessages.id))
      .limit(500),
    getDb()
      .select()
      .from(relayAttachments)
      .where(and(eq(relayAttachments.taskId, taskId), eq(relayAttachments.ownerId, ownerId)))
      .orderBy(asc(relayAttachments.createdAt), asc(relayAttachments.id)),
  ]);
  const byMessage = new Map<string, AttachmentView[]>();
  for (const attachment of attachments) {
    const current = byMessage.get(attachment.messageId) ?? [];
    current.push(attachmentView(attachment));
    byMessage.set(attachment.messageId, current);
  }
  return Response.json({
    messages: messages.map((message) => ({ ...message, attachments: byMessage.get(message.id) ?? [] })),
  }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const { id: taskId } = await context.params;
  if (!(await ownedTask(taskId, ownerId))) return Response.json({ error: "找不到對話" }, { status: 404 });

  const contentType = request.headers.get("content-type") ?? "";
  let role = "";
  let body = "";
  let files: File[] = [];
  if (contentType.startsWith("multipart/form-data")) {
    const form = await request.formData();
    role = String(form.get("role") ?? "").trim();
    body = String(form.get("body") ?? "").trim().slice(0, 80000);
    files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
  } else if (contentType.startsWith("application/json")) {
    const input = (await request.json()) as { role?: string; body?: string };
    role = input.role?.trim() ?? "";
    body = input.body?.trim().slice(0, 80000) ?? "";
  } else {
    return Response.json({ error: "不支援的訊息格式" }, { status: 415 });
  }

  if (!allowedRoles.has(role) || (!body && files.length === 0)) {
    return Response.json({ error: "訊息內容、附件或來源無效" }, { status: 400 });
  }
  if (files.length > MAX_ATTACHMENT_COUNT) {
    return Response.json({ error: `每則訊息最多 ${MAX_ATTACHMENT_COUNT} 個附件` }, { status: 413 });
  }
  if (files.some((file) => file.size > MAX_ATTACHMENT_BYTES)) {
    return Response.json({ error: "單一附件不得超過 10 MB" }, { status: 413 });
  }
  if (files.reduce((total, file) => total + file.size, 0) > MAX_TOTAL_ATTACHMENT_BYTES) {
    return Response.json({ error: "附件總大小不得超過 25 MB" }, { status: 413 });
  }
  if (files.length > 0 && !env.BUCKET) {
    return Response.json({ error: "附件儲存空間尚未設定" }, { status: 503 });
  }

  const messageId = crypto.randomUUID();
  const prepared = await Promise.all(files.map(async (file) => {
    const attachmentId = crypto.randomUUID();
    const bytes = await file.arrayBuffer();
    return {
      id: attachmentId,
      messageId,
      taskId,
      ownerId,
      fileName: safeFileName(file.name),
      mimeType: normalizedMimeType(file.type),
      size: file.size,
      storageKey: `relay/${taskId}/${messageId}/${attachmentId}`,
      sha256: await sha256(bytes),
      bytes,
    };
  }));
  const uploadedKeys: string[] = [];
  try {
    for (const attachment of prepared) {
      await env.BUCKET!.put(attachment.storageKey, attachment.bytes, {
        httpMetadata: { contentType: attachment.mimeType },
        customMetadata: { attachmentId: attachment.id, messageId },
      });
      uploadedKeys.push(attachment.storageKey);
    }
    const [message] = await getDb().insert(relayMessages).values({
      id: messageId, taskId, ownerId, role, body,
    }).returning();
    if (prepared.length > 0) {
      await getDb().insert(relayAttachments).values(prepared.map((attachment) => ({
        id: attachment.id,
        messageId: attachment.messageId,
        taskId: attachment.taskId,
        ownerId: attachment.ownerId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        size: attachment.size,
        storageKey: attachment.storageKey,
        sha256: attachment.sha256,
      })));
    }
    await getDb().update(relayTasks).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(relayTasks.id, taskId), eq(relayTasks.ownerId, ownerId)));
    return Response.json({
      message: {
        ...message,
        attachments: prepared.map((attachment) => ({
          id: attachment.id,
          fileName: attachment.fileName,
          mimeType: attachment.mimeType,
          size: attachment.size,
          sha256: attachment.sha256,
          createdAt: message.createdAt,
        } satisfies AttachmentView)),
      },
    }, { status: 201 });
  } catch (error) {
    await Promise.allSettled(uploadedKeys.map((key) => env.BUCKET!.delete(key)));
    try {
      await getDb().delete(relayMessages).where(and(eq(relayMessages.id, messageId), eq(relayMessages.ownerId, ownerId)));
    } catch {
      // Best-effort rollback; the attachment rows cascade if the message was written.
    }
    console.error("Unable to save message attachments", error);
    return Response.json({ error: "附件儲存失敗，請稍後重試" }, { status: 500 });
  }
}
