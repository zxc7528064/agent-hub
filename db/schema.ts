import { sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

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
