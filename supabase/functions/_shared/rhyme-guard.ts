// =============================================================================
// _shared/rhyme-guard.ts — mechanická kontrola toho, co LLM vrátí jako „rým“
// =============================================================================
//
// PROČ TENTO SOUBOR EXISTUJE
// --------------------------
// `songcraft-rhymes` prosí bezplatný reasoning model o české rýmy. Bez kontroly
// vracel výsledky, které nejsou jen nepřesné, ale chybné — naměřeno živě na
// `nvidia/nemotron-3-super-120b-a12b` dne 2026-10-05:
//
//   „sen“   → exact: pen, ven, den, men, len, fen, ken, ben
//              → „pen“, „men“, „len“, „fen“, „ken“, „ben“ nejsou česká slova, ale
//                vymyšlené náhrady koncovky
//              → multiword: „na den“, „do den“, „na fen“ → „do den“ není
//                ani gramatické spojení, „fen“ je vymyšlené
//   „srdce“ → exact: kde, že, se, ve, ne, dle, městě, nebe, době, půdě,
//              krávě, řece
//              → ANI JEDNO z nich (kromě „řece“) nerymuje se „srdce“. Všechna
//                končí zvukem /ɛ/, zatímco „srdce“ končí /t͡stsɛ/ — model vypsal
//                všechna slova na „-e“ a vydal to za přesnou rýmu
//   „noc“   → multiword: „ta noc“, „tahle noc“, „hluboká noc“, „černá noc“
//              → to je hledané slovo vložené do fráze. Uživatel hledal rýmy
//                k „noc“ a dostal „noc“ s přídavkem
//
// Opakuje se to napříč modely (vyzkoušeno `nemotron-3-super-120b`,
// `nemotron-3-ultra-550b`, `gpt-oss-20b`), takže nejde o podhodnocený prompt.
// Musí se to kontrolovat.
//
// CO SE KONTROLUJE A CO NE
// ------------------------
// KONTROLUJE SE — vše, co jde ověřit bez slovníku:
//
//   ✓ zvuková shoda koncovky (fonologie) — jisté
//   ✓ hledané slovo nefiguruje jako vlastní rýma ani jako poslední slovo
//     skupinové rýmy — jisté
//   ✓ znaky mimo českou abecedu — jisté
//   ✓ tříznenné tvary konsonant–samohláska–konsonant: česká slovní zásoba
//     těchto tvarů je malá a uzavřená, takže cokoliv mimo ni je s vysokou
//     pravděpodobností vymyšlenina (viz `CZECH_CVC_SHORT`). TADY ZAČÍNÁ
//
// NEKONTROLUJE SE — a to je záměrná hranice, ne opomenutí:
//
//   ✗ „je toto DELŠÍ slovo vůbec české“. Bez slovníku se to nepozná a tvrdit
//     to by byl podvod. Delší vymyšleniny proto občas projdou — hlavně v
//     `assonance`, kde je to „téměř rým“ a uživatel si to posoudí sám.
//     Proti tomu je třetí krok: `songcraft-rhymes` po neúspěchu dotaz
//     ZOPAKUJE se striktnějším promptem, který výslovně zakazuje cizí jazyky
//     a jmenuje konkrétní vyhozené tvary.
//
// ZDE VYTVZOROVANÁ MEZE — co přesně po opravách ještě zůstává
// ---------------------------------------------------
// Živý test 2026-10-05 po přidání kontrol CVC, CCV, nemožných dvojic písmen
// (`jc`), samohlásky+koncovky a stropu na assonance. Ke „srdce“ (koncovka „ce“)
// model vrací pořád toto:
//
//     exact: ["vřece", "přece", "zřece", "břece", "vzece", …]
//
// Z toho je správně jen `přece`. `vřece`, `zřece` a `vzece` jsou vymyšleniny.
// ZKOUŠEL jsem je odchytit kontrolou počáteční souhláskové skupiny a to SELHALO
// ve všech variantách:
//
//   - kontrola všech dvousouhláskových onsetsů odhazovala SKUTEČNÁ slova
//     (`zpráva`, `zbraň`, `ztráta`, `šroub`, `srdce`) a `vřece` propustila,
//   - zúžení na `vř` a `zř` s NEDIACRITIZOVANÝM porovnáním propouští `vřece`,
//     protože po odhození diakritiky z `vř` zbude `vr`, a to je běžný onset
//     (`vrata`, `vrba`),
//   - zúžení na `vř` a `zř` S diakritikou odhazuje skutečné slovo `vřes`.
//
// Tvrzení „`vř` není český onset“ je tedy prokazatelně chybné. Raději je tohle
// napsané a kontrola nepřidána, než aby v repu byla pravidla, která říkají
// nesmysl. Zbývající mez je jednoznačná: BEZ SLOVNÍKU nelze poznat, že
// `vřece` není slovo. Je to jediná zbylá vada a je popsáná tady, ne skrytá.
//
// PROČ TU NENÍ SEZNAM ANGLICKÝCH SLOV
// ------------------------------------
// Původní návrh měl blacklist typu „pen, pen, star, core…“. Zahozeno, protože
// většina takových slov je v češtině legitimní: „park“, „bark“, „art“, „start“,
// „part“, „bar“, „den“, „ten“, „sen“ jsou česká slova. Takový blacklist by
// potřeboval stovky položek a pořád by někoho usekl, protože český jazyk si
// běžně půjčuje. Kontrola `CZECH_CVC_SHORT` odchyytí přesně ty případy, které
// se reálně vyskytly (viz výše „sen“), a to bez rizika falešných poptávek.
//
// Záměrně NEŘEŠÍ: hodnocení estetické kvality rýmu a výběr nejlepších návrhů.
// To je práce pro člověka nebo pro velký slovník, ne pro regex.
// =============================================================================

