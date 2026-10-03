/**
 * Jednorázový přenos vybraného promptu z databáze promptů zpět do editoru.
 * Vyhne se složitému předávání parametrů přes expo-router.
 */
let pickedStylePrompt: string | null = null;

export function setPickedStylePrompt(content: string) {
  pickedStylePrompt = content;
}

export function takePickedStylePrompt(): string | null {
  const value = pickedStylePrompt;
  pickedStylePrompt = null;
  return value;
}
