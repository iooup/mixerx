import en from "../locales/en.json";

export type TranslationParams = Record<string, string | number>;

type Dictionary = Record<string, string>;
const dictionary: Dictionary = { ...en };

/** Adds a lazily loaded dictionary (the Stage chunk brings its own strings). */
export function extendDictionaries(extra: Dictionary): void {
  Object.assign(dictionary, extra);
}

/** CLDR plural categories. English uses two of them. */
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

let pluralRules: Intl.PluralRules | undefined;

function pluralCategory(count: number): PluralCategory {
  pluralRules ??= new Intl.PluralRules("en");
  return pluralRules.select(count) as PluralCategory;
}

/** The parameters that carry a countable quantity, in the order they are tried. */
const COUNT_PARAMS = ["count", "n", "bars", "beats"] as const;

/**
 * Looks up a key, falling back to the key itself.
 *
 * When the parameters carry a count and the dictionary has plural forms for that key
 * (`key.one`, `key.other` per CLDR), the form for that count wins — so the interface never
 * says "in 1 bars".
 */
export function t(key: string, params?: TranslationParams): string {
  let template = dictionary[key] ?? key;
  if (!params) return template;
  const countKey = COUNT_PARAMS.find((name) => typeof params[name] === "number");
  if (countKey !== undefined) {
    const count = params[countKey] as number;
    const plural = dictionary[`${key}.${pluralCategory(count)}`] ?? dictionary[`${key}.other`];
    if (plural !== undefined) template = plural;
  }
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** `key.one` counts as a plural form of `key`, not a key in its own right. */
const baseKey = (key: string): string => {
  const dot = key.lastIndexOf(".");
  const tail = dot < 0 ? "" : key.slice(dot + 1);
  return (PLURAL_CATEGORIES as readonly string[]).includes(tail) ? key.slice(0, dot) : key;
};

/** Plural forms whose base key is missing; the list must be empty. */
export function orphanPluralForms(): string[] {
  const keys = new Set(Object.keys(dictionary));
  return [...keys].filter((key) => baseKey(key) !== key && !keys.has(baseKey(key)));
}
