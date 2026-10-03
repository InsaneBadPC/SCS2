import { and, asc, desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

import {
  albums,
  audioVersions,
  customRhymeWords,
  type InsertAlbum,
  type InsertAudioVersion,
  type InsertLyricDocument,
  type InsertSong,
  type InsertUser,
  lyricDocuments,
  songs,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

let _db: ReturnType<typeof drizzle> | null = null;

export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

async function databaseOrThrow() {
  const db = await getDb();
  if (!db) throw new Error("Cloudová databáze není momentálně dostupná.");
  return db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) throw new Error("User openId is required for upsert");
  const db = await getDb();
  if (!db) return;

  const values: InsertUser = { openId: user.openId, lastSignedIn: new Date() };
  const updateSet: Record<string, unknown> = { lastSignedIn: new Date() };
  (["name", "email", "loginMethod"] as const).forEach((field) => {
    if (user[field] !== undefined) {
      values[field] = user[field] ?? null;
      updateSet[field] = user[field] ?? null;
    }
  });
  values.role = user.role ?? (user.openId === ENV.ownerOpenId ? "admin" : "user");
  updateSet.role = values.role;

  await db.insert(users).values(values).onDuplicateKeyUpdate({ set: updateSet });
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) return undefined;
  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);
  return result[0];
}

export async function getStudioSnapshot(userId: number) {
  const db = await databaseOrThrow();
  const [albumRows, documentRows, songRows, versionRows, rhymeWordRows] = await Promise.all([
    db.select().from(albums).where(eq(albums.userId, userId)).orderBy(asc(albums.sortOrder), asc(albums.name)),
    db.select().from(lyricDocuments).where(eq(lyricDocuments.userId, userId)).orderBy(desc(lyricDocuments.updatedAt)),
    db.select().from(songs).where(eq(songs.userId, userId)).orderBy(desc(songs.completedAt)),
    db.select().from(audioVersions).where(eq(audioVersions.userId, userId)).orderBy(desc(audioVersions.isFinal), desc(audioVersions.isPrimary), desc(audioVersions.rating), asc(audioVersions.label)),
    db.select().from(customRhymeWords).where(eq(customRhymeWords.userId, userId)).orderBy(asc(customRhymeWords.word)),
  ]);
  return { albums: albumRows, documents: documentRows, songs: songRows, versions: versionRows, rhymeWords: rhymeWordRows };
}

export async function createAlbum(data: InsertAlbum) {
  const db = await databaseOrThrow();
  const result = await db.insert(albums).values(data);
  return Number(result[0].insertId);
}

export async function updateAlbum(userId: number, id: number, data: Partial<InsertAlbum>) {
  const db = await databaseOrThrow();
  await db.update(albums).set(data).where(and(eq(albums.id, id), eq(albums.userId, userId)));
}

export async function createDocument(data: InsertLyricDocument) {
  const db = await databaseOrThrow();
  const result = await db.insert(lyricDocuments).values(data);
  return Number(result[0].insertId);
}

export async function updateDocument(userId: number, id: number, data: Partial<InsertLyricDocument>) {
  const db = await databaseOrThrow();
  await db.update(lyricDocuments).set(data).where(and(eq(lyricDocuments.id, id), eq(lyricDocuments.userId, userId)));
}

export async function completeDocument(userId: number, id: number) {
  const db = await databaseOrThrow();
  const document = (await db.select().from(lyricDocuments).where(and(eq(lyricDocuments.id, id), eq(lyricDocuments.userId, userId))).limit(1))[0];
  if (!document) throw new Error("Textový dokument nebyl nalezen.");

  const now = new Date();
  await db.update(lyricDocuments).set({ status: "complete", completedAt: now }).where(eq(lyricDocuments.id, id));
  const existingSong = (await db.select().from(songs).where(and(eq(songs.sourceDocumentId, id), eq(songs.userId, userId))).limit(1))[0];
  if (existingSong) {
    await db.update(songs).set({ title: document.title, albumId: document.albumId, stylePrompt: document.stylePrompt, lyrics: document.lyrics, notes: document.notes, coverStorageKey: document.coverStorageKey, coverUrl: document.coverUrl, completedAt: now }).where(eq(songs.id, existingSong.id));
    return existingSong.id;
  }
  const result = await db.insert(songs).values({ userId, sourceDocumentId: id, albumId: document.albumId, title: document.title, stylePrompt: document.stylePrompt, lyrics: document.lyrics, notes: document.notes, coverStorageKey: document.coverStorageKey, coverUrl: document.coverUrl, completedAt: now });
  return Number(result[0].insertId);
}

