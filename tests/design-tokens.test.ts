import { describe, expect, it } from "vitest";

import { OnPrimary, Radius, Space, Type } from "../lib/design-tokens";
import { themeColors } from "../theme.config";

describe("design tokeny", () => {
  it("OnPrimary odpovida themeColors.onPrimary", () => {
    expect(OnPrimary).toBe(themeColors.onPrimary.dark);
    expect(OnPrimary).toBe(themeColors.onPrimary.light);
  });

  it("aplikace je vzdy tmava - light a dark se nesmi rozejit", () => {
    Object.entries(themeColors).forEach(([token, swatch]) => {
      expect(`${token}:${swatch.light}`).toBe(`${token}:${swatch.dark}`);
    });
  });

  it("vsechny tokeny maji tvar #RRGGBB nebo rgba()", () => {
    Object.values(themeColors).forEach((swatch) => {
      expect(swatch.dark).toMatch(/^(#[0-9a-fA-F]{6}|rgba?\(\d+,\d+,\d+,(0|1|0?\.\d+)\))$/);
    });
  });

  it("polomery jsou male a spojite", () => {
    const values = [Radius.sm, Radius.md, Radius.lg, Radius.xl];
    values.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(8);
      expect(v).toBeLessThanOrEqual(32);
    });
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("rozestupy jsou spojite po 4", () => {
    const values = Object.values(Space);
    values.forEach((v) => expect(v % 4).toBe(0));
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("typografie ma spojitou skalgu a klesajici tihu", () => {
    const order = [Type.display, Type.title, Type.heading, Type.body, Type.label, Type.caption];
    for (let i = 1; i < order.length; i++) {
      expect(order[i].fontSize).toBeLessThan(order[i - 1].fontSize);
      expect(order[i].lineHeight).toBeGreaterThan(order[i].fontSize);
    }
  });

  it("primarni barva neni fialova", () => {
    const { r, g, b } = hexToRgb(themeColors.primary.dark);
    // Fialova = vysoka modra A vysoka cervena, nizska zelena.
    // Azurova = nizka cervena, vysoka zelena i modra.
    expect(r).toBeLessThan(100);
    expect(g).toBeGreaterThan(120);
    expect(b).toBeGreaterThan(120);
  });

  it("hlavni plochy jsou opravdu tmavé", () => {
    ["background", "surface", "surfaceElevated"].forEach((token) => {
      const { r, g, b } = hexToRgb(themeColors[token as keyof typeof themeColors].dark);
      expect(r).toBeLessThan(32);
      expect(g).toBeLessThan(40);
      expect(b).toBeLessThan(50);
    });
  });

  it("text ma dostatecny kontrast vuzemi", () => {
    const luminance = (hex: string) => {
      const { r, g, b } = hexToRgb(hex);
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const bg = luminance(themeColors.background.dark);
    [
      themeColors.foreground.dark,
      themeColors.foregroundMuted.dark,
      themeColors.muted.dark,
      themeColors.primary.dark,
      themeColors.secondary.dark,
    ].forEach((hex) => {
      const ratio = (luminance(hex) + 0.05) / (bg + 0.05);
      expect(ratio).toBeGreaterThan(3);
    });
  });
});

function hexToRgb(hex: string) {
  const v = hex.replace("#", "");
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}