/** Samohlásky, kterými česká rýma končí. `y` je v češtině samohláska. */
const VOWELS = "aáeéěiíoóuúůyý";

/** Dvojice písmen, která zní jako JEDNA hláska. Nejsou to shluky dvou souhlásek. */
const DIPHTHONGS = ["ch", "dz", "dž"];

/** Celá česká abeceda včetně písmen s diakritikou. Cokoliv jiného je cizí. */
const CZECH_LETTERS = new Set([..."aábcčdďeéěfghiíjklmnňoópqrřsštťuúůvwxyýzž"]);

const isVowel = (character: string | undefined): boolean =>
  character !== undefined && VOWELS.includes(character);

/** Obsahuje slovo shluk dvou souhlásek? Shluk znamená, že je více slabik. */
function hasConsonantCluster(word: string): boolean {
  const letters = [...word.toLocaleLowerCase("cs-CZ")];
  // Dvojice jako „ch“ zní jako jedna hláska, takže se nepočítají jako shluk.
  const flat: string[] = [];
  for (let index = 0; index < letters.length; index += 1) {
    const pair = letters[index] + (letters[index + 1] ?? "");
    if (DIPHTHONGS.includes(pair)) {
      flat.push(pair);
      index += 1;
    } else {
      flat.push(letters[index]);
    }
  }
  return flat.some((entry, index) =>
    index > 0 && entry.length === 1 && !isVowel(entry) && flat[index - 1].length === 1 && !isVowel(flat[index - 1])
  );
}

/** Počet jader — kolik má slovo slabik. */
function countNuclei(word: string): number {
  return [...word.toLocaleLowerCase("cs-CZ")].filter(isVowel).length;
}

/** Je slovo jednoslabičné? Pak je na hranici rýmy jen samohláska s coda. */
function isMonosyllabic(word: string): boolean {
  // Jedno jádro = jedna slabika, ledaže sloveso shluk souhlásek: „srdce“ má
  // jedinou samohlásku, ale dvě slabiky (srd-ce), protože „sr“ je skupina,
  // která patří do onsetu.
  return countNuclei(word) < 2 && !hasConsonantCluster(word);
}

