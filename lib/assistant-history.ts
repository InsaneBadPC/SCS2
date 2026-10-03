export const MAX_ASSISTANT_CONVERSATIONS = 5;

export type AssistantHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

export type AssistantConversation = {
  id: string;
  title: string;
  messages: AssistantHistoryMessage[];
  createdAt: number;
  updatedAt: number;
};

export function assistantConversationTitle(messages: AssistantHistoryMessage[]) {
  const first = messages.find((message) => message.role === "user")?.content.trim() ?? "";
  if (!first) return "Nová konverzace";
  return first.slice(0, 42) + (first.length > 42 ? "…" : "");
}

export function sameAssistantMessages(left: AssistantHistoryMessage[], right: AssistantHistoryMessage[]) {
  if (left.length !== right.length) return false;
  return left.every((message, index) => {
    const other = right[index];
    return Boolean(other && message.id === other.id && message.role === other.role && message.content === other.content);
  });
}

/**
 * Merge a conversation without touching updatedAt when its messages did not
 * change. That makes the debounced persistence effect idempotent.
 */
export function upsertAssistantConversation(
  conversations: AssistantConversation[],
  currentId: string | null,
  nextMessages: AssistantHistoryMessage[],
  now = Date.now(),
) {
  if (!currentId) {
    if (!nextMessages.length) return { conversations, id: null, changed: false };
    const id = `conv-${now}`;
    const conversation: AssistantConversation = {
      id,
      title: assistantConversationTitle(nextMessages),
      messages: nextMessages,
      createdAt: now,
      updatedAt: now,
    };
    return { conversations: [conversation, ...conversations].slice(0, MAX_ASSISTANT_CONVERSATIONS), id, changed: true };
  }

  const existing = conversations.find((conversation) => conversation.id === currentId);
  if (existing && sameAssistantMessages(existing.messages, nextMessages)) {
    return { conversations, id: currentId, changed: false };
  }
  if (!existing) {
    const conversation: AssistantConversation = {
      id: currentId,
      title: assistantConversationTitle(nextMessages),
      messages: nextMessages,
      createdAt: now,
      updatedAt: now,
    };
    return { conversations: [conversation, ...conversations].slice(0, MAX_ASSISTANT_CONVERSATIONS), id: currentId, changed: true };
  }

  const updated = conversations
    .map((conversation) => conversation.id === currentId ? { ...conversation, messages: nextMessages, title: assistantConversationTitle(nextMessages), updatedAt: now } : conversation)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_ASSISTANT_CONVERSATIONS);
  return { conversations: updated, id: currentId, changed: true };
}
