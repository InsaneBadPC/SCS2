ALTER TABLE `audioVersions` ADD `rating` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `audioVersions` ADD `isFinal` boolean DEFAULT false NOT NULL;