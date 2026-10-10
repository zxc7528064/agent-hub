import { desc, eq } from "drizzle-orm";
import { getDb } from "../../../db";
import { relayTasks } from "../../../db/schema";

function userId(request: Request) {
  return request.headers.get("oai-authenticated-user-id");
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  return !!origin && origin === new URL(request.url).origin;
}

export async function GET(request: Request) {
  const ownerId = userId(request);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const tasks = await getDb()
    .select()
    .from(relayTasks)
    .where(eq(relayTasks.ownerId, ownerId))
    .orderBy(desc(relayTasks.updatedAt))
    .limit(50);
  return Response.json({ tasks }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const ownerId = userId(request);
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const body = (await request.json()) as { title?: string; originalRequest?: string };
  const title = body.title?.trim().slice(0, 160) ?? "";
  if (!title) return Response.json({ error: "請輸入任務名稱" }, { status: 400 });
  const id = crypto.randomUUID();
  const [task] = await getDb()
    .insert(relayTasks)
    .values({
      id,
      ownerId,
      title,
      originalRequest: body.originalRequest?.trim().slice(0, 40000) ?? "",
    })
    .returning();
  return Response.json({ task }, { status: 201 });
}
