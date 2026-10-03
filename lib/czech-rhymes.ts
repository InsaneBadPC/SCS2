const WORD_BANK = `
  ach anděl auto barva báseň bílá blízko bolest bouře brána budoucnost cesta cíl cizí čas čára černá člověk dál dar déšť dívka dům dýcha dým dnes doba domov dotek druh duše dřevo echo energie fantazie film fotografie hlas hlava hladina hned hodina hora hvězda hra hřích hudba chlad chléb chyba idea jaro jas jediné jméno kámen klid klíč konec kouř kraj krása krev křídla kus láska led let léto list louka lucerna lidé lítost loď luna mapa město milost mír mlha moře most mráz místo mysl naděje nádech noc nohy nová obloha oheň okamžik obraz odraz osud paměť papír píseň plán plamen pohled pokoj pole pomoc pravda prázdno prší prsten pták ráno radost ruka růže rok sám sen srdce síla slib slunce slovo smích sníh sen stín strach strom svět ticho tělo touha tráva tvář ulice úsměv voda vteřina vzduch vzkaz vítr vůně věta země život životy žár žízeň
  bála chvála dálka válka malá stála hrála znala brána rána strana hrana ráda zahrada parada víra míra síla chvíle píše dýše tiše výše blíže níže kříže říše spíše slyšet vidět letět světě květě dítě sítě bytí žití snití skrytí víc líc říct klid lid styd jít mít být snít znít cítit věřit hořet shořet letět přiletět odletět jméno seno víno kino stíno hlíno jednou tmou hrou touha dlouhá pouhá druhá duha kruha brzy slzy drzí mrzí malý stálý bílý milý síly chvíli díly chvíle míle cíle sílí pálí válí dálí hraje taje kraje záje ráje
  noc moc pomoc nemoc krok rok bok sok tok skok hlas čas pás jas klas vlas krás obraz mráz hráz vzkaz hlasitost radost starost znalost věčnost skvělost tma hra jiskra iskra víla síla míla chvíla dráha váha záha snaha Praha město gesto místo čisto jistě příště ještě věšte ticho lichou rychlou pýchou střechou cestou městou hvězdou vodou svobodou náhodou pohodou přírodou dlaní ranní paní hraní stání volání poznání přání zdání
  srdce ruce pruce luce konce slunce měsíce ulice tradice emoce revoluce situace inspirace generace vibrace meditace informace nominace variace kombinace komplikace komunikace imaginace harmonie melodie poezie energie strategie symfonie nostalgie magie elegie terapie galaxie fantazie chemie akademie
  domy stromy hromy zlomy vlny plány brány rány stěny ceny změny ženy hlavy zprávy trávy slávy barvy tvary dary tváře páry žáry jazyky dotyky okamžiky návyky zázraky otázky pásky lásky masky prasky desky blesky stesky výkřiky doteky nádechy výdechy úsměvy příběhy náhody schody dohody svobody
  svět let květ vzkvétá pět zpět hned led med jed před teď teďka klec věc pec řeč meč křeč běž věž déšť ještě štěstí neštěstí cesty gesty městy hvězdný věrný černý jemný něžný silný pilný klidný vlídný jiný jediný poslední původní svobodný podobný náhodný
`.trim().split(/\s+/);

const uniqueWords = Array.from(new Set(WORD_BANK.map((word) => word.toLocaleLowerCase("cs-CZ"))));
const vowels = new Set(["a", "e", "i", "o", "u", "y"]);

export type RhymeSuggestion = { word: string; score: number; label: "Přesný rým" | "Volný rým" };

export function normalizeCzechWord(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("cs-CZ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z]/g, "");
}

function vowelEnding(value: string) {
  const lastVowel = [...value].map((letter, index) => ({ letter, index })).filter(({ letter }) => vowels.has(letter)).pop();
  return lastVowel ? value.slice(lastVowel.index) : value.slice(-2);
}

export function findCzechRhymes(query: string, limit = 24, customWords: string[] = []): RhymeSuggestion[] {
  const needle = normalizeCzechWord(query);
  if (needle.length < 2) return [];
  const exactEnd = needle.slice(-Math.min(3, needle.length));
  const looseEnd = needle.slice(-2);
  const vowelEnd = vowelEnding(needle);
  const candidateWords = Array.from(new Set([...uniqueWords, ...customWords.map((word) => word.toLocaleLowerCase("cs-CZ"))]));
  return candidateWords
    .filter((word) => normalizeCzechWord(word) !== needle)
    .map((word) => {
      const comparable = normalizeCzechWord(word);
      const exact = comparable.endsWith(exactEnd);
      const loose = comparable.endsWith(looseEnd);
      const sameVowelEnding = vowelEnding(comparable) === vowelEnd;
      const score = exact ? 100 + comparable.length : loose ? 70 + comparable.length : sameVowelEnding ? 40 + comparable.length : 0;
      return { word, score, label: exact ? "Přesný rým" as const : "Volný rým" as const };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.word.localeCompare(b.word, "cs-CZ"))
    .slice(0, limit);
}