/**
 * Rýmová koncovka = poslední přízvučná SLABIKA.
 *
 * Tady je celá pointa a je to složitější, než to vypadá. Česká rýma se nepozná
 * podle poslední samohlásky — podle všeho od poslední přízvučné samohlásky do
 * konce. A „poslední přízvučná samohláska“ NENÍ vždy poslední samohláska:
 *
 *   „noc“   je jednoslabičné, přízvor je na celém slově. Rýmuje „oc“ — NE „noc“,
 *          protože „moc“ je dokonalá rýma a „oc“ je její kost.
 *   „srdce“ má dvě slabiky (srd-ce) a přízvor na „ce“. Rýmuje „ce“ — NE „e“.
 *          Kdyby vyšlo „e“, kontrola by považovala „kde“ za rýmu ke „srdce“,
 *          protože obě končí na „e“. To byl živý nález 2026-10-05.
 *   „řece“  má dvě slabiky (ře-ce) → taky „ce“.
 *
 * Jednoslabičnost se pozná podle počtu jader a přítomnosti shluku souhlásek.
 * Bez tohoto rozlišení kontrola buď vracela vymyšleniny, nebo odmítala dobré
 * rýmy podle toho, která chyba vyšla např.
 */
export function rhymeTail(word: string): string {
  const lower = word.toLocaleLowerCase("cs-CZ");
  let vowelIndex = -1;
  for (let index = lower.length - 1; index >= 0; index -= 1) {
    if (isVowel(lower[index])) {
      vowelIndex = index;
      break;
    }
  }
  if (vowelIndex < 0) return "";
  if (isMonosyllabic(lower)) return lower.slice(vowelIndex);
  // Víceslabičné: rýmuje celá poslední slabika, tedy i její onset — ne však
  // celou úvodní skupinu souhlásek (viz `strongTail`).
  return strongTail(lower);
}

/**
 * Poslední slabika vždy s onsetem, bez ohledu na shluk.
 *
 * Onset je MAXIMÁLNĚ JEDNA hláska (jedno písmeno, nebo dvojice jako „ch“,
 * která zní jako jedna hláska). Víc to být nemůže: kdyby se do onsetu
 * dostala celá úvodní skupina, „srdce“ by skončilo koncovkou „srdce“ a nic by
 * s ním nerýmovalo. Česká slabika má vždy jen jednu začáteční hlásku před
 * samohláskou, zbytek tvoří předchozí slabika.
 */
function strongTail(word: string): string {
  const lower = word.toLocaleLowerCase("cs-CZ");
  let vowelIndex = -1;
  for (let index = lower.length - 1; index >= 0; index -= 1) {
    if (isVowel(lower[index])) {
      vowelIndex = index;
      break;
    }
  }
  if (vowelIndex < 0) return "";
  // Jedna hláska před samohláskou. Dvojice („ch“) se počítá jako jedna, takže
  // u „sprcha“ je to „ch“ a ne „rch“.
  const pair = (lower[vowelIndex - 2] ?? "") + (lower[vowelIndex - 1] ?? "");
  const onsetStart = DIPHTHONGS.includes(pair)
    ? vowelIndex - 2
    : vowelIndex - 1;
  return onsetStart >= 0 ? lower.slice(onsetStart) : lower.slice(vowelIndex);
}

/**
 * Je zadaný tvar skutečně rým?
 *
 * Porovnávají se DVĚ možné čtení, protože u tvaru bez shluku (`řece`) není
 * patrné, že poslední slabika je „ce“:
 *
 *   dotaz „srdce“ → koncovka „ce“
 *     „řece“  vlastní koncovka „e“   ✘   silná koncovka „ce“  ✔ přijato
 *     „práce“ vlastní koncovka „e“   ✘   silná koncovka „ce“  ✔ přijato
 *     „kde“   vlastní koncovka „de“  ✘   silná koncovka „de“  ✘  vyhozeno
 *   dotaz „noc“   → koncovka „oc“
 *     „moc“   „oc“ ✔   „kolo“ → „o“ / „lo“ ✘ (chybí „c“ — to je volný rým)
 */
