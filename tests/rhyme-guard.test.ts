import { describe, expect, it } from "vitest";

// Testy jsou psané proti VÝSTUPŮM SKUTEČNĚ NAMĚŘENÝM živě na
// `nvidia/nemotron-3-super-120b-a12b` dne 2026-10-05 přes edge funkci
// `songcraft-rhymes`. Nejsou to hypotetické vstupy — každý z nich je přesně to,
// co bezplatný model poslal a uživatel by to dostal na obrazovku.
import {
  guardRhymes,
  hasForeignCharacter,
  hasRhymeSound,
  promoteExactFromMultiword,
  rhymeTail,
  shouldRetry,
} from "../supabase/functions/_shared/rhyme-guard";

const guard = (word: string, parsed: { exact?: unknown; multiword?: unknown; assonance?: unknown }) =>
  guardRhymes(parsed, { queryWord: word, queryTail: rhymeTail(word) });

describe("rýmová koncovka", () => {
  it("u jednoslabičného slova počítá jen samohlásku s coda", () => {
    // „moc“ je dokonalá rýma k „noc“, takže koncovka nesmí být „noc“ —
    // jinak by se „noc“ nerýmovalo samo se sebou.
    expect(rhymeTail("noc")).toBe("oc");
    expect(rhymeTail("sen")).toBe("en");
    expect(rhymeTail("den")).toBe("en");
  });

  it("u víceslabičného slova zahrne i onset poslední slabiky", () => {
    // „srdce“ = srd-ce. Koncovka je „ce“, NE „e“.
    // Kdyby vyšla „e“, považovala by kontrola „kde“ za rýmu ke „srdce“.
    expect(rhymeTail("srdce")).toBe("ce");
    // „řece“ i „práce“ mají shluk na začátku („ř“ je sonorant před „c“),
    // takže obě končí „ce“. To je přesně to, kvůli čemu se v nich dá poznat,
    // že „srdce“ má koncovku „ce“.
    expect(rhymeTail("řece")).toBe("ce");
    expect(rhymeTail("práce")).toBe("ce");
  });

  it("nechá dvojice znějící jako jedna hláska být jednou hláskou", () => {
    // V „sprcha“ je onset poslední slabiky „ch“, ne „rch“.
    expect(rhymeTail("sprcha")).toBe("cha");
  });

  it("slovo bez samohlásky nemá rýmovou hlásku", () => {
    expect(rhymeTail("sh")).toBe("");
  });
});

describe("shoda zvuku", () => {
  it("odmítne „kde“ jako rýmu ke „srdce“", () => {
    // Živý nález 2026-10-05: model vracel přesně tohle a vydal to za přesné rýmy.
    expect(hasRhymeSound("kde", "ce")).toBe(false);
    expect(hasRhymeSound("nebe", "ce")).toBe(false);
    expect(hasRhymeSound("době", "ce")).toBe(false);
  });

  it("přijme „řece“ a „práce“ jako rýmy ke „srdce“", () => {
    expect(hasRhymeSound("řece", "ce")).toBe(true);
    expect(hasRhymeSound("práce", "ce")).toBe(true);
    expect(hasRhymeSound("síce", "ce")).toBe(true);
  });

  it("nerozdělí jednoslabičné rýmy", () => {
    expect(hasRhymeSound("moc", "oc")).toBe(true);
    expect(hasRhymeSound("kolo", "oc")).toBe(false);
  });
});

