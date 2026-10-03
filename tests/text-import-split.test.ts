import { describe, expect, it } from "vitest";

import { splitImportedSongContent, stripStyleMeta } from "../lib/text-import";

/**
 * Při importu se text písně dostával do promptu stylu: rozdělení bralo první
 * odstavec a nic neověřilo. U „Náhody“ měl prompt stylu 2 000 znaků včetně
 * pěti slok a dvou refrénů, u „Bylé můj nejlepší přítel“ obsahoval sekci
 * „Text písně:“ s celým textem.
 */
describe("rozdělení importu na styl a text", () => {
  it("rozdělí soubor se stylem na jednom řádku a značkou sloky", () => {
    const source = [
      "Style: Underground Czech rap, heavy 808s, fast flow",
      "(Sloka 1)",
      "Ráno oči otevírám, budík zvoní,",
      "někdo prudí, že prej něco vidí.",
      "(Refrén)",
      "Nikdo nepochopí, jaký je mezi námi žít.",
    ].join("\n");
    const result = splitImportedSongContent(source);
    expect(result.stylePrompt).toBe("Underground Czech rap, heavy 808s, fast flow");
    expect(result.lyrics).toContain("Ráno oči otevírám");
    expect(result.lyrics).toContain("[Refrén]");
    expect(result.stylePrompt).not.toContain("budík zvoní");
  });

  it("text písně se do stylu nedostane ani při dlouhém textu bez prázdných řádků", () => {
    const lines = ["Style: Dark cinematic trap, 140 BPM"];
    for (let i = 1; i <= 5; i += 1) {
      lines.push(`(Sloka ${i})`, `Rádek textu číslo ${i}, druhý věteč na stejném odstavci.`);
    }
    const result = splitImportedSongContent(lines.join("\n"));
    expect(result.stylePrompt).toBe("Dark cinematic trap, 140 BPM");
    for (let i = 1; i <= 5; i += 1) expect(result.lyrics).toContain(`Rádek textu číslo ${i}`);
    expect(result.stylePrompt?.length ?? 0).toBeLessThan(80);
  });

  it("soubor, který začíná rovnou písní, nemá prompt stylu", () => {
    const result = splitImportedSongContent(["[Intro]", "Ticho v hlavě, i když město ještě žije."].join("\n"));
    expect(result.stylePrompt).toBeNull();
    expect(result.lyrics).toContain("Ticho v hlavě");
  });

  it("hází hlavičky, které do stylu nepatří", () => {
    expect(stripStyleMeta("### Prompt pro AI\nDark trap, 90 BPM")).toBe("Dark trap, 90 BPM");
    expect(stripStyleMeta("(Popis stylu pro AI generátor)\nBoom bap, klidný beat")).toBe("Boom bap, klidný beat");
    expect(stripStyleMeta("=== POPIS STYLU ===\nCinematic, temný")).toBe("Cinematic, temný");
    expect(stripStyleMeta("[Style Prompt]\nTrap, 808")).toBe("Trap, 808");
    expect(stripStyleMeta("Stylový prompt: Trap, 808")).toBe("Trap, 808");
    expect(stripStyleMeta("Style: Trap, 808")).toBe("Trap, 808");
  });

  it("nechá slovo Intro uvnitř promptu stylu být", () => {
    // Kdyby stačilo „obsahuje Intro“, popis stylu by se rozpadl napůl.
    const source = ["Style: Instrumental with a long intro passage, ambient textures", "[Verse]", "První verš."].join("\n");
    const result = splitImportedSongContent(source);
    expect(result.stylePrompt).toContain("intro passage");
    expect(result.lyrics).toContain("První verš.");
  });

  it("markdown nadpis názvu není značka sloky", () => {
    const source = ["Style: Boom bap, syrový text o noci.", "## **Syn Stínu**", "[Intro]", "První řádek."].join("\n");
    const result = splitImportedSongContent(source);
    expect(result.stylePrompt).toBe("Boom bap, syrový text o noci.");
    expect(result.lyrics).toContain("Syn Stínu");
    expect(result.lyrics).toContain("[Intro]");
  });

  it("závorková značka (Sloka 1) se přepíše na hranaté", () => {
    const result = splitImportedSongContent(["Style: Trap", "(Sloka 1)", "První věta.", "(Refrén)", " refrain."].join("\n"));
    expect(result.lyrics).toContain("[Sloka 1]");
    expect(result.lyrics).toContain("[Refrén]");
    expect(result.lyrics).not.toContain("(Refrén)");
  });

  it("zvládne značky s poznámkou i bez závorky", () => {
    const source = ["Style: Trap", "Sloka 1 — přibližně 0:21–0:46", "Smrad a síra, černá díra."].join("\n");
    const result = splitImportedSongContent(source);
    expect(result.stylePrompt).toBe("Trap");
    expect(result.lyrics).toContain("Smrad a síra");
  });
});
