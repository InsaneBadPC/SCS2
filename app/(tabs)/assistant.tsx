import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Clipboard from "expo-clipboard";
import { LinearGradient } from "expo-linear-gradient";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { FadeInDown, FadeInUp, Layout } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EmptyState, Shimmer, StudioHeader } from "@/components/studio-ui";
import { ScreenContainer } from "@/components/screen-container";
import { startPrivateLogin } from "@/constants/oauth";
import { askSongCraftAgent, confirmSongCraftAction, isConfirmableAction, type AgentPendingAction } from "@/lib/agent-api";
import type { StudioAssistantMessage } from "@/lib/assistant-chat";
import { MAX_ASSISTANT_CONVERSATIONS, upsertAssistantConversation, type AssistantConversation } from "@/lib/assistant-history";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { OnPrimary, Radius, Type } from "@/lib/design-tokens";

const SUGGESTIONS = [
  { icon: "auto-awesome" as const, text: "Navrhni refrén podle mých textů", sub: "Analýza stylu + nálady" },
  { icon: "album" as const, text: "Jaké album mám rozpracovat dál?", sub: "Přehled nedokončených" },
  { icon: "image" as const, text: "Vytvoř prompt pro přebal", sub: "Pro Al generátor" },
];

type Conversation = AssistantConversation;
const MAX_CONVERSATIONS = MAX_ASSISTANT_CONVERSATIONS;
const storageKey = (userId: string) => `assistant_history_${userId}`;

