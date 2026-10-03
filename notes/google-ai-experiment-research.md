# Google AI experiment — ověřené podklady

## Doporučená architektura

Mobilní aplikace a statický web nesmí obsahovat Google API klíč. Klient odešle požadavek pouze do Supabase Edge Function, která z JWT ověří právě přihlášeného uživatele, načte výhradně jeho řádky z tabulek `sc_albums`, `sc_lyrics`, `sc_songs`, `sc_audio_versions` a `sc_rhyme_words`, vytvoří omezený kontext a až poté zavolá Google Gemini. Výsledný obrázek se uloží pod cestu uživatele v bucketu `songcraft` a přístup zůstane chráněn RLS.

## Modely a limity

Pro textový chat je vhodný stabilní `gemini-3.1-flash-lite`, který je určený pro cenově efektivní běžné úlohy. Pro obrázkový experiment je nejlevnějším stabilním modelem `gemini-3.1-flash-lite-image` (Nano Banana 2 Lite). Google uvádí, že bezplatná vrstva má omezený přístup k určitým modelům a požadavky v bezplatné vrstvě mohou být použity ke zlepšování produktů. Konečné limity závisí na konkrétním projektu v Google AI Studio; nebudou se proto prezentovat jako garantované.

Model `gemini-3.1-flash-image` není vhodný pro požadavek na bezplatný obrázkový experiment, protože oficiální ceník u něj neuvádí bezplatnou vrstvu. Tento model se nepoužije jako výchozí.

## Zdroje

- Google AI — Image generation: https://ai.google.dev/gemini-api/docs/image-generation
- Google AI — Pricing: https://ai.google.dev/gemini-api/docs/pricing
- Google AI — Models: https://ai.google.dev/gemini-api/docs/models
- Google AI — Rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
- Supabase Auth: https://supabase.com/docs/guides/auth
- Supabase Storage: https://supabase.com/docs/guides/storage
