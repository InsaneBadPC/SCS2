ALTER TABLE `songs` MODIFY COLUMN `sourceDocumentId` int;--> statement-breakpoint
ALTER TABLE `songs` ADD `stylePrompt` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `lyrics` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `notes` text;--> statement-breakpoint
ALTER TABLE `songs` ADD `coverStorageKey` varchar(512);--> statement-breakpoint
ALTER TABLE `songs` ADD `coverUrl` varchar(1024);