export default function AssistantScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, isAuthenticated, loading } = useAuth();
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<StudioAssistantMessage[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingActions, setPendingActions] = useState<AgentPendingAction[]>([]);
  const [serverConversationId, setServerConversationId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const hasMessages = messages.length > 0;
  const inputDisabled = sending || !isAuthenticated;
  const flatListRef = useRef<FlatList>(null);
  const activeUserIdRef = useRef<string | null>(null);
  const loadedUserIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<Conversation[]>([]);
  const activeIdRef = useRef<string | null>(null);
  activeUserIdRef.current = user?.id ?? null;
  conversationsRef.current = conversations;
  activeIdRef.current = activeId;

  const readHistory = useCallback(async (uid: string): Promise<Conversation[] | null> => {
    try {
      const raw = await AsyncStorage.getItem(storageKey(uid));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      const valid = parsed.filter((entry): entry is Conversation => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = entry as Conversation;
        return typeof candidate.id === "string" && typeof candidate.updatedAt === "number" && Array.isArray(candidate.messages) && candidate.messages.every((message) => Boolean(message && typeof message === "object" && typeof message.id === "string" && (message.role === "user" || message.role === "assistant") && typeof message.content === "string"));
      });
      return valid.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
    } catch {
      return null;
    }
  }, []);

  const persist = useCallback(async (uid: string, convs: Conversation[]) => {
    if (activeUserIdRef.current !== uid) return;
    try { await AsyncStorage.setItem(storageKey(uid), JSON.stringify(convs.slice(0, MAX_CONVERSATIONS))); } catch {}
  }, []);

  useEffect(() => {
    let cancelled = false;
    setConversations([]);
    setActiveId(null);
    setMessages([]);
    setSending(false);
    setError(null);
    setPendingActions([]);
    setServerConversationId(null);
    setConfirming(false);
    const uid = user?.id;
    loadedUserIdRef.current = uid ?? null;
    if (!uid) return;
    void readHistory(uid).then((sorted) => {
      if (cancelled || activeUserIdRef.current !== uid || !sorted?.length) return;
      setConversations(sorted);
      setActiveId(sorted[0].id);
      setMessages(sorted[0].messages);
    });
    return () => { cancelled = true; };
  }, [readHistory, user?.id]);

  const upsertCurrent = useCallback((nextMessages: StudioAssistantMessage[], currentId: string | null, convs: Conversation[]) => {
    const result = upsertAssistantConversation(convs, currentId, nextMessages);
    return { convs: result.conversations, id: result.id, changed: result.changed };
  }, []);

  useEffect(() => {
    if (!user?.id || messages.length === 0) return;
    const timeout = setTimeout(() => {
      if (activeUserIdRef.current !== user.id || loadedUserIdRef.current !== user.id) return;
      const { convs, id, changed } = upsertCurrent(messages, activeId, conversationsRef.current);
      if (changed) { setConversations(convs); setActiveId(id); void persist(user.id, convs); }
    }, 300);
    return () => clearTimeout(timeout);
  }, [messages, activeId, persist, upsertCurrent, user?.id]);

  const startNewConversation = useCallback(async () => {
    const uid = user?.id;
    if (!uid) return;
    Haptics.selectionAsync().catch(()=>{});
    let convs = conversations;
    if (messages.length) { const res = upsertCurrent(messages, activeId, conversations); convs = res.convs; await persist(uid, convs); }
    if (activeUserIdRef.current !== uid) return;
    setMessages([]); setActiveId(null); setError(null); setPendingActions([]); setServerConversationId(null);
  }, [user?.id, messages, activeId, conversations, persist, upsertCurrent]);

  const switchConversation = useCallback((id: string) => {
    Haptics.selectionAsync().catch(()=>{});
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    setActiveId(id); setMessages(conv.messages); setError(null); setPendingActions([]); setServerConversationId(null);
  }, [conversations]);

  const listHeader = useMemo(() => (
    <>
      <StudioHeader eyebrow="Experimentální větev" title="Asistent" />
      <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 4 }]}>
        <View style={[styles.noticeIcon, { backgroundColor: `${colors.primary}14`, borderColor: "rgba(255,255,255,0.08)" }]}><MaterialIcons name="privacy-tip" size={18} color={colors.primary} /></View>
        <Text style={[styles.noticeText, { color: colors.muted }]}>Pracuje jen s tvými texty, alby a skladbami. Akce s veřejným dopadem vyžadují potvrzení.</Text>
      </View>
      {isAuthenticated && conversations.length > 0 ? (
        <Animated.View entering={FadeInUp.duration(380)} style={styles.historyBlock}>
          <View style={styles.historyHead}>
            <Text style={[styles.historyTitle, { color: colors.muted }]}>POSLEDNÍ KONVERZACE</Text>
            <Pressable onPress={() => void startNewConversation()} style={({ pressed }) => [styles.newConv, { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
              <MaterialIcons name="add" size={14} color="#FFFFFF" /><Text style={styles.newConvText}>Nová</Text>
            </Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.historyRow}>
            {conversations.map((c) => (
              <Pressable key={c.id} onPress={() => switchConversation(c.id)} style={({ pressed }) => [styles.historyChip, { backgroundColor: c.id === activeId ? colors.primary : colors.surface, borderColor: c.id === activeId ? colors.primary : "rgba(255,255,255,0.08)", opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}>
                <MaterialIcons name="chat-bubble-outline" size={13} color={c.id === activeId ? "#FFFFFF" : colors.muted} />
                <Text numberOfLines={1} style={[styles.historyChipText, { color: c.id === activeId ? "#FFFFFF" : colors.foreground }]}>{c.title}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </Animated.View>
      ) : null}
      {!hasMessages ? (
        <View style={styles.suggestions}>
          <Text style={[styles.suggestionTitle, { color: colors.foreground }]}>Začni třeba takto</Text>
          {SUGGESTIONS.map((s, i) => (
            <Animated.View key={s.text} entering={FadeInDown.delay(i * 80).duration(420)} layout={Layout.springify()}>
              <Pressable onPress={() => { Haptics.selectionAsync().catch(()=>{}); setDraft(s.text); }} disabled={inputDisabled} style={({ pressed }) => [styles.suggestion, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: pressed ? 0.08 : 0.12, shadowRadius: 12, elevation: 3, opacity: pressed || inputDisabled ? 0.85 : 1, transform: [{ scale: pressed ? 0.98 : 1 }] }]}>
                <LinearGradient colors={["rgba(0,217,236,0.12)", "rgba(139,92,246,0.10)"]} style={styles.suggestionIconBg}>
                  <MaterialIcons name={s.icon} size={18} color={colors.primary} />
                </LinearGradient>
                <View style={{ flex: 1, gap: 2 }}><Text style={[styles.suggestionText, { color: colors.foreground }]}>{s.text}</Text><Text style={[styles.suggestionSub, { color: colors.muted }]}>{s.sub}</Text></View>
                <MaterialIcons name="arrow-outward" size={16} color={colors.muted} />
              </Pressable>
            </Animated.View>
          ))}
          <Text style={[styles.disclaimer, { color: colors.muted }]}>Bezplatný experiment • připraví prompt pro obal, tagy i popis</Text>
        </View>
      ) : null}
    </>
  ), [colors, hasMessages, inputDisabled, conversations, activeId, startNewConversation, switchConversation, isAuthenticated]);

  async function send(text = draft) {
    const content = text.trim();
    const requestUserId = user?.id;
    if (!content || sending || !requestUserId) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(()=>{});
    const userMessage: StudioAssistantMessage = { id: `user-${Date.now()}`, role: "user", content };
    const history = [...messages, userMessage];
    setMessages(history); setDraft(""); setError(null); setSending(true);
    try {
      const result = await askSongCraftAgent(content, messages, serverConversationId);
      if (activeUserIdRef.current !== requestUserId) return;
      const withAnswer: StudioAssistantMessage[] = [...history, { id: `assistant-${Date.now()}`, role: "assistant", content: result.answer }];
      setMessages(withAnswer);
      setPendingActions(result.pending);
      if (result.conversationId) setServerConversationId(result.conversationId);
      const { convs, id } = upsertCurrent(withAnswer, activeIdRef.current, conversationsRef.current);
      setConversations(convs); setActiveId(id); await persist(requestUserId, convs);
    } catch (caught) { if (activeUserIdRef.current === requestUserId) setError(caught instanceof Error ? caught.message : "Asistent nyní není dostupný."); } finally { if (activeUserIdRef.current === requestUserId) setSending(false); }
  }

  async function confirmAction(action: AgentPendingAction) {
    if (!isConfirmableAction(action.tool) || !action.confirmationId || !action.confirmationToken || confirming) return;
    setConfirming(true);
    try {
      const result = await confirmSongCraftAction(action.tool, action.confirmationId, action.confirmationToken);
      if (result.status === "published") {
        setPendingActions((current) => current.filter((entry) => entry.confirmationId !== action.confirmationId));
        Alert.alert("Publikace je hotová", result.youtubeVideoId ? `YouTube video ${result.youtubeVideoId} je nyní publikované.` : "Video bylo publikované.");
      } else if (result.error) {
        Alert.alert("Akce se nezdařila", result.error);
      } else if (result.status === "approved") {
        setPendingActions((current) => current.filter((entry) => entry.confirmationId !== action.confirmationId));
        Alert.alert("Potvrzeno", result.message || "Operace se spustí na serveru.");
      }
    } catch (caught) {
      Alert.alert("Potvrzení se nezdařilo", caught instanceof Error ? caught.message : "Zkus to znovu.");
    } finally {
      setConfirming(false);
    }
  }

  const ACTION_LABELS: Record<string, string> = {
    publish_to_youtube: "Publikovat na YouTube",
    run_vm_command: "Spustit příkaz na serveru",
    push_git_branch: "Pushnout větev do repa",
    deploy_worker: "Nasadit workera na server",
    read_repo_file: "Přečíst soubor z repa",
    read_skills: "Přečíst dokumentaci",
  };

  async function copyMessage(content: string) {
    Haptics.selectionAsync().catch(()=>{});
    try { await Clipboard.setStringAsync(content); Alert.alert("Zkopírováno", "Odpověď je ve schránce."); } catch {}
  }

  if (loading) return <ScreenContainer><View style={{ padding: 20, gap: 12 }}><Shimmer height={20} width="60%" /><Shimmer height={14} /><Shimmer height={14} width="80%" /></View></ScreenContainer>;
  if (!isAuthenticated) return <ScreenContainer centered><View style={[styles.emptyCard, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)" }]}><View style={[styles.emptyIcon, { backgroundColor: `${colors.primary}14` }]}><MaterialIcons name="lock" size={28} color={colors.primary} /></View><Text style={[styles.emptyTitle, { color: colors.foreground }]}>Přihlášení je potřeba</Text><Text style={[styles.emptyText, { color: colors.muted }]}>Asistent pracuje jen s tvými materiály.</Text><Pressable onPress={() => void startPrivateLogin()} style={({ pressed }) => [styles.loginBtn, { opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}><LinearGradient colors={[colors.primary, colors.primaryVibrant]} style={StyleSheet.absoluteFill as any} /><Text style={styles.loginText}>Přihlásit se</Text></Pressable></View></ScreenContainer>;

  return (
    <ScreenContainer inset style={{ backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={styles.grow} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={insets.top}>
        <FlatList
          ref={flatListRef}
          data={messages}
          keyExtractor={(item) => item.id}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.content, { paddingBottom: 16 }]}
          ListHeaderComponent={listHeader}
          onContentSizeChange={() => flatListRef.current?.scrollToEnd({ animated: true })}
          renderItem={({ item, index }) => (
            <Animated.View entering={FadeInDown.delay(index * 20).duration(360)} layout={Layout.springify()} style={[styles.message, item.role === "user" ? [styles.userMessage, { backgroundColor: colors.primary, shadowColor: colors.primary, shadowOpacity: 0.22, shadowRadius: 12, elevation: 4 }] : [styles.assistantMessage, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: 0.12, shadowRadius: 12, elevation: 3 }]]}>
              <View style={styles.messageHead}>
                <View style={styles.roleRow}>
                  <View style={[styles.roleDot, { backgroundColor: item.role === "user" ? "#FFFFFF" : colors.primary }]} />
                  <Text style={[styles.messageRole, { color: item.role === "user" ? "#FFFFFF" : colors.primary }]}>{item.role === "user" ? "Ty" : "Asistent"}</Text>
                </View>
                {item.role === "assistant" ? <Pressable onPress={() => void copyMessage(item.content)} hitSlop={8} style={({ pressed }) => [styles.copyChip, { opacity: pressed ? 0.6 : 1, transform: [{ scale: pressed ? 0.97 : 1 }] }]}><MaterialIcons name="content-copy" size={13} color={colors.muted} /><Text style={[styles.copyChipText, { color: colors.muted }]}>Kopírovat</Text></Pressable> : null}
              </View>
              <Text selectable style={[styles.messageText, { color: item.role === "user" ? "#FFFFFF" : colors.foreground }]}>{item.content}</Text>
            </Animated.View>
          )}
          ListFooterComponent={sending ? <Animated.View entering={FadeInUp.duration(300)} style={[styles.thinking, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)" }]}><View style={styles.thinkingDots}><View style={[styles.dot, { backgroundColor: colors.primary }]} /><View style={[styles.dot, { backgroundColor: colors.primary, opacity: 0.6 }]} /><View style={[styles.dot, { backgroundColor: colors.primary, opacity: 0.3 }]} /></View><Text style={[styles.thinkingText, { color: colors.muted }]}>Procházím tvé albumy…</Text></Animated.View> : null}
        />
        {pendingActions.length ? <View style={[styles.pendingPanel, { backgroundColor: `${colors.warning}12`, borderColor: `${colors.warning}55` }]}>
          <View style={styles.pendingHeader}><MaterialIcons name="verified-user" size={18} color={colors.warning} /><Text style={[styles.pendingTitle, { color: colors.foreground }]}>Akce čeká na potvrzení</Text></View>
          {pendingActions.map((action) => <View key={action.confirmationId ?? action.tool} style={styles.pendingAction}><View style={styles.pendingCopy}><Text style={[styles.pendingActionTitle, { color: colors.foreground }]}>{ACTION_LABELS[action.tool] ?? action.tool}</Text><Text style={[styles.pendingActionText, { color: colors.muted }]}>{typeof action.summary === "string" && action.summary ? action.summary : action.tool === "publish_to_youtube" ? "Veřejná změna se zatím neprovedla." : "Čeká na tvoje potvrzení."}</Text></View>{isConfirmableAction(action.tool) && action.confirmationId && action.confirmationToken ? <Pressable disabled={confirming} onPress={() => void confirmAction(action)} style={({ pressed }) => [styles.confirmButton, { opacity: confirming || pressed ? 0.6 : 1 }]}><Text style={styles.confirmButtonText}>{confirming ? "Ověřuji…" : "Potvrdit"}</Text></Pressable> : null}</View>)}
        </View> : null}
        {error ? <Animated.View entering={FadeInDown.duration(300)} style={[styles.errorBox, { backgroundColor: "rgba(239,68,68,0.10)", borderColor: "rgba(239,68,68,0.22)" }]}><MaterialIcons name="error-outline" size={16} color={colors.error} /><Text style={[styles.errorText, { color: colors.error }]}>{error}</Text></Animated.View> : null}
        <View style={[styles.composer, { backgroundColor: colors.surface, borderColor: "rgba(255,255,255,0.08)", shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 16, elevation: 8, paddingBottom: insets.bottom ? 8 : 8 }]}>
          <TextInput value={draft} onChangeText={setDraft} editable={!inputDisabled} multiline maxLength={1000} placeholder="Zeptej se na skladby, texty nebo alba…" placeholderTextColor={colors.muted} style={[styles.input, { color: colors.foreground }]} />
          <Pressable onPress={() => void send()} disabled={!draft.trim() || inputDisabled} style={({ pressed }) => [styles.send, { backgroundColor: !draft.trim() || inputDisabled ? "rgba(255,255,255,0.08)" : colors.primary, opacity: pressed ? 0.9 : 1, transform: [{ scale: pressed && draft.trim() ? 0.97 : 1 }] }]}>
            <MaterialIcons name="arrow-upward" size={20} color={!draft.trim() || inputDisabled ? colors.muted : "#FFFFFF"} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  grow: { flex: 1 },
  content: { paddingTop: 14, paddingBottom: 14, gap: 12 },
  notice: { flexDirection: "row", gap: 12, borderRadius: Radius.lg, borderWidth: 1, padding: 14, marginBottom: 14, alignItems: "center" },
  noticeIcon: { width: 36, height: 36, borderRadius: Radius.sm, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  noticeText: { flex: 1, ...Type.caption },
  historyBlock: { gap: 10, marginBottom: 14 },
  historyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  historyTitle: { ...Type.overline, letterSpacing: 1 },
  newConv: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 12, height: 30, borderRadius: Radius.sm },
  newConvText: { color: "#FFFFFF", ...Type.caption },
  historyRow: { gap: 8, paddingRight: 12, paddingVertical: 2 },
  historyChip: { flexDirection: "row", alignItems: "center", gap: 6, maxWidth: 220, paddingHorizontal: 12, height: 34, borderRadius: Radius.md, borderWidth: 1 },
  historyChipText: { ...Type.caption, flexShrink: 1 },
  suggestions: { gap: 10, marginBottom: 6 },
  suggestionTitle: { ...Type.label, marginBottom: 2, letterSpacing: -0.2 },
  suggestion: { minHeight: 62, borderRadius: Radius.lg, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  suggestionIconBg: { width: 36, height: 36, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  suggestionText: { ...Type.label, letterSpacing: -0.2 },
  suggestionSub: { fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "500", marginTop: 1 },
  disclaimer: { ...Type.caption, lineHeight: 15, marginTop: 6, textAlign: "center", opacity: 0.7 },
  message: { maxWidth: "88%", borderRadius: Radius.lg, padding: 14, gap: 8, borderWidth: 1 },
  messageHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  roleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  roleDot: { width: 6, height: 6, borderRadius: 3 },
  copyChip: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, height: 26, borderRadius: Radius.sm, borderWidth: 1, borderColor: "rgba(255,255,255,0.10)", backgroundColor: "rgba(255,255,255,0.04)" },
  copyChipText: { ...Type.caption },
  userMessage: { alignSelf: "flex-end", borderBottomRightRadius: 6, borderWidth: 0 },
  assistantMessage: { alignSelf: "flex-start", borderBottomLeftRadius: 6 },
  messageRole: { ...Type.caption, letterSpacing: 0.3 },
  messageText: { ...Type.body },
  thinking: { alignSelf: "flex-start", flexDirection: "row", gap: 10, alignItems: "center", borderWidth: 1, borderRadius: Radius.md, paddingHorizontal: 14, paddingVertical: 10 },
  thinkingDots: { flexDirection: "row", gap: 4, alignItems: "center" },
  dot: { width: 6, height: 6, borderRadius: 3 },
  thinkingText: { ...Type.caption },
  pendingPanel: { borderWidth: 1, borderRadius: Radius.md, padding: 12, marginBottom: 8, gap: 10 },
  pendingHeader: { flexDirection: "row", alignItems: "center", gap: 7 },
  pendingTitle: { ...Type.label },
  pendingAction: { flexDirection: "row", alignItems: "center", gap: 10 },
  pendingCopy: { flex: 1, gap: 2 },
  pendingActionTitle: { ...Type.label },
  pendingActionText: { ...Type.caption, lineHeight: 15 },
  confirmButton: { minHeight: 40, paddingHorizontal: 13, borderRadius: Radius.sm, backgroundColor: "#F59E0B", alignItems: "center", justifyContent: "center" },
  confirmButtonText: { color: OnPrimary, fontSize: Type.caption.fontSize, lineHeight: Type.caption.lineHeight, fontWeight: "900" },
  errorBox: { flexDirection: "row", gap: 8, alignItems: "center", borderWidth: 1, borderRadius: Radius.sm, padding: 12, marginBottom: 8 },
  errorText: { flex: 1, ...Type.caption },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 10, borderWidth: 1, borderRadius: Radius.lg, padding: 8, marginBottom: 8, marginTop: 4 },
  input: { flex: 1, minHeight: 42, maxHeight: 112, paddingHorizontal: 10, paddingVertical: 10, fontSize: 15, lineHeight: 20 },
  send: { width: 44, height: 44, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center" },
  emptyCard: { borderWidth: 1, borderRadius: Radius.xl, padding: 28, alignItems: "center", gap: 10 },
  emptyIcon: { width: 64, height: 64, borderRadius: Radius.lg, alignItems: "center", justifyContent: "center" },
  emptyTitle: { ...Type.heading, textAlign: "center" },
  emptyText: { ...Type.label, lineHeight: 20, textAlign: "center", opacity: 0.8 },
  loginBtn: { marginTop: 12, height: 48, borderRadius: Radius.sm, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, overflow: "hidden", minWidth: 160 },
  loginText: { color: "#FFFFFF", fontWeight: "700", zIndex: 1 },
});