export async function createSong(data: InsertSong) {
  const db = await databaseOrThrow();
  const result = await db.insert(songs).values(data);
  return Number(result[0].insertId);
}

export async function updateSong(userId: number, id: number, data: Partial<InsertSong>) {
  const db = await databaseOrThrow();
  await db.update(songs).set(data).where(and(eq(songs.id, id), eq(songs.userId, userId)));
}

export async function createAudioVersion(data: InsertAudioVersion) {
  const db = await databaseOrThrow();
  const result = await db.insert(audioVersions).values(data);
  return Number(result[0].insertId);
}

export async function updateAudioVersion(userId: number, id: number, data: Partial<InsertAudioVersion>) {
  const db = await databaseOrThrow();
  await db.update(audioVersions).set(data).where(and(eq(audioVersions.id, id), eq(audioVersions.userId, userId)));
}

export async function markAudioVersionPrimary(userId: number, id: number) {
  const db = await databaseOrThrow();
  const version = await getAudioVersion(userId, id);
  if (!version) throw new Error("Zvuková verze nebyla nalezena.");
  await db.update(audioVersions).set({ isPrimary: false }).where(and(eq(audioVersions.userId, userId), eq(audioVersions.songId, version.songId)));
  await db.update(audioVersions).set({ isPrimary: true }).where(and(eq(audioVersions.id, id), eq(audioVersions.userId, userId)));
}

export async function markAudioVersionFinal(userId: number, id: number) {
  const db = await databaseOrThrow();
  const version = await getAudioVersion(userId, id);
  if (!version) throw new Error("Zvuková verze nebyla nalezena.");
  await db.update(audioVersions).set({ isPrimary: false, isFinal: false }).where(and(eq(audioVersions.userId, userId), eq(audioVersions.songId, version.songId)));
  await db.update(audioVersions).set({ isPrimary: true, isFinal: true }).where(and(eq(audioVersions.id, id), eq(audioVersions.userId, userId)));
}

export async function deleteAudioVersion(userId: number, id: number) {
  const db = await databaseOrThrow();
  await db.delete(audioVersions).where(and(eq(audioVersions.id, id), eq(audioVersions.userId, userId)));
}

export async function getAudioVersion(userId: number, id: number) {
  const db = await databaseOrThrow();
  return (await db.select().from(audioVersions).where(and(eq(audioVersions.id, id), eq(audioVersions.userId, userId))).limit(1))[0];
}

export async function getSong(userId: number, id: number) {
  const db = await databaseOrThrow();
  return (await db.select().from(songs).where(and(eq(songs.id, id), eq(songs.userId, userId))).limit(1))[0];
}

export async function getAlbum(userId: number, id: number) {
  const db = await databaseOrThrow();
  return (await db.select().from(albums).where(and(eq(albums.id, id), eq(albums.userId, userId))).limit(1))[0];
}

export async function createCustomRhymeWord(userId: number, word: string) {
  const db = await databaseOrThrow();
  const existing = (await db.select().from(customRhymeWords).where(and(eq(customRhymeWords.userId, userId), eq(customRhymeWords.word, word))).limit(1))[0];
  if (existing) return existing.id;
  const result = await db.insert(customRhymeWords).values({ userId, word });
  return Number(result[0].insertId);
}

export async function deleteCustomRhymeWord(userId: number, id: number) {
  const db = await databaseOrThrow();
  await db.delete(customRhymeWords).where(and(eq(customRhymeWords.id, id), eq(customRhymeWords.userId, userId)));
}