export function hasRhymeSound(candidate: string, queryTail: string): boolean {
  if (!queryTail) return false;
  const own = rhymeTail(candidate);
  if (own.length > 0 && own.endsWith(queryTail)) return true;
  const strong = strongTail(candidate);
  return strong.length > 0 && strong.endsWith(queryTail);
}

/** Sjednocení pro porovnání: malá písmena, bez diakritiky, bez interpunkce. */
export function foldWord(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("cs-CZ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");
}

/** Obsahuje token písmeno, které v české abecedě není? */
export function hasForeignCharacter(value: string): boolean {
  return [...value.trim()].some((character) =>
    /\p{L}/u.test(character) && !CZECH_LETTERS.has(character.toLocaleLowerCase("cs-CZ"))
  );
}

/**
 * Česká tříznenná slova tvaru konsonant–samohláska–konsonant.
 *
 * Proč seznam, a ne slovník: u tříznenných tvarů se model chybuje nejčastěji a
 * česká zásoba je tady opravdu malá a uzavřená. Když model vrátí tříznenné
 * slovo, které tady není, je to s vysokou pravděpodobností vymyšlenina —
 * přesně to byl živý nález u „sen“.
 *
 * Zadáno NEDIACRITIZOVANĚ a porovnává se přes `foldWord`. Přidávat sem slovo s
 * diakritikou je tedy možné, ale musí být v seznamu i jeho oháčkovaná podoba —
 * jinak by tiše neprošlo. Když nejsi jistý/a, jestli je to české slovo,
 * NEPŘIDÁVEJ: to by to kontrolu oslabilo stejně jako její chybějící.
 */
const CZECH_CVC_SHORT = new Set([
  // skutečná česká tříznenná CVC
  "ach", "baz", "bit", "byt", "cep", "cuk", "cyk", "dej", "dil", "dym", "gol",
  "hreb", "hul", "hys", "chl", "klic", "klid", "krb", "kul", "kur", "lin",
  "lit", "mec", "mit", "moc", "noc", "pan", "pes", "prs", "pyt", "rys",
  "sen", "sin", "syp", "sev", "sip", "suk", "tys", "ves", "vul", "vys",
  "zub", "zal", "zar", "zil", "zen", "ok", "oko", "led", "ret", "stul", "host",
  "noh", "pch", "vlk",
  // časté funkční a krátké tvary, které model vrací jako „rýmu“ k sobě samým
  "den", "ten", "jen", "ven", "nic", "vim", "uz",
  // ZAMYŠLENĚ NECHYBÍ „fen“ (diakriticky „fén“ = větrák). Po odhození
  // diakritiky by ale propadl i tvar „fen“, který český NENÍ — a právě „fen“
  // patřilo k vymyšleninám, které model vracel ke slovu „sen“. Radši chybějící
  // „fén“ než propuštěné „fen“.
]);

/**
 * Česká tříznenná slova tvaru DVĚ souhlásky + samohláska (CCV).
 *
 * `isShortCvc` původně pokrýval jen CVC, ale živý test 2026-10-05 ukázal, že se
 * model chybuje i na CCV: ke „sen“ vrátil assonance
 * `["mle", "bole", "kre", "sně", "hle", "vě", "zne", "nje"]` — pět z osmi byl
 * vymyšlené shluky. Tvar CCV má česká zásoba také malou a uzavřenou, takže se
 * dá kontrolovat stejně jako CVC.
 *
 * Diakritika je zde VYLOČENĚ: „žď“ neexistuje, ale „džu“ (písmeno `ž` jako
 * jedno znění) ano. Proto jsou v seznamu tvary psané NEDIACRITIZOVANĚ.
 */
