import { supabase } from "@/lib/supabase";

export type AgentOverview = {
  recommendations: Array<{ id: string; category: string; recommendation: string; reasoning: string | null; status: string; created_at: string }>;
  publications: Array<{ id: string; title: string | null; status: string; scheduled_at: string | null; privacy_status: string }>;
  videos: Array<{ id: string; song_id: string | null; type: string; render_status: string; created_at: string }>;
  autoPublish: boolean;
};

export async function getTemneyAgentOverview(): Promise<AgentOverview> {
  const [recommendations, publications, videos, settings] = await Promise.all([
    supabase.from("agent_recommendations").select("id,category,recommendation,reasoning,status,created_at").eq("status", "pending").order("created_at", { ascending: false }).limit(10),
    supabase.from("youtube_publications").select("id,title,status,scheduled_at,privacy_status").in("status", ["draft", "scheduled"]).order("created_at", { ascending: false }).limit(10),
    supabase.from("agent_videos").select("id,song_id,type,render_status,created_at").in("render_status", ["queued", "rendering"]).order("created_at", { ascending: false }).limit(10),
    supabase.from("agent_settings").select("auto_publish").maybeSingle(),
  ]);
  const firstError = recommendations.error || publications.error || videos.error || settings.error;
  if (firstError) throw new Error(firstError.message);
  return { recommendations: recommendations.data ?? [], publications: publications.data ?? [], videos: videos.data ?? [], autoPublish: Boolean(settings.data?.auto_publish) };
}

export async function setTemneyAutoPublish(autoPublish: boolean) {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error("Pro nastavení automatizace se přihlas.");
  const { error } = await supabase.from("agent_settings").upsert({ user_id: userData.user.id, auto_publish: autoPublish, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export async function updateRecommendation(id: string, status: "accepted" | "rejected" | "applied") {
  const { error } = await supabase.from("agent_recommendations").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
}