describe("kontrola živého výstupu modelu", () => {
  it("ke slovu „sen“ vyhodí vymyšleniny a nechá skutečná slova", () => {
    // NAMĚŘENO ŽIVĚ: exact = pen, ven, den, men, len, fen, ken, ben.
    // Česká jsou jen ven a den — ostatní jsou vymyšlené náhrady koncovky
    // (naměřeno i v předchozím běhu: pen, fen, ken, ben).
    const result = guard("sen", {
      exact: ["pen", "ven", "den", "men", "len", "fen", "ken", "ben"],
      multiword: [],
      assonance: [],
    });
    expect(result.exact).toEqual(["ven", "den"]);
    expect(result.rejected).toContain("pen");
    expect(result.rejected).toContain("ken");
    expect(result.rejected).toContain("ben");
  });

  it("ke slovu „srdce“ vyhodí slova končící jen na „e“", () => {
    // NAMĚŘENO ŽIVĚ: kde, že, se, ve, ne, městě, nebe, době, půdě, krávě, řece.
    // Z toho je jediné české rýmu „řece“ — ostatní končí /ɛ/, „srdce“ končí
    // /t͡stsɛ/. Prázdné `exact` tady NENÍ chyba, ale pravdivá odpověď: v češtině
    // skoro žádná přesná rýma ke „srdce“ neexistuje.
    const result = guard("srdce", {
      exact: ["kde", "že", "se", "ve", "ne", "městě", "nebe", "dle", "době", "půdě", "krávě", "řece"],
      multiword: [],
      assonance: [],
    });
    expect(result.exact).toEqual(["řece"]);
  });

  it("vyhodí nalešované fráze s hledaným slovem na konci", () => {
    // NAMĚŘENO ŽIVĚ: „ta noc“, „tahle noc“, „hluboká noc“, „černá noc“… Uživatel
    // hledal rýmy k „noc“ a dostal „noc“ s přídavkem.
    const result = guard("noc", {
      exact: ["moc"],
      multiword: ["ta noc", "tahle noc", "hluboká noc", "černá noc", "bílá noc"],
      assonance: ["oko", "kolo", "máslo"],
    });
    expect(result.exact).toEqual(["moc"]);
    expect(result.multiword).toEqual([]);
    expect(result.assonance).toEqual(["oko", "kolo", "máslo"]);
  });

  it("odmítne hledané slovo jako jeho vlastní rýmu", () => {
    // NAMĚŘENO ŽIVĚ na `openai/gpt-oss-20b`, který vracel hledané slovo zpět.
    expect(guard("noc", { exact: ["noc"] }).exact).toEqual([]);
  });

  it("odmítne cizí znaky", () => {
    expect(hasForeignCharacter("řeka")).toBe(false);
    expect(hasForeignCharacter("river")).toBe(false);
    expect(hasForeignCharacter("říčka")).toBe(false);
    // „r“, „i“, „v“, „e“ všechny v české abecedě jsou, takže „riverr“ je
    // pustý český spelling. Cizí znak musí být znak, který v abecedě není.
    expect(hasForeignCharacter("ørpen")).toBe(true);
    expect(hasForeignCharacter("møk")).toBe(true);
    expect(guard("noc", { exact: ["moc", "økt"] }).exact).toEqual(["moc"]);
  });

  it("nesmí vrátit to, co uživatel viděl", () => {
    const result = guardRhymes(
      { exact: ["ven", "den"], multiword: [], assonance: [] },
      { queryWord: "sen", queryTail: "en", exclude: ["ven"] },
    );
    expect(result.exact).toEqual(["den"]);
  });

  it("odfiltruje duplicity a nerozdělí pole, které není pole", () => {
    expect(guard("noc", { exact: ["moc", "MOC", "moc"] }).exact).toEqual(["moc"]);
    expect(guard("noc", { exact: "ne-string", multiword: null, assonance: 42 })).toMatchObject({
      exact: [],
      multiword: [],
      assonance: [],
    });
  });

  it("vyhodí vymyšlené tříznenné tvary i z assonance", () => {
    // NAMĚŘENO ŽIVĚ 2026-10-05 ke „sen“: assonance vyšlo
    // ben, fen, gen, hen, ken, len, men, nen. Osm vymyšlenin, žádný český tvar.
    const result = guard("sen", {
      exact: [],
      multiword: [],
      assonance: ["ben", "fen", "gen", "hen", "ken", "len", "men", "nen", "kamen", "ven"],
    });
    expect(result.assonance).toEqual(["kamen", "ven"]);
    expect(result.rejected).toEqual(
      expect.arrayContaining(["ben", "fen", "gen", "hen", "ken", "len", "men", "nen"]),
    );
  });

  it("nechá dobrý výsledek beze změny a nežádá o opakování", () => {
    const result = guard("smůlu", {
      exact: ["nulu", "školu", "dolu", "polu"],
      multiword: ["do důlu", "u stolu", "na půlu"],
      assonance: ["bulu", "muru"],
    });
    expect(result.exact).toEqual(["nulu", "školu", "dolu", "polu"]);
    expect(result.multiword).toEqual(["do důlu", "u stolu", "na půlu"]);
    expect(result.assonance).toEqual(["bulu", "muru"]);
    expect(result.rejected).toEqual([]);
    expect(shouldRetry(result)).toBe(false);
  });
});