const CZECH_CCV_SHORT = new Set([
  "bzu", "dzu", "flu", "hlu", "hra", "hry", "chu", "jde", "kdo", "kdo",
  "kra", "kri", "mlu", "mna", "noh", "plu", "pra", "pro", "sla", "slo",
  "sra", "sro", "sta", "sto", "stu", "tla", "tka", "tra", "tro", "tru",
  "noh", "pla", "plu", "sru",
  "vla", "vlo", "vra", "vro", "zda", "zde", "zla", "zlo", "zmu",
  // Funkční slovesa, která se v assonance objevují často: „zda“ nebylo v prvním
  // živém výstupu, ale je to běžné české slovo a chybělo by jako poptávka.
]);

/** Tříznenný tvar konsonant–samohláska–konsonant? */
function isShortCvc(folded: string): boolean {
  if (folded.length !== 3) return false;
  const [first, vowel, last] = folded;
  return !VOWELS.includes(first) && VOWELS.includes(vowel) && !VOWELS.includes(last);
}

/** Tříznenný tvar dvě souhlásky + samohláska? */
function isShortCcv(folded: string): boolean {
  if (folded.length !== 3) return false;
  const [first, second, vowel] = folded;
  return (
    !VOWELS.includes(first) &&
    !VOWELS.includes(second) &&
    VOWELS.includes(vowel)
  );
}

/**
 * Je to jen samohláska plus coda koncovky? Tedy vymyšlenina, ne slovo.
 *
 * Živý nález 2026-10-05: ke „srdce“ (koncovka „ce“) model vrátil
 * `exact: ["ace","ece","ice","oce","uce","áce","éce","íce","óce","úce"]` —
 * deset položek, z nichž ANI JEDNA není české slovo. Všechny jsou tříznenné a
 * začínají samohláskou, takže je kontrola CVC/CCV minula.
 *
 * Proč je to tak jisté: česká slabika NEMÁ samohláskový onset. Tříznenný tvar
 * `X + coda`, kde X je samohláska, by tedy zněl jako dvě slabiky `X-coda` a
 * musel by být dlouhý. „ace“ = /a.ˈt͡sɛ/ neexistuje, protože by to bylo slovo
 * tvaru „a-ce“, kde „ce“ je celá druhá slabika — a v češtině žádný kořen takhle
 * nevzniká.
 *
 * Kontrola je ZÚŽENÁ na přesný tvar, který byl naměřen: tří písmena, první
 * samohláska, a POSLEDNÍ DVA znaky přesně koncovka dotazu. Skutečná česká slova
 * tím nejsou dotčena — „oko“ má koncovku „ko“, „osa“ má „sa“ a na „a“ začínat
 * nemusí, aby byla koncovka shodná s dotazem.
 */
function isTailFiller(value: string, queryTail: string): boolean {
  const folded = foldWord(value);
  if (folded.length !== 3 || queryTail.length !== 2) return false;
  return VOWELS.includes(folded[0]) && folded.slice(1) === foldWord(queryTail);
}

/** České CVC/CCV, nebo aspoň ne tříznenný tvar — tedy nelze ho odmítnout tvarem. */
function shortCvcIsAcceptable(folded: string): boolean {
  if (isShortCvc(folded)) return CZECH_CVC_SHORT.has(folded);
  if (isShortCcv(folded)) return CZECH_CCV_SHORT.has(folded);
  return true;
}

/**
 * Dvojice písmen, které v češtině NEMŘÍ následovat za sebou v žádném tvaru.
 *
 * Česká slovní zásoba zná jen omezené onsety (za `j` smí následovat jen samohláska
 * nebo `c`/`s`/`z`/`š`/`ž`/`ch`, proto `jc` neexistuje), ale na `q`/`x` jako
 * samostatné písmena česká slova vůbec nemá. Toto je už lexikální poznání, ne
 * tvarové — je to jediná výjimka z pravidla „bez slovníku se sloveso nepozná",
 * a je záměrná: živý nález 2026-10-05 ke „srdce“ vrátil `dvojce`, které fonologicky
 * sedí na `-ce`, ale obsahuje skupinu `jc`. Jedno pravidlo proti jednomu výskytu
 * je levné a nemá riziko poptávky, protože `jc` se v češtině nevyskytuje vůbec.
 */
