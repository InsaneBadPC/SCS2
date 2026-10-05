import { describe, expect, it } from "vitest";

import {
  czechWordSet,
  filterRealCzechRhymes,
  isCzechWord,
  isRealCzechPhrase,
} from "../supabase/functions/_shared/czech-dictionary";

describe("český slovník (validace rýmů)", () => {
  it("obsahuje běžná česká slova", () => {
    for (const word of ["noc", "sen", "srdce", "moc", "více", "den"]) {
      expect(isCzechWord(word), word).toBe(true);
    }
  });

  it("zachovává diakritiku — složený index by kolidoval", () => {
    // `zřece` je vymyšlenina, ale `žreče` je reálné slovo:
    // obě se složí na „zrece“, takže se diakritika NESMÁZAT.
    expect(isCzechWord("zřece")).toBe(false);
    expect(isCzechWord("žreče")).toBe(true);
  });

  it("zamítne známé vymyšleniny ke slovu srdce", () => {
    for (const pseudo of ["vřece", "zřece", "vzece", "pětce", "šestce", "sedmce", "osmce", "bludce", "tupce"]) {
      expect(isCzechWord(pseudo), pseudo).toBe(false);
    }
  });

  it("zná reálné rýmy ke srdce", () => {
    for (const word of ["ruce", "ovce", "správce", "zrádce", "dárce", "vládce", "slunce", "soudce"]) {
      expect(isCzechWord(word), word).toBe(true);
    }
  });

  it("normalizuje vstup: velká písmena a mezery", () => {
    expect(isCzechWord("  SrdCE ")).toBe(true);
  });

  it("frázi akceptuje jen když jsou všechny tokeny reálná slova", () => {
    expect(isRealCzechPhrase("na pomoc")).toBe(true);
    expect(isRealCzechPhrase("pod slunce")).toBe(true);
    expect(isRealCzechPhrase("vřece ruce")).toBe(false);
    expect(isRealCzechPhrase("")).toBe(false);
  });

  it("filtruje sady a vrací vyhozené pro zpřesněný prompt", () => {
    const { kept, dropped } = filterRealCzechRhymes(["ruce", "vřece", "ovce", "zřece"]);
    expect(kept).toEqual(["ruce", "ovce"]);
    expect(dropped).toEqual(["vřece", "zřece"]);
  });

  it("slovník je úplný a deterministický (lazy cache)", () => {
    const set = czechWordSet();
    expect(set.size).toBeGreaterThan(200_000);
    expect(czechWordSet()).toBe(set); // stejná cachovaná instance
  });
});
