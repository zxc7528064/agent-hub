import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const relayTasks = sqliteTable("relay_tasks", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  title: text("title").notNull(),
  status: text("status").notNull().default("draft"),
  originalRequest: text("original_request").notNull().default(""),
  expectedHead: text("expected_head").notNull().default(""),
  kimiReport: text("kimi_report").notNull().default(""),
  codexHandoff: text("codex_handoff").notNull().default(""),
  codexReview: text("codex_review").notNull().default(""),
  nextKimiPrompt: text("next_kimi_prompt").notNull().default(""),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const relayMessages = sqliteTable("relay_messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull().references(() => relayTasks.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  role: text("role").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [index("relay_messages_task_created_idx").on(table.taskId, table.createdAt)]);

export const relayAttachments = sqliteTable("relay_attachments", {
  id: text("id").primaryKey(),
  messageId: text("message_id").notNull().references(() => relayMessages.id, { onDelete: "cascade" }),
  taskId: text("task_id").notNull().references(() => relayTasks.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  size: integer("size").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  sha256: text("sha256").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (table) => [
  index("relay_attachments_message_idx").on(table.messageId),
  index("relay_attachments_task_created_idx").on(table.taskId, table.createdAt),
]);
