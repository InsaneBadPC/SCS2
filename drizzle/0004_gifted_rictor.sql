CREATE TABLE `customRhymeWords` (
	`id` int AUTO_INCREMENT NOT NULL,
	`userId` int NOT NULL,
	`word` varchar(100) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `customRhymeWords_id` PRIMARY KEY(`id`)
);