const IMPOSSIBLE_BIGRAMS = ["jc", "cj", "sj", "jj", "qx", "kq", "xc", "cq"];

function hasImpossibleBigram(value: string): boolean {
  const folded = foldWord(value);
  return IMPOSSIBLE_BIGRAMS.some((pair) => folded.includes(pair));
}

/**
 * Kolik slov smí mít skupinová rýma?
 *
 * Naměřeno živě 2026-10-05: model k „noc“ vracel
 * „to je moc“, „je to moc“, „to je opravdu moc“, „to je vážně moc“,
 * „to je až moc“, „to je dost moc“… Všechny končí na „moc“ a fonologicky
 * projdou, ale uživateli to nedává nic — je to výplň, ne rýma. Česká skupinová
 * rýma je „předložka/zájmeno + slovo“ nebo „přídavné jméno + slovo“ („krátký
 * den“), tedy dvě až tři slova.
 */
const MULTIWORD_MAX_WORDS = 3;

/**
 * Kolik skupin se smí opakovat na STEJNÉM posledním slově.
 *
 * Naměřeno živě 2026-10-05 k „noc“: „velká moc“, „silná moc“, „obrovská moc“,
 * „božská moc“, „lidská moc“, „vojenská moc“, „politická moc“… Dvanáct položek,
 * z nichž všech dvanáct rýmuje totéž slovo „moc“. Uživatel si z toho vybere
 * „velká moc“ a ostatní jedenáct je jen hluk. Dvě na jedno poslední slovo
 * nechává variantu, ale zbytek odfiltruje.
 */
const MULTIWORD_PER_LAST_WORD = 2;

/**
 * Kolik položek assonance smí sdílet stejnou poslední hláskovou dvojici.
 *
 * Naměřeno živě 2026-10-05 u „noc“: assonance vyšlo
 * `moko, loko, boko, soko, toko, woko, zoko, joko` — osm položek, z nichž
 * SKORO ŽÁDNÉ není české slovo. Všechny jsou totéž vymyšlený tvar s vyměněnou
 * první hláskou. Bez této kontroly je to přesně to, co uživatel dostane.
 *
 * Dvojice se počítá z posledních DVOU znaků, ne z koncovky dotazu — to je
 * záměrně jiná veličina. Skutečné české assonance to snese: u „srdce“ živě vyšlo
 * `míru, tělo, věci, píseň, sníh, móda, více, květe` a jen „hnědo, červeno,
 * zeleno“ sdílí „-do“. Ztrácí se tím jedna položka, ale získává se jistota, že
 * zbytek uživateli nedá rodinu vymyšlenin.
 */
const ASSONANCE_PER_ENDING = 2;

/**
 * Slovesa a ukazovací zájmena, kvůli kterým je skupina frází, ne rýmou.
 * Kdyby stačilo omezit délku, „to je moc“ (tři slova) by prošlo.
 */
const MULTIWORD_FILLER = new Set([
  "je", "jsem", "jsme", "jsi", "jste", "bude", "budu", "budeme", "budeš",
  "bych", "byl", "byla", "bylo", "nechť", "to", "toho", "tohle", "toto",
  "protože", "proto", "takže", "když", "aby", "jenom", "právě", "opravdu",
  "fakt", "vážně", "neskutečně", "hodně", "moc", "trochu", "dost", "až",
]);

export type GuardedRhymes = {
  exact: string[];
  multiword: string[];
  assonance: string[];
  /** Co bylo vyhozeno — jde do zpřesněného promptu při opakování. */
  rejected: string[];
};

