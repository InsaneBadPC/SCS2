import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";

import { useAuth } from "@/hooks/use-auth";
import { normalizeOptionalId } from "@/lib/client-input";
import { clearUserClientData } from "@/lib/client-session-cleanup";
import { studioSnapshotQueryKey } from "@/lib/query-keys";

import {
  callExternalMediaFunction,
  checkExternalCoverGeneration,
  checkExternalYoutubeVideo,
  completeExternalDocument,
  createExternalAlbum,
  createExternalCoverGeneration,
  createExternalYoutubeVideo,
  createExternalDocument,
  createExternalRhymeWord,
  createExternalSong,
  createExternalStylePrompt,
  createExternalVersion,
  deleteExternalRhymeWord,
  deleteExternalStylePrompt,
  deleteExternalVersion,
  exportExternalLibrary,
  exportExternalLyricsTxt,
  exportExternalTaggedCopy,
  generateExternalYoutubeText,
  getExternalStudioSnapshot,
  importExternalDocx,
  importExternalPdf,
  importExternalGoogleDocument,
  setExternalFinalVersion,
  setExternalPrimaryVersion,
  updateExternalAlbum,
  updateExternalDocument,
  updateExternalSong,
  updateExternalStylePrompt,
  updateExternalVersion,
  uploadToExternalStorage,
  type ExternalVideoMode,
  type YoutubeCopyAction,
  type YoutubeEffect,
} from "@/lib/external-studio";
import { supabase } from "@/lib/supabase";

const unavailable = async (_input?: unknown) => { throw new Error("Tato externí operace se právě dokončuje. Zkus ji znovu za okamžik."); };
const directProvider = ({ children }: PropsWithChildren<{ client?: unknown; queryClient?: unknown }>) => children;

function useStudioUtils() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return {
    studio: {
      snapshot: {
        invalidate: () => queryClient.invalidateQueries({ queryKey: studioSnapshotQueryKey(user?.id) }),
      },
    },
  };
}

function useStudioSnapshotQuery(_input?: undefined, options?: { enabled?: boolean }) {
  const { user } = useAuth();
  return useQuery({
    queryKey: studioSnapshotQueryKey(user?.id),
    queryFn: getExternalStudioSnapshot,
    enabled: Boolean(user?.id) && (options?.enabled ?? true),
  });
}

function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      let userId: string | undefined;
      try {
        const { data } = await supabase.auth.getUser();
        userId = data.user?.id;
      } catch {
        // Starší/mockované auth klienty mohou getUser nemít; signOut pořád zkusíme.
      }
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      await clearUserClientData(queryClient, userId);
      return { success: true } as const;
    },
  });
}

/**
 * Kompatibilní klient zachovává rozhraní obrazovek, ale volá přímo externí
 * Supabase. Název zůstal zachován, aby migrace nepřerušila navigaci aplikace.
 */
