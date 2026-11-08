import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { getDb } from "../../../../../../db";
import { relayAttachments, relayTasks } from "../../../../../../db/schema";
import { contentDispositionFileName } from "../../../../../../lib/attachments";

export async function GET(request: Request, context: { params: Promise<{ id: string; attachmentId: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!env.BUCKET) return Response.json({ error: "附件儲存空間尚未設定" }, { status: 503 });
  const { id, attachmentId } = await context.params;
  const [attachment] = await getDb()
    .select({
      storageKey: relayAttachments.storageKey,
      fileName: relayAttachments.fileName,
      mimeType: relayAttachments.mimeType,
      size: relayAttachments.size,
    })
    .from(relayAttachments)
    .innerJoin(relayTasks, eq(relayTasks.id, relayAttachments.taskId))
    .where(and(
      eq(relayAttachments.id, attachmentId),
      eq(relayAttachments.taskId, id),
      eq(relayAttachments.ownerId, ownerId),
      eq(relayTasks.ownerId, ownerId),
    ))
    .limit(1);
  if (!attachment) return Response.json({ error: "找不到附件" }, { status: 404 });
  const object = await env.BUCKET.get(attachment.storageKey);
  if (!object) return Response.json({ error: "附件內容不存在" }, { status: 404 });
  return new Response(object.body, {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": contentDispositionFileName(attachment.fileName),
      "Content-Length": String(attachment.size),
      "Content-Type": attachment.mimeType,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
