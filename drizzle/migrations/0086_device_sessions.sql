CREATE TABLE `device_sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`device_name` text NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