describe("skupinová rýma nesmí být fráze", () => {
  it("odmítne výplň typu „to je moc“", () => {
    // NAMĚŘENO ŽIVĚ: k „noc“ model vracel „to je moc“, „je to moc“,
    // „to je opravdu moc“, „to je vážně moc“… Všechny končí na „moc“ a
    // fonologicky projdou, ale uživateli nedávají nic.
    const result = guard("noc", {
      exact: [],
      multiword: ["to je moc", "je to moc", "to je opravdu moc", "velká moc", "pro moc"],
      assonance: [],
    });
    expect(result.multiword).toEqual(["velká moc", "pro moc"]);
  });

  it("odmítne skupinu delší než 3 slova", () => {
    const result = guard("noc", {
      exact: [],
      multiword: ["to je opravdu moc", "silná neuvěřitelná moc moc", "krátký den"],
      assonance: [],
    });
    // „krátký den“ je rýma k „sen“, ne k „noc“ — koncovka to odmítne.
    // „silná neuvěřitelná moc moc“ má 4 slova — odmítne ji délka.
    expect(result.multiword).toEqual([]);
    // Tři slova projdou.
    expect(guard("noc", { exact: [], multiword: ["silná neuvěřitelná moc"], assonance: [] }).multiword)
      .toEqual(["silná neuvěřitelná moc"]);
  });

  it("nechá jen dvě varianty na stejné poslední slovo", () => {
    // NAMĚŘENO ŽIVĚ: dvanáct „X moc“ položek, všechy rýmují totéž.
    const result = guard("noc", {
      exact: [],
      multiword: ["velká moc", "silná moc", "božská moc", "lidská moc", "vojenská moc"],
      assonance: [],
    });
    expect(result.multiword).toEqual(["velká moc", "silná moc"]);
  });
});

describe("záchrana přesné rýmy zakopané ve frázi", () => {
  it("vytáhne „moc“ z „velká moc“, když exact přišlo prázdné", () => {
    // NAMĚŘENO ŽIVĚ: model odložil správné rýmy do multiword a exact nechal
    // prázdné. Bez toho by uživatel hledal rýmy k „noc“ a „moc“ by nedostal.
    const guarded = guard("noc", {
      exact: [],
      multiword: ["velká moc", "silná moc", "božská moc"],
      assonance: ["oko"],
    });
    expect(guarded.exact).toEqual([]);
    const promoted = promoteExactFromMultiword(guarded, { queryWord: "noc", queryTail: "oc" });
    expect(promoted.exact).toEqual(["moc"]);
  });

  it("nic nevymyslí, když poslední slovo kontrolou neprojde", () => {
    const guarded = guard("srdce", {
      exact: [],
      multiword: ["v lese", "v době"],
      assonance: [],
    });
    const promoted = promoteExactFromMultiword(guarded, { queryWord: "srdce", queryTail: "ce" });
    expect(promoted.exact).toEqual([]);
  });

  it("nesahá do výsledku, když už přesné rýmy jsou", () => {
    const guarded = guard("noc", { exact: ["moc"], multiword: ["velká moc"], assonance: [] });
    expect(promoteExactFromMultiword(guarded, { queryWord: "noc", queryTail: "oc" })).toBe(guarded);
  });
});

