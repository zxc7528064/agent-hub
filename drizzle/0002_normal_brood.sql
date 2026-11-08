CREATE TABLE `relay_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`task_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`storage_key` text NOT NULL,
	`sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `relay_messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `relay_tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `relay_attachments_storage_key_unique` ON `relay_attachments` (`storage_key`);--> statement-breakpoint
CREATE INDEX `relay_attachments_message_idx` ON `relay_attachments` (`message_id`);--> statement-breakpoint
CREATE INDEX `relay_attachments_task_created_idx` ON `relay_attachments` (`task_id`,`created_at`);