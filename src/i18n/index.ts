import type { LocaleBundle } from './catalog';
import { createLocaleInstance, LANGUAGE_STORAGE_KEY } from './catalog';

// A new locale file automatically becomes available in the language selector.
const files = import.meta.glob<LocaleBundle>('./locales/*.json', {
  eager: true,
  import: 'default',
});
export const localeBundles = Object.fromEntries(
  Object.entries(files).map(([path, bundle]) => [
    path
      .split('/')
      .at(-1)!
      .replace(/\.json$/, ''),
    bundle,
  ]),
);
export const availableLanguages = Object.entries(localeBundles).map(([code, bundle]) => ({
  code,
  label: bundle.label,
}));

let savedLanguage: string | null = null;
try {
  savedLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY);
} catch {
  /* Language switching also works without storage. */
}
export const i18n = createLocaleInstance(localeBundles, [
  ...(savedLanguage ? [savedLanguage] : []),
  ...navigator.languages,
]);

function applyLanguage(language: string) {
  document.documentElement.lang = language;
  document.documentElement.dir = localeBundles[language]?.direction ?? 'ltr';
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  } catch {
    /* Preferences are optional. */
  }
}
i18n.on('languageChanged', applyLanguage);
applyLanguage(i18n.resolvedLanguage ?? i18n.language);
