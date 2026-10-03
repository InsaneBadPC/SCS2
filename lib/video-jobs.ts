import { supabase } from "@/lib/supabase";
import { assertOwnedStoragePath } from "@/lib/storage-paths";

export type StudioVideoJob = {
  id: string;
  songId: string | null;
  type: string;
  mode: string | null;
  backend: string | null;
  renderStatus: "queued" | "rendering" | "ready" | "failed" | string;
  errorMessage: string | null;
  storagePath: string | null;
  createdAt: string;
};

export async function listVideoJobs(limit = 5): Promise<StudioVideoJob[]> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Pro seznam renderů se přihlas.");
  const { data, error } = await supabase.from("agent_videos").select("id,song_id,type,mode,backend,render_status,error_message,storage_path,created_at").eq("user_id", userData.user.id).order("created_at", { ascending: false }).limit(Math.min(Math.max(limit, 1), 20));
  if (error) throw new Error(error.message);
  return (data ?? []).map((row) => ({ id: row.id, songId: row.song_id, type: row.type, mode: row.mode ?? null, backend: row.backend ?? null, renderStatus: row.render_status, errorMessage: row.error_message ?? null, storagePath: row.storage_path ?? null, createdAt: row.created_at }));
}

export async function getVideoDownloadUrl(job: StudioVideoJob) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Pro stažení videa se přihlas.");
  if (job.renderStatus !== "ready" || !job.storagePath) throw new Error("Video ještě není připravené.");
  const path = assertOwnedStoragePath(userData.user.id, job.storagePath);
  const { data, error } = await supabase.storage.from("songcraft").createSignedUrl(path, 60 * 60);
  if (error || !data?.signedUrl) throw new Error("Video se nepodařilo podepsat.");
  return data.signedUrl;
}
