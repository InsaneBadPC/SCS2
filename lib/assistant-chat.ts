import { askSongCraftAgent } from "@/lib/agent-api";
import { createAssistantRequest, type AssistantHistoryMessage } from "./assistant-chat-payload";

export type StudioAssistantMessage = AssistantHistoryMessage;
export { createAssistantRequest } from "./assistant-chat-payload";

/**
 * Backwards-compatible string helper for older screens. New UI code can use
 * askSongCraftAgent directly when it needs pending confirmations.
 */
export async function askStudioAssistant(message: string, history: StudioAssistantMessage[], conversationId?: string | null) {
  const result = await askSongCraftAgent(message, history, conversationId);
  return result.answer;
}
