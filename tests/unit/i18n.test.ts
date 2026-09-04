import { describe, expect, it } from "vitest";
import { extendDictionaries, orphanPluralForms, t } from "../../src/app/i18n-core";
import { routeFromPath } from "../../src/app/router";
import extraEn from "../../src/locales/console-extra.en.json";
import en from "../../src/locales/en.json";
import stageEn from "../../src/locales/stage.en.json";

describe("i18n", () => {
  it("merges the lazily loaded dictionaries and leaves no orphan plural form", () => {
    // Each lazily loaded chunk brings its own strings: the Stage's, and the console's extras
    // (command palette, recap, badges, MIDI), which no longer ride in the console entry.
    expect(t("stage.director")).toBe("stage.director");
    expect(t("palette.title")).toBe("palette.title");
    extendDictionaries(stageEn);
    extendDictionaries(extraEn);
    expect(t("stage.director")).toBe("Director");
    expect(t("palette.title")).toBe("Command palette");
    expect(orphanPluralForms()).toEqual([]);
  });

  it("translates with parameters and falls back to the key", () => {
    expect(t("onair.a")).toBe("On air: A");
    expect(t("onair.crossfader", { a: 60, b: 40 })).toBe("Crossfader 60% A · 40% B");
    expect(t("onair.crossfader", { a: 60 })).toBe("Crossfader 60% A · {b}% B");
    expect(t("missing.key")).toBe("missing.key");
  });

  it("uses the right plural form, so it never says '1 bars'", () => {
    expect(t("deck.sectionIn", { section: "Drop", bars: 1 })).toBe("Drop in 1 bar");
    expect(t("deck.sectionIn", { section: "Drop", bars: 8 })).toBe("Drop in 8 bars");
    expect(t("onair.enterIn", { deck: "B", n: 1 })).toBe("B enters in 1 beat");
    expect(t("onair.enterIn", { deck: "B", n: 3 })).toBe("B enters in 3 beats");
    expect(t("library.tracks", { count: 0 })).toBe("0 tracks");
    expect(t("library.tracks", { count: 1 })).toBe("1 track");
    // A key with no plural forms keeps its single template whatever the count is.
    expect(t("guide.step", { n: 1, total: 10 })).toBe("Step 1 of 10");
    expect(t("guide.step", { n: 3, total: 10 })).toBe("Step 3 of 10");
  });

  it("ships no Arabic script or Arabic-Indic digits in any dictionary", () => {
    // The interface is English-only; this is the gate that keeps a stray string from creeping back.
    const arabic = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/;
    for (const dictionary of [en, extraEn, stageEn] as Record<string, string>[])
      for (const [key, value] of Object.entries(dictionary)) expect(value, key).not.toMatch(arabic);
  });
});

describe("router", () => {
  it("maps paths to routes", () => {
    expect(routeFromPath("/")).toBe("console");
    expect(routeFromPath("/stage")).toBe("stage");
    expect(routeFromPath("/stage/")).toBe("stage");
    expect(routeFromPath("/anything")).toBe("console");
  });
});
