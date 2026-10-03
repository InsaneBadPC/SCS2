/**
 * Veřejné stránky pro Google OAuth consent screen.
 *
 * Bez JWT, protože je musí umožnit i Googlebot. Bez přihlášení a bez jakýchkoli
 * osobních údajů, jen statický text.
 *
 *   /functions/v1/legal?page=privacy
 *   /functions/v1/legal?page=terms
 */
const LOGO = "https://gpgbgjxeybfncrexrpbr.supabase.co/storage/v1/object/public/songcraft-web/logo-512.png";
const UPDATED = "1. 9. 2026";

const style = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d0d10; color:#e8e8ea;
         font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 72px; }
  header { display:flex; align-items:center; gap:14px; margin-bottom: 8px; }
  header img { width:56px; height:56px; border-radius:14px; }
  h1 { font-size: 24px; margin:0; letter-spacing:-.2px; }
  h2 { font-size: 17px; margin: 32px 0 8px; }
  p, li { color:#c9c9cf; }
  a { color:#8ab4ff; }
  .meta { color:#8a8a93; font-size:13px; margin-bottom:28px; }
  .box { border:1px solid rgba(255,255,255,.10); background:#141418;
         border-radius:16px; padding:16px 18px; }
  nav { display:flex; gap:14px; margin-bottom:26px; font-size:14px; }
  ul { padding-left:20px; }
`;

const nav = `
  <nav>
    <a href="?page=privacy">Zásady ochrany soukromí</a>
    <a href="?page=terms">Podmínky použití</a>
  </nav>`;

function shell(title: string, body: string) {
  return `<!doctype html><html lang="cs"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — SongCraft Studio</title><meta name="robots" content="index">
<style>${style}</style></head><body><main>
<header><img src="${LOGO}" alt=""><h1>SongCraft Studio</h1></header>
<div class="meta">Platné od ${UPDATED}</div>
${nav}${body}
</main></body></html>`;
}

const privacy = `
<h2>Co to je</h2>
<p>SongCraft Studio je soukromé tvůrčí studio pro psaní textů, správu skladeb a
výrobu videí. Účet je soukromý a jeho obsah uvidíš jen ty.</p>

<h2>Co ukládáme</h2>
<ul>
  <li><strong>Účet a přihlášení</strong> — e-mail a heslo. Heslo ukládáme výhradně
      v hašované podobě, nikdy čitelnou.</li>
  <li><strong>Tvoje tvorba</strong> — texty písní, metadata, obaly alb a nahrané
      zvukové soubory. Všechno ve tvém soukromém prostoru.</li>
  <li><strong>YouTube připojení</strong> — pokud kanál připojíš, ukládáme tokeny
      na serveru, <strong>nikdy v aplikaci</strong>. Aplikace se k nim nedostane
      a nepošle je nikam jinam.</li>
</ul>

<h2>Kdo k tomu přistupuje</h2>
<p>Nikdo kromě tebe. Uživatelé se mezi sebou navzájem nevidí a data nejsou
veřejná. Aplikace sama je neveřejná.</p>

<h2>Kde data leží</h2>
<p>Evropská lokalita. Soubory jsou v soukromém úložišti a jsou dostupné jen
přes krátkodobé podepsané odkazy, které se po hodině zneplatní.</p>

<h2>YouTube</h2>
<p>Přihlášení do kanálu je bezpečné (PKCE). Tokeny zůstávají na našem serveru.
Videa, která pošleš, se objeví na tvém kanálu — a jen tam. Když připojení
odpojíš, můžeš token ze serveru smazat; tím přestane mít přístup k tvému kanálu.</p>

<h2>Třetí strany</h2>
<p>Generování textů a metadat běží přes Google AI Studio. Do této služby jde
jen text, který k tomu posíláš, a to bez tvého jména.</p>

<h2>Tvoje práva</h2>
<p>Obsah je tvůj. Můžeš ho kdykoli stáhnout, exportovat, opravit i smazat.
Smazáním účtu smažeme i všechno, co k němu patří.</p>

<h2>Změny</h2>
<p>Datum nahoře se aktualizuje při každé podstatné změně.</p>`;

const terms = `
<h2>Pro koho to je</h2>
<p>Pro jednoho tvůrce. Bez registrace, bez reklam, bez prodeje dat.</p>

<h2>Co ti slibujeme</h2>
<ul>
  <li>Ne prodáme ani neposkytneme tvoje data třetím stranám.</li>
  <li>Nepřidáme reklamy ani trackery, které by něco posílaly.</li>
  <li>Nepřepíšeme ti smazané věci.</li>
</ul>

<h2>Tvoje odpovědnost</h2>
<p>Za to, co nahráš na YouTube, jsi zodpovědný ty. Vydaná videa jsou veřejná a
jejich osud je těžko vzít zpět. Doporučujeme začít jako „není veřejné“ nebo
„jen pro odkaz“.</p>
<p>Autorská práva k textům, hudbě a obrazům jsou tvoje. Nevkládej tam cizí
dílo bez souhlasu.</p>

<h2>Dostupnost</h2>
<p>Aplikace může být nedostupná při údržbě. Nemáme SLA ani záruku trvalé
dostupnosti.</p>

<h2>Ukončení</h2>
<p>Můžeš přestat používat kdykoli a účet smazat. Pak zmizí i obsah.</p>`;

const PAGES: Record<string, string> = { privacy, terms };

Deno.serve((request) => {
  if (request.method === "OPTIONS") return new Response("ok");
  const page = new URL(request.url).searchParams.get("page") ?? "privacy";
  const body = PAGES[page] ?? privacy;
  const title = page === "terms" ? "Podmínky použití" : "Zásady ochrany soukromí";
  return new Response(shell(title, body), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
});
