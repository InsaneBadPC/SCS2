export type AssistantHistoryMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const MAX_MESSAGE_LENGTH = 1_000;
const MAX_HISTORY_ITEMS = 10;

export function createAssistantRequest(message: string, history: AssistantHistoryMessage[]) {
  const normalizedMessage = message.trim();
  if (!normalizedMessage) throw new Error("Napiš zprávu pro asistenta.");
  if (normalizedMessage.length > MAX_MESSAGE_LENGTH) throw new Error("Jedna zpráva může mít nejvýše 1 000 znaků.");

  return {
    message: normalizedMessage,
    history: history
      .slice(-MAX_HISTORY_ITEMS)
      .map(({ role, content }) => ({ role, content: content.trim().slice(0, MAX_MESSAGE_LENGTH) }))
      .filter((item) => item.content.length > 0),
  };
}