/**
 * Hlavní vstupní bod. Převezne to, co model vrátil, a vrátí jen to, co se dá
 * obhájit.
 *
 * `queryTail` je rýmová koncovka z `rhymeTail(query)` — nikoli poslední
 * samohláska. `queryWord` je hledané slovo tak, jak ho napsal uživatel.
 */
export function guardRhymes(
  parsed: { exact?: unknown; multiword?: unknown; assonance?: unknown },
  options: { queryWord: string; queryTail?: string; exclude?: string[] },
): GuardedRhymes {
  const queryWord = options.queryWord.trim();
  const queryTail = options.queryTail || rhymeTail(queryWord);
  const queryFolded = foldWord(queryWord);
  const excluded = new Set((options.exclude ?? []).map((entry) => foldWord(entry)));
  const rejected = new Set<string>();
  const seen = new Set<string>();
  /** Kolikrát už se objevilo dané poslední slovo skupinové rýmy. */
  const lastWordCount = new Map<string, number>();
  /** Kolikrát už se objevila daná hlásková dvojice na konci assonance. */
  const endingCount = new Map<string, number>();

  const reject = (value: string): void => {
    if (value.trim()) rejected.add(value.trim().slice(0, 60));
  };

  const take = (list: unknown, kind: "exact" | "multiword" | "assonance", limit: number): string[] => {
    const out: string[] = [];
    if (!Array.isArray(list)) return out;
    for (const raw of list) {
      if (typeof raw !== "string") continue;
      const value = raw.trim().slice(0, 60);
      if (!value) continue;
      const key = value.toLocaleLowerCase("cs-CZ");
      const folded = foldWord(value);
      if (seen.has(key)) continue;
      if (excluded.has(folded)) continue;
      seen.add(key);

      if (!folded || hasForeignCharacter(value) || hasImpossibleBigram(value)) {
        reject(value);
        continue;
      }
      if (isTailFiller(value, queryTail)) {
        reject(value);
        continue;
      }

      if (kind === "exact") {
        // Hledané slovo jako VLASTNÍ rýma je chyba, ne rým. Naměřeno živě:
        // `openai/gpt-oss-20b` vracelo přesně tohle.
        if (folded === queryFolded) {
          reject(value);
          continue;
        }
        if (!hasRhymeSound(value, queryTail) || !shortCvcIsAcceptable(folded)) {
          reject(value);
          continue;
        }
      }

      if (kind === "multiword") {
        const words = value.split(/\s+/).filter(Boolean);
        const lastWord = words[words.length - 1] ?? "";
        // „ta noc“, „hluboká noc“, „do důlu“ — poslední slovo nesmí být to, co
        // uživatel hledal. Jinak je to jen nalešovaná fráze, ne rým.
        if (foldWord(lastWord) === queryFolded) {
          reject(value);
          continue;
        }
        // Skupinová rýma je „předložka + slovo“, ne celá věta. Viz
        // `MULTIWORD_MAX_WORDS`.
        if (words.length > MULTIWORD_MAX_WORDS) {
          reject(value);
          continue;
        }
        // A poslední slovo musí být jedno slovo, ne další fráze.
        if (/\s/.test(lastWord)) {
          reject(value);
          continue;
        }
        // „to je moc“ — tři slova, ale sloveso. To je výplň, ne rýma.
        if (words.slice(0, -1).some((word) => MULTIWORD_FILLER.has(foldWord(word)))) {
          reject(value);
          continue;
        }
        if (!hasRhymeSound(lastWord, queryTail) || !shortCvcIsAcceptable(foldWord(lastWord))) {
          reject(value);
          continue;
        }
        // „velká moc“, „silná moc“, „božská moc“ — tohle je jen ta jedna rýma
        // třikrát. Dvě varianty nechává, zbytek odfiltruje.
        const key = foldWord(lastWord);
        const repeats = lastWordCount.get(key) ?? 0;
        if (repeats >= MULTIWORD_PER_LAST_WORD) {
          reject(value);
          continue;
        }
        lastWordCount.set(key, repeats + 1);
      }

      // `assonance` je volný rým — jde o „téměř“, takže zvuková kontrola koncovky
      // by byla příliš tvrdá a zahodila by i dobré návrhy. Kontrola tvaru se
      // ale aplikuje stejně, protože nejhorší vymyšleniny jsou právě tříznenné.
      // Naměřeno živě 2026-10-05 ke „sen“: assonance vyšlo
      // ben, fen, gen, hen, ken, len, men, nen — osm vymyšlených tvarů, žádný
      // český. Bez této kontroly je to přesně to, co uživatel dostane.
      // Hledané slovo je v každé skupině chyba (naměřeno: k „srdce“ se vrátilo
      // assonance ["srdce", …]).
      if (folded === queryFolded) {
        reject(value);
        continue;
      }
      if (!shortCvcIsAcceptable(folded)) {
        reject(value);
        continue;
      }
      if (kind === "assonance") {
        const ending = folded.slice(-2);
        const repeats = endingCount.get(ending) ?? 0;
        if (repeats >= ASSONANCE_PER_ENDING) {
          reject(value);
          continue;
        }
        endingCount.set(ending, repeats + 1);
      }
      out.push(value);
      if (out.length >= limit) break;
    }
    return out;
  };

  return {
    exact: take(parsed.exact, "exact", 12),
    multiword: take(parsed.multiword, "multiword", 12),
    assonance: take(parsed.assonance, "assonance", 8),
    rejected: [...rejected].slice(0, 24),
  };
}

