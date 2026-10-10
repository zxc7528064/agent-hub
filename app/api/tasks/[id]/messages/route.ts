import { and, asc, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../../db";
import { relayMessages, relayTasks } from "../../../../../db/schema";

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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  if (!(await ownedTask(id, ownerId))) return Response.json({ error: "找不到對話" }, { status: 404 });
  const messages = await getDb()
    .select()
    .from(relayMessages)
    .where(and(eq(relayMessages.taskId, id), eq(relayMessages.ownerId, ownerId)))
    .orderBy(asc(relayMessages.createdAt), asc(relayMessages.id))
    .limit(500);
  return Response.json({ messages }, { headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!sameOrigin(request)) return Response.json({ error: "Invalid origin" }, { status: 403 });
  const { id } = await context.params;
  if (!(await ownedTask(id, ownerId))) return Response.json({ error: "找不到對話" }, { status: 404 });
  const input = (await request.json()) as { role?: string; body?: string };
  const role = input.role?.trim() ?? "";
  const body = input.body?.trim().slice(0, 80000) ?? "";
  if (!allowedRoles.has(role) || !body) return Response.json({ error: "訊息內容或來源無效" }, { status: 400 });
  const [message] = await getDb().insert(relayMessages).values({
    id: crypto.randomUUID(), taskId: id, ownerId, role, body,
  }).returning();
  await getDb().update(relayTasks).set({ updatedAt: sql`CURRENT_TIMESTAMP` }).where(and(eq(relayTasks.id, id), eq(relayTasks.ownerId, ownerId)));
  return Response.json({ message }, { status: 201 });
}
