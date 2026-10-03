# SongCraft Studio — návrh moderního UI

## Cíl

SongCraft Studio má být rychlé autorské prostředí, ne dashboard plný technických stavů. Uživatel má na první pohled vidět:

- co dokončit,
- kde skončil,
- co lze ihned exportovat,
- a jednu jasnou další akci.

## Informační architektura

### Pět hlavních oblastí

1. **Přehled** — práce k pokračování, synchronizace, poslední změny.
2. **Knihovna** — hotové skladby, MP3 verze, finální stav a export.
3. **Texty** — koncepty, filter alba, import a dokončení dokumentu.
4. **AI** — asistent, návrhy, render queue, potvrzení a download.
5. **Nastavení** — účet, zálohy, synchronizace, bezpečnost a update.

Alba zůstanou doménou entity, ale nebudou mít vlastní permanentní tab. Otevřou se z Knihovny, Přehledu a editoru skladby přes společný album sheet/screen.

### Základní user flow

```text
Přehled → pokračovat v textu
Přehled → nová skladba
Texty → koncept → hotová skladba
Knihovna → skladba → MP3 → finální → export
AI → návrh/render → potvrzení → download/publikace
```

## Vizuální systém

- Background: `#0B0F17`.
- Surface: `#151C28`.
- Primary electric violet: `#7C3AED`.
- Secondary cyan: `#06B6D4`.
- Accent pink: `#EC4899`.
- Warm warning: `#F59E0B`.
- Success: `#10B981`.
- Text: `#F4EFE8`, secondary `#9B91A7`.
- Poloměry: 12 / 18 / 24 px.
- Primární CTA: výrazná elektrická fialová plocha, pouze jedna na obrazovce.
- Gradient používat maximálně na hero nebo důležitý stav; ne na každou kartu.

## Přehled

### Horní část

- synchronizační stav: `Synchronizováno`, `Offline`, `Chyba synchronizace`;
- poslední změna;
- titul `Dobré continuing` pouze v českém produktu: `Pokračovat ve tvorbě`.

### Hero

Jediná hlavní akce:

- pokud existuje draft: `Pokračovat u „název“`;
- jinak `Založit novou skladbu`.

Secondary akce:

- `Nový text`,
- `Otevřít AI`.

### „Co potřebuje pozornost“

Čtyři kompaktní karty:

- rozpracované texty;
- skladby bez coveru;
- skladby bez finální MP3;
- čekající render joby.

Každá karta má počet, krátký popis a tap target.

### Poslední práce

Maximálně 4–5 položek, ne dlouhý seznam:

- cover,
- název,
- album,
- stav,
- poslední změna,
- primární akce `Otevřít`.

## Knihovna

- search je vždy nahoře;
- filtry jako segmented control: `Vše`, `Finální`, `Publikované`;
- album filter v side sheetu;
- karta skladby má nejvýše 3 viditelné metadata a 1 primární akci;
- dlouhý seznam nahrazuje virtualizovaný/stránkovaný seznam později.

## Editor

- sticky hlavička: `Zpět`, název, `Uložit`;
- sekce `Text`, `Styl`, `Poznámky`, `Cover`, `Album`;
- stav `Uloženo`, `Ukládám`, `Draft obnoven`;
- AI a rýmy jako sekundární toolbar;
- validace a chyby nikdy jako obecný toast, ale u konkrétního pole.

## AI manažer

- message bubbles maximálně 88 % šířky;
- tool akce jako samostatné karty;
- `Potvrdit publikaci` a `Zrušit` jako explicitní dvě tlačítka;
- render status jako progress card s retry/cancel;
- stažení MP4 jako primární akci po `ready`.

## Stavové komponenty

Každá obrazovka musí mít:

- loading skeleton;
- empty state s jednou akcí;
- error state s retry;
- offline banner;
- sync conflict/importance warning;
- permission/auth redirect.

## Fáze implementace

### Fáze 1 — rychlé zlepšení bez změny datového modelu

- přepracovat Přehled;
- přidat status cards;
- zjednotit typografii a spacing;
- opravit error/empty stavy;
- opravit album query a navigaci.

### Fáze 2 — informační hierarchie

- skrýt Alba z permanentního bottom baru;
- přidat album sheet;
- sjednotit karty a primární akce;
- zlepšit editor toolbar.

### Fáze 3 — AI workflow

- conversation persistence;
- tool/action cards;
- render progress;
- confirmation UI;
- recommendation inbox.

### Fáze 4 — dostupnost a testy

- VoiceOver/TalkBack labels;
- 44 px touch target;
- keyboard resize;
- dark/light kontrast;
- Android a web E2E scénáře.

## Akceptační scénář

Uživatel musí na Androidu i webu bez návodu:

1. přihlásit se;
2. z Přehledu pokračovat v rozpracovaném textu;
3. přidat cover a album;
4. označit text jako hotový;
5. v Knihovně najít skladbu;
6. nahrát MP3 a označit finální verzi;
7. v AI spustit `static_cover` render;
8. vidět `ready`;
9. stáhnout MP4;
10. vytvořit draft publikace;
11. potvrdit publikaci až po explicitním kliknutí.