/**
 * Poslední slovo z přijaté skupinové rýmy, pokud je to samo o sobě přesná rýma.
 *
 * Naměřeno živě 2026-10-05: model často odloží správné přesné rýmy do `multiword`
 * jako přídavné jméno a `exact` nechá prázdné. K „noc“ vrátil
 * `multiword: ["velká moc", "silná moc", …]` s prázdným `exact` — přitom „moc“
 * je přesná rýma, jen zakopaná ve frázi. Bez toho by uživatel hledal rýmy k „noc“
 * a „moc“ by nedostal.
 *
 * Není to podepírání modelu: poslední slovo tady prochází TÝŽŽ kontrolami jako
 * `exact` (koncovka, tříznenné CVC, cizí znaky, hledané slovo). Když neprojde,
 * nepromoteuje se a výsledek zůstane beze změny.
 */
export function promoteExactFromMultiword(
  input: GuardedRhymes,
  options: { queryWord: string; queryTail?: string },
): GuardedRhymes {
  if (input.exact.length || !input.multiword.length) return input;
  const candidates = input.multiword
    .map((phrase) => phrase.split(/\s+/).filter(Boolean).pop() ?? "")
    .filter(Boolean);
  if (!candidates.length) return input;
  const promoted = guardRhymes({ exact: candidates }, {
    queryWord: options.queryWord,
    queryTail: options.queryTail,
  });
  return promoted.exact.length ? { ...input, exact: promoted.exact } : input;
}

/**
 * Je výsledek dobrý, nebo se má dotaz opakovat?
 *
 * Opakování se spouští jen když je k němu důvod:
 *   - `exact` je prázdné — pak odpověď na otázku uživatele stejně nic neříká,
 *     a zpřesněný prompt je má šanci doplnit, nebo aspoň potvrdit prázdno,
 *   - něco bylo vyhozeno — první pokus selhal kontrolu, takže druhý má šanci.
 *
 * Čistý prázdný výsledek (nic neprošlo, protože nic nepřišlo) se TAKY zkouší
 * jednou. Jde o pojišťovnu, ne o smyčku: je to VŽDY nejvýše jeden dotaz navíc,
 * takže nejhorší případ jsou dva pokusy po ~60 s = ~120 s, a naměřený strop
 * edge funkce je ~150 s. Třetí pokus už visel.
 */
export function shouldRetry(input: { exact: string[]; multiword: string[]; assonance: string[]; rejected: string[] }): boolean {
  return input.exact.length === 0 || input.rejected.length > 0;
}