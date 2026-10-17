/************************************************************
 * DJ DIKKAT - Music Bot
 * i18n
 * Message catalogs (en.json is the source, every other file
 * must have the same keys) and the t() lookup.
 * Author: Yanoee
 ************************************************************/
import en from './en.json' with { type: 'json' };
import tr from './tr.json' with { type: 'json' };

export const LOCALES = ['en', 'tr'] as const;
export type Locale = typeof LOCALES[number];
export type Vars = Record<string, string | number>;

type CatalogKey = keyof typeof en;
/** A message key; plural keys are looked up without their _one/_other suffix. */
export type MessageKey = CatalogKey extends infer K
  ? K extends `${infer Base}_${'one' | 'other'}` ? Base : K
  : never;

const catalogs: Record<Locale, Record<string, string>> = { en, tr };
const reportedMissing = new Set<string>();

export const isLocale = (value: unknown): value is Locale => LOCALES.includes(value as Locale);

/** Discord locale code ("tr", "en-US", …) → one of ours; English when we don't speak it. */
export function toLocale(discordLocale: string | null | undefined): Locale {
  const base = discordLocale?.toLowerCase().split('-')[0];
  return isLocale(base) ? base : 'en';
}

function lookup(locale: Locale, key: string): string | undefined {
  const text = catalogs[locale][key] ?? catalogs.en[key];
  if (text === undefined && !reportedMissing.has(key)) {
    reportedMissing.add(key);
    console.warn(`[I18N] missing message key "${key}"`);
  }
  return text;
}

export function t(locale: Locale, key: MessageKey, vars: Vars = {}): string {
  const count = vars.count;
  const text = typeof count === 'number'
    ? lookup(locale, `${key}_${count === 1 ? 'one' : 'other'}`) ?? lookup(locale, key)
    : lookup(locale, key);
  return (text ?? key).replace(/\{(\w+)\}/g, (match, name: string) => name in vars ? String(vars[name]) : match);
}

/** Translations of one key for every non-English locale, in Discord's localization-map shape. */
export function localizations(key: MessageKey): Partial<Record<'tr', string>> {
  return { tr: t('tr', key) };
}