export const trpc = {
  Provider: directProvider,
  useUtils: useStudioUtils,
  auth: {
    logout: { useMutation: useLogoutMutation },
  },
  studio: {
    snapshot: { useQuery: useStudioSnapshotQuery },
    createCustomRhymeWord: { useMutation: () => useMutation({ mutationFn: ({ word }: { word: string }) => createExternalRhymeWord(word) }) },
    deleteCustomRhymeWord: { useMutation: () => useMutation({ mutationFn: ({ id }: { id: string | number }) => deleteExternalRhymeWord(String(id)) }) },
    createAlbum: { useMutation: () => useMutation({ mutationFn: (input: { name: string; description?: string | null; releaseYear?: number | null; coverStorageKey?: string | null; coverUrl?: string | null }) => createExternalAlbum(input) }) },
    updateAlbum: { useMutation: () => useMutation({ mutationFn: (input: { id: string | number; name?: string; description?: string | null; releaseYear?: number | null; coverStorageKey?: string | null; sortOrder?: number }) => updateExternalAlbum({ ...input, id: String(input.id) }) }) },
    createDocument: { useMutation: () => useMutation({ mutationFn: (input: { title: string; albumId?: string | number | null; stylePrompt?: string | null; lyrics?: string | null; notes?: string | null; coverStorageKey?: string | null; coverUrl?: string | null }) => createExternalDocument({ ...input, albumId: input.albumId === null || input.albumId === undefined ? null : String(input.albumId) }) }) },
    updateDocument: { useMutation: () => useMutation({ mutationFn: (input: { id: string | number; title?: string; albumId?: string | number | null; stylePrompt?: string | null; lyrics?: string | null; notes?: string | null; coverStorageKey?: string | null; coverUrl?: string | null }) => updateExternalDocument({ ...input, id: String(input.id), albumId: input.albumId === null || input.albumId === undefined ? input.albumId : String(input.albumId) }) }) },
    completeDocument: { useMutation: () => useMutation({ mutationFn: ({ id }: { id: string | number }) => completeExternalDocument(String(id)) }) },
    createSong: { useMutation: () => useMutation({ mutationFn: (input: { title: string; albumId?: string | number | null; stylePrompt?: string | null; stylePrompts?: string[]; lyrics?: string | null; notes?: string | null; coverStorageKey?: string | null; coverUrl?: string | null }) => createExternalSong({ ...input, albumId: input.albumId === null || input.albumId === undefined ? null : String(input.albumId) }) }) },
    updateSong: { useMutation: () => useMutation({ mutationFn: (input: { id: string | number; title?: string; albumId?: string | number | null; stylePrompt?: string | null; stylePrompts?: string[]; lyrics?: string | null; notes?: string | null; coverStorageKey?: string | null; coverUrl?: string | null; youtubeDescription?: string | null; youtubeTags?: string | null }) => updateExternalSong({ ...input, id: String(input.id), albumId: normalizeOptionalId(input.albumId) }) }) },
    upload: { useMutation: () => useMutation({ mutationFn: uploadToExternalStorage }) },
    createVersion: { useMutation: () => useMutation({ mutationFn: (input: { songId: string | number; label: string; originalFileName: string; storageKey: string; storageUrl?: string; mimeType: string; byteSize: number; rating?: number; isPrimary?: boolean; id3Title?: string | null; id3Artist?: string | null; id3Album?: string | null; id3TrackNumber?: string | null; id3Year?: string | null; id3Genre?: string | null; id3Comment?: string | null }) => createExternalVersion({ ...input, songId: String(input.songId) }) }) },
    updateVersion: { useMutation: () => useMutation({ mutationFn: (input: { id: string | number; label?: string; rating?: number; id3Title?: string | null; id3Artist?: string | null; id3Album?: string | null; id3TrackNumber?: string | null; id3Year?: string | null; id3Genre?: string | null; id3Comment?: string | null }) => updateExternalVersion({ ...input, id: String(input.id) }) }) },
    setPrimaryVersion: { useMutation: () => useMutation({ mutationFn: ({ id }: { id: string | number }) => setExternalPrimaryVersion(String(id)) }) },
    setFinalVersion: { useMutation: () => useMutation({ mutationFn: ({ id }: { id: string | number }) => setExternalFinalVersion(String(id)) }) },
    deleteVersion: { useMutation: () => useMutation({ mutationFn: ({ id }: { id: string | number }) => deleteExternalVersion(String(id)) }) },
    prepareManagedCopy: { useMutation: () => useMutation({ mutationFn: ({ id, label, note }: { id: string | number; label: string; note?: string | null }) => callExternalMediaFunction(String(id), label, note) }) },
    exportTaggedCopy: { useMutation: () => useMutation({ mutationFn: ({ id }: { id: string | number }) => exportExternalTaggedCopy(String(id)) }) },
    exportWholeLibrary: { useMutation: () => useMutation({ mutationFn: ({ albumId }: { albumId?: string | number }) => exportExternalLibrary(albumId === undefined ? undefined : String(albumId)) }) },
    exportLyricsTxt: { useMutation: () => useMutation({ mutationFn: () => exportExternalLyricsTxt() }) },
    createCoverGeneration: { useMutation: () => useMutation({ mutationFn: ({ entityType, entityId, format, userNote }: { entityType: "song" | "lyric" | "album"; entityId: string | number; format?: "youtube_16_9"; userNote?: string | null }) => createExternalCoverGeneration(entityType, String(entityId), { format, userNote }) }) },
    checkCoverGeneration: { useMutation: () => useMutation({ mutationFn: ({ entityType, entityId, jobId, format }: { entityType: "song" | "lyric" | "album"; entityId: string | number; jobId: string; format?: "youtube_16_9" }) => checkExternalCoverGeneration(entityType, String(entityId), jobId, { format }) }) },
    createYoutubeVideo: { useMutation: () => useMutation({ mutationFn: ({ songId, versionId, effect, mode }: { songId: string | number; versionId: string | number; effect?: YoutubeEffect; mode?: ExternalVideoMode }) => createExternalYoutubeVideo(String(songId), String(versionId), effect, mode) }) },
    checkYoutubeVideo: { useMutation: () => useMutation({ mutationFn: ({ songId, versionId, jobId }: { songId: string | number; versionId: string | number; jobId: string }) => checkExternalYoutubeVideo(String(songId), String(versionId), jobId) }) },
    createStylePrompt: { useMutation: () => useMutation({ mutationFn: (input: { content: string; note?: string | null; rating?: number }) => createExternalStylePrompt(input).then(() => undefined) }) },
    updateStylePrompt: { useMutation: () => useMutation({ mutationFn: (input: { id: string | number; content?: string; note?: string | null; rating?: number }) => updateExternalStylePrompt({ ...input, id: String(input.id) }) }) },
    deleteStylePrompt: { useMutation: () => useMutation({ mutationFn: ({ id }: { id: string | number }) => deleteExternalStylePrompt(String(id)) }) },
    generateYoutubeText: { useMutation: () => useMutation({ mutationFn: ({ action, songId }: { action: YoutubeCopyAction; songId: string | number }) => generateExternalYoutubeText(action, String(songId)) }) },
    importDocx: { useMutation: () => useMutation({ mutationFn: ({ fileName, base64 }: { fileName: string; base64: string }) => importExternalDocx(fileName, base64).then((result) => result.id) }) },
    importPdf: { useMutation: () => useMutation({ mutationFn: ({ fileName, base64 }: { fileName: string; base64: string }) => importExternalPdf(fileName, base64).then((result) => result.id) }) },
    importGoogleDocument: { useMutation: () => useMutation({ mutationFn: ({ url, title }: { url: string; title?: string }) => importExternalGoogleDocument(url, title).then((result) => result.id) }) },
  },
};

export function createTRPCClient() { return {}; }
