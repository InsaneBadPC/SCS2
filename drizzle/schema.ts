import {
  boolean,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export const albums = mysqlTable("albums", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  releaseYear: int("releaseYear"),
  coverStorageKey: varchar("coverStorageKey", { length: 512 }),
  coverUrl: varchar("coverUrl", { length: 1024 }),
  sortOrder: int("sortOrder").default(0).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const lyricDocuments = mysqlTable("lyricDocuments", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  albumId: int("albumId"),
  title: varchar("title", { length: 255 }).notNull(),
  stylePrompt: text("stylePrompt"),
  lyrics: text("lyrics"),
  notes: text("notes"),
  coverStorageKey: varchar("coverStorageKey", { length: 512 }),
  coverUrl: varchar("coverUrl", { length: 1024 }),
  status: mysqlEnum("status", ["draft", "complete"]).default("draft").notNull(),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const songs = mysqlTable("songs", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  albumId: int("albumId"),
  sourceDocumentId: int("sourceDocumentId"),
  title: varchar("title", { length: 255 }).notNull(),
  stylePrompt: text("stylePrompt"),
  lyrics: text("lyrics"),
  notes: text("notes"),
  coverStorageKey: varchar("coverStorageKey", { length: 512 }),
  coverUrl: varchar("coverUrl", { length: 1024 }),
  completedAt: timestamp("completedAt").defaultNow().notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const audioVersions = mysqlTable("audioVersions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  songId: int("songId").notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  originalFileName: varchar("originalFileName", { length: 512 }).notNull(),
  storageKey: varchar("storageKey", { length: 512 }).notNull(),
  storageUrl: varchar("storageUrl", { length: 1024 }).notNull(),
  mimeType: varchar("mimeType", { length: 128 }).notNull(),
  byteSize: int("byteSize").notNull(),
  rating: int("rating").default(0).notNull(),
  isPrimary: boolean("isPrimary").default(false).notNull(),
  isFinal: boolean("isFinal").default(false).notNull(),
  id3Title: varchar("id3Title", { length: 255 }),
  id3Artist: varchar("id3Artist", { length: 255 }),
  id3Album: varchar("id3Album", { length: 255 }),
  id3TrackNumber: varchar("id3TrackNumber", { length: 32 }),
  id3Year: varchar("id3Year", { length: 8 }),
  id3Genre: varchar("id3Genre", { length: 128 }),
  id3Comment: text("id3Comment"),
  taggedStorageKey: varchar("taggedStorageKey", { length: 512 }),
  taggedStorageUrl: varchar("taggedStorageUrl", { length: 1024 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const customRhymeWords = mysqlTable("customRhymeWords", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  word: varchar("word", { length: 100 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;
export type Album = typeof albums.$inferSelect;
export type InsertAlbum = typeof albums.$inferInsert;
export type LyricDocument = typeof lyricDocuments.$inferSelect;
export type InsertLyricDocument = typeof lyricDocuments.$inferInsert;
export type Song = typeof songs.$inferSelect;
export type InsertSong = typeof songs.$inferInsert;
export type AudioVersion = typeof audioVersions.$inferSelect;
export type InsertAudioVersion = typeof audioVersions.$inferInsert;
export type CustomRhymeWord = typeof customRhymeWords.$inferSelect;
export type InsertCustomRhymeWord = typeof customRhymeWords.$inferInsert;
