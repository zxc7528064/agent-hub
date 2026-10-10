import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../../db";
import { relayTasks } from "../../../../db/schema";

const editable = new Set([
  "status",
  "originalRequest",
  "expectedHead",
  "kimiReport",
  "codexHandoff",
  "codexReview",
  "nextKimiPrompt",
]);

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const ownerId = request.headers.get("oai-authenticated-user-id");
  if (!ownerId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) {
    return Response.json({ error: "Invalid origin" }, { status: 403 });
  }
  const { id } = await context.params;
  const body = (await request.json()) as Record<string, unknown>;
  const values: Partial<typeof relayTasks.$inferInsert> = {
    updatedAt: sql`CURRENT_TIMESTAMP`,
  };
  for (const [key, value] of Object.entries(body)) {
    if (editable.has(key) && typeof value === "string") {
      values[key] = value.slice(0, 80000);
    }
  }
  const [task] = await getDb()
    .update(relayTasks)
    .set(values)
    .where(and(eq(relayTasks.id, id), eq(relayTasks.ownerId, ownerId)))
    .returning();
  if (!task) return Response.json({ error: "找不到任務" }, { status: 404 });
  return Response.json({ task });
}
