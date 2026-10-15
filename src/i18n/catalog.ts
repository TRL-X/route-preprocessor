import { createInstance } from 'i18next';

export interface LocaleBundle {
  label: string;
  direction: 'ltr' | 'rtl';
  messages: Record<string, string>;
}

export const FALLBACK_LANGUAGE = 'en';
export const LANGUAGE_STORAGE_KEY = 'trl-x.language';

/** Prefer exact locale matches, then language-only matches, in preference order. */
export function resolveLanguage(preferences: readonly string[], supported: readonly string[]): string {
  for (const preference of preferences) {
    const normalized = preference.replace(/_/g, '-').toLowerCase();
    const exact = supported.find(code => code.toLowerCase() === normalized);
    if (exact) return exact;
    const parts = normalized.split('-');
    while (parts.length > 1) {
      parts.pop();
      const parent = supported.find(code => code.toLowerCase() === parts.join('-'));
      if (parent) return parent;
    }
  }
  return FALLBACK_LANGUAGE;
}

export function createLocaleInstance(bundles: Record<string, LocaleBundle>, preferences: readonly string[]) {
  const instance = createInstance();
  void instance.init({
    resources: Object.fromEntries(Object.entries(bundles).map(([code, bundle]) => [code, { translation: bundle.messages }])),
    lng: resolveLanguage(preferences, Object.keys(bundles)),
    supportedLngs: Object.keys(bundles),
    fallbackLng: FALLBACK_LANGUAGE,
    keySeparator: false,
    initAsync: false,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false }, // React escapes text; translations never contain HTML.
  });
  return instance;
}