describe(" kdy se ptát znovu", () => {
  it("ano, když přesné rýmy vyšly prázdné", () => {
    expect(shouldRetry({ exact: [], multiword: ["v řece"], assonance: [], rejected: [] })).toBe(true);
  });

  it("ano, když něco bylo vyhozeno", () => {
    expect(shouldRetry({ exact: ["ven"], multiword: [], assonance: [], rejected: ["pen"] })).toBe(true);
  });

  it("ano, i na čistě prázdný výsledek, ale nejvýš jednou", () => {
    // Pojistka: model mohl prostě nic nevrátit. Zkouší se to JEDNOU se
    // zpřesněným promptem, ne smyčkově — nejhorší případ jsou dva pokusy
    // po ~60 s, což je pod naměřeným stropem edge funkce ~150 s.
    expect(shouldRetry({ exact: [], multiword: [], assonance: [], rejected: [] })).toBe(true);
  });
});

// Živý výstup 2026-10-05 (2. kolo sweep) odhalil dvě mezery v tom, co kontrola
// chytá. Obě jsou tady zamčené proti návratu.
describe(" vymyšleniny, kterým se podařilo projít", () => {
  it("vyhazuje tříznenné CCV shluky — assonance ke „sen“ bylo jich pět z osmi", () => {
    // Živě: ["mle", "bole", "kre", "sně", "hle", "vě", "zne", "nje"].
    const guarded = guard("sen", {
      exact: ["den", "jen", "ten", "ven"],
      assonance: ["mle", "bole", "kre", "sně", "hle", "vě", "zne", "nje"],
    });
    expect(guarded.assonance).toEqual(["bole", "vě"]);
    expect(guarded.rejected).toContain("mle");
    expect(guarded.rejected).toContain("nje");
  });

  it("nechává projít skutečná česká CCV slova", () => {
    // Kontrola nesmí být tak široká, že vyhodí „pro“ nebo „zda“ — to jsou
    // běžná slova a v assonance patří.
    // Slova jsou vybrána tak, aby se mezi nimi žádné dvě neopakovaly hláskovou
    // dvojicí — jinak by je zahodil strop ASSONANCE_PER_ENDING a test by měřil
    // něco jiného, než že filtrace tvaru NEZABIJÍ na běžných slovech.
    const guarded = guard("sen", {
      assonance: ["pro", "sta", "vra", "kdo", "jde", "zda"],
    });
    expect(guarded.assonance).toEqual(["pro", "sta", "vra", "kdo", "jde", "zda"]);
    expect(guard("sen", { assonance: ["zda", "zde"] }).assonance).toEqual(["zda", "zde"]);
  });

  it("vyhazuje slovní spojení, které v češtině nevyslovíme — živě „dvojce“", () => {
    // Živě ke „srdce“ přišlo „dvojce“: fonologicky sedí na „-ce“, ale skupina
    // „jc“ v češtině neexistuje.
    const guarded = guard("srdce", {
exact: ["konce", "dvojce", "svíce", "prince", "řece", "práce", "síce"],
    });
    expect(guarded.exact).toEqual(["konce", "svíce", "prince", "řece", "práce", "síce"]);
    expect(guarded.rejected).toContain("dvojce");
  });

  it("vyhazuje samohlásku plus koncovku — živě deset kusů ke „srdce“", () => {
    // Živě ke „srdce“ (koncovka „ce“) model vrátil přesně tohle a ani jedno není
    // české slovo: jsou to vždycky jen samohláska navěšená na „-ce“.
    const filler = ["ace", "ece", "ice", "oce", "uce", "áce", "éce", "íce", "óce", "úce"];
    const guarded = guard("srdce", { exact: [...filler, "konce", "svíce", "prince"] });
    expect(guarded.exact).toEqual(["konce", "svíce", "prince"]);
    expect(guarded.rejected).toEqual(filler);
  });

  it("nesahá na skutečná slova, která začínají samohláskou", () => {
    // Kontrola nesmí říznout „práce“ nebo „lásce“ jen proto, že začínají na
    // samohlásku — podmínka je navíc přesná shoda posledních dvou znaků.
    const guarded = guard("srdce", { exact: ["práce", "lásce", "více", "síce", "tance"] });
    expect(guarded.exact).toEqual(["práce", "lásce", "více", "síce", "tance"]);
  });
});