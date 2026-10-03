CREATE TABLE `albums` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`name` varchar(255) NOT NULL,
	`description` text,
	`releaseYear` int,
	`coverStorageKey` varchar(512),
	`coverUrl` varchar(1024),
	`sortOrder` int NOT NULL DEFAULT 0,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `albums_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audioVersions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`songId` int NOT NULL,
	`label` varchar(255) NOT NULL,
	`originalFileName` varchar(512) NOT NULL,
	`storageKey` varchar(512) NOT NULL,
	`storageUrl` varchar(1024) NOT NULL,
	`mimeType` varchar(128) NOT NULL,
	`byteSize` int NOT NULL,
	`isPrimary` boolean NOT NULL DEFAULT false,
	`id3Title` varchar(255),
	`id3Artist` varchar(255),
	`id3Album` varchar(255),
	`id3TrackNumber` varchar(32),
	`id3Year` varchar(8),
	`id3Genre` varchar(128),
	`id3Comment` text,
	`taggedStorageKey` varchar(512),
	`taggedStorageUrl` varchar(1024),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `audioVersions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `lyricDocuments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`albumId` int,
	`title` varchar(255) NOT NULL,
	`stylePrompt` text,
	`lyrics` text,
	`notes` text,
	`coverStorageKey` varchar(512),
	`coverUrl` varchar(1024),
	`status` enum('draft','complete') NOT NULL DEFAULT 'draft',
	`completedAt` timestamp,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `lyricDocuments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `songs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`albumId` int,
	`sourceDocumentId` int NOT NULL,
	`title` varchar(255) NOT NULL,
	`completedAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `songs_id` PRIMARY KEY(`id`)
);
