import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useCallback, useEffect, useState, type ComponentProps } from "react";
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from "react-native";

import { formatDate } from "@/components/studio-ui";
import { useColors } from "@/hooks/use-colors";
import { getVideoDownloadUrl, listVideoJobs, type StudioVideoJob } from "@/lib/video-jobs";
import { Radius, Type } from "@/lib/design-tokens";

export function VideoJobsCard() {
  const colors = useColors();
  const [jobs, setJobs] = useState<StudioVideoJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      setJobs(await listVideoJobs(5));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Render joby se nepodařilo načíst.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const hasActive = jobs.some((job) => job.renderStatus === "queued" || job.renderStatus === "rendering");
    if (!hasActive) return;
    const timer = setInterval(() => void load(), 15_000);
    return () => clearInterval(timer);
  }, [jobs, load]);

  if (loading) return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><ActivityIndicator size="small" color={colors.primary} /><Text style={[styles.loading, { color: colors.muted }]}>Načítám videa…</Text></View>;
  if (error) return <Pressable onPress={() => { setLoading(true); void load(); }} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><MaterialIcons name="sync" size={18} color={colors.warning} /><Text style={[styles.error, { color: colors.muted }]}>{error} Klepni pro opakovat.</Text></Pressable>;
  if (!jobs.length) return null;

  return <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
    <View style={styles.head}><View style={styles.headCopy}><Text style={[styles.title, { color: colors.foreground }]}>Video joby</Text><Text style={[styles.subtitle, { color: colors.muted }]}>Soukromé renderování na Oracle VM</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Obnovit video joby" onPress={() => { setLoading(true); void load(); }} style={styles.refresh}><MaterialIcons name="refresh" size={18} color={colors.muted} /></Pressable></View>
    {jobs.map((job) => <View key={job.id} style={styles.row}><View style={[styles.statusIcon, { backgroundColor: statusColor(job.renderStatus, colors) + "22" }]}><MaterialIcons name={statusIcon(job.renderStatus)} size={17} color={statusColor(job.renderStatus, colors)} /></View><View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.rowTitle, { color: colors.foreground }]}>{job.mode || job.type}</Text><Text numberOfLines={1} style={[styles.rowMeta, { color: colors.muted }]}>{statusLabel(job.renderStatus)}{job.errorMessage ? ` · ${job.errorMessage}` : ` · ${formatDate(job.createdAt)}`}</Text></View>{job.renderStatus === "ready" ? <Pressable accessibilityRole="button" accessibilityLabel="Stáhnout video" onPress={() => void openVideo(job)} style={styles.download}><MaterialIcons name="download" size={17} color={colors.primary} /></Pressable> : null}</View>)}
  </View>;

  async function openVideo(job: StudioVideoJob) {
    try {
      await Linking.openURL(await getVideoDownloadUrl(job));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Video se nepodařilo otevřít.");
    }
  }
}

function statusIcon(status: string): ComponentProps<typeof MaterialIcons>["name"] {
  if (status === "ready") return "check-circle";
  if (status === "failed") return "error";
  if (status === "rendering") return "autorenew";
  return "hourglass-top";
}
function statusLabel(status: string) {
  return status === "ready" ? "Hotovo" : status === "failed" ? "Selhalo" : status === "rendering" ? "Renderuje se" : "Ve frontě";
}
function statusColor(status: string, colors: ReturnType<typeof useColors>) {
  return status === "ready" ? colors.success : status === "failed" ? colors.error : status === "rendering" ? colors.primary : colors.warning;
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: Radius.lg, padding: 14, gap: 10, marginTop: 2 },
  loading: { ...Type.caption, textAlign: "center", flex: 1 },
  error: { ...Type.caption, lineHeight: 17, flex: 1 },
  head: { flexDirection: "row", alignItems: "center" },
  headCopy: { flex: 1, gap: 2 },
  title: { fontSize: 15, fontWeight: "900" },
  subtitle: { ...Type.caption },
  refresh: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  row: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 9 },
  statusIcon: { width: 34, height: 34, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { ...Type.label },
  rowMeta: { fontSize: 10.5, lineHeight: 14 },
  download: { width: 38, height: 38, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
});
