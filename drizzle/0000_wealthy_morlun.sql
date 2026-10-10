CREATE TABLE `relay_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`original_request` text DEFAULT '' NOT NULL,
	`expected_head` text DEFAULT '' NOT NULL,
	`kimi_report` text DEFAULT '' NOT NULL,
	`codex_handoff` text DEFAULT '' NOT NULL,
	`codex_review` text DEFAULT '' NOT NULL,
	`next_kimi_prompt` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
