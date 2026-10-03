import { supabase } from "@/lib/supabase";
import { createAssistantRequest, type AssistantHistoryMessage } from "@/lib/assistant-chat-payload";

export type AgentPendingAction = {
  tool: string;
  status: string;
  message?: string;
  confirmationId?: string;
  confirmationToken?: string;
  expiresAt?: string;
  [key: string]: unknown;
};

export type AgentResponse = {
  answer: string;
  pending: AgentPendingAction[];
  conversationId?: string;
};

export type AgentConversationSummary = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export async function listAgentConversations(limit = 20): Promise<AgentConversationSummary[]> {
  const { data, error } = await supabase
    .from("agent_conversations")
    .select("id,title,created_at,updated_at")
    .order("updated_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 50));
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function getAgentConversation(id: string) {
  const { data, error } = await supabase
    .from("agent_messages")
    .select("id,role,content,created_at")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

function isPendingAction(value: unknown): value is AgentPendingAction {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { tool?: unknown; status?: unknown; confirmationId?: unknown; confirmationToken?: unknown };
  if (typeof candidate.tool !== "string" || typeof candidate.status !== "string") return false;
  if (candidate.status !== "pending_confirmation") return true;
  return typeof candidate.confirmationId === "string"
    && candidate.confirmationId.length > 0
    && typeof candidate.confirmationToken === "string"
    && candidate.confirmationToken.length >= 32
    && candidate.confirmationToken.length <= 256;
}

/**
 * Single client boundary for the server-side SongCraft agent. Provider keys,
 * tool dispatch, ownership checks and confirmation policy stay in the Edge
 * Function; the app only sends bounded user text and renders typed results.
 */
/** Akce, které se v aplikaci potvrzují ťuknutím. */
export const CONFIRMABLE_ACTIONS = [
  "publish_to_youtube",
  "run_vm_command",
  "push_git_branch",
  "deploy_worker",
  "read_repo_file",
  "read_skills",
] as const;

export type ConfirmableAction = (typeof CONFIRMABLE_ACTIONS)[number];

export function isConfirmableAction(value: unknown): value is ConfirmableAction {
  return typeof value === "string" && (CONFIRMABLE_ACTIONS as readonly string[]).includes(value);
}

export async function confirmSongCraftAction(action: ConfirmableAction, confirmationId: string, confirmationToken: string) {
  if (!confirmationId.trim() || confirmationToken.length < 32) throw new Error("Potvrzení není platné.");
  const { data, error } = await supabase.functions.invoke("agent-confirm", {
    body: { action, confirmationId, confirmationToken },
  });
  if (error) throw new Error(error.message || "Potvrzení se nezdařilo.");
  return data as { status?: string; youtubeVideoId?: string; message?: string; summary?: string; error?: string };
}

export async function askSongCraftAgent(
  message: string,
  history: AssistantHistoryMessage[],
  conversationId?: string | null,
): Promise<AgentResponse> {
  const payload = {
    ...createAssistantRequest(message, history),
    ...(conversationId ? { conversationId } : {}),
  };
  const { data, error } = await supabase.functions.invoke("agent-orchestrator", { body: payload });
  if (error) throw new Error(error.message || "AI manažer nyní není dostupný.");
  if (!data || typeof data !== "object") throw new Error("AI manažer vrátil neplatnou odpověď.");

  const body = data as { answer?: unknown; pending?: unknown; conversationId?: unknown };
  if (typeof body.answer !== "string" || !body.answer.trim()) {
    throw new Error("AI manažer nevrátil odpověď.");
  }

  return {
    answer: body.answer.trim(),
    pending: Array.isArray(body.pending) ? body.pending.filter(isPendingAction) : [],
    conversationId: typeof body.conversationId === "string" ? body.conversationId : conversationId ?? undefined,
  };
}
