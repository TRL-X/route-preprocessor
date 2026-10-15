import { describe, expect, it } from 'vitest';
import { createLocaleInstance, resolveLanguage, type LocaleBundle } from '../../src/i18n/catalog';
import en from '../../src/i18n/locales/en.json';
import zh from '../../src/i18n/locales/zh.json';

const bundles = import.meta.glob<LocaleBundle>('../../src/i18n/locales/*.json', { eager: true, import: 'default' });
const resources = Object.fromEntries(Object.entries(bundles).map(([path, bundle]) => [path.split('/').at(-1)!.replace(/\.json$/, ''), bundle]));
const placeholders = (text: string) => [...text.matchAll(/{{\s*([^},\s]+)/g)].map(match => match[1]).sort();

describe('language resources', () => {
  it('keeps interpolation parameters consistent across every discovered locale', () => {
    for (const bundle of Object.values(bundles)) {
      expect(bundle.label.trim()).not.toBe('');
      expect(['ltr', 'rtl']).toContain(bundle.direction);
      for (const [key, value] of Object.entries(bundle.messages)) {
        // Languages may need plural categories absent in English (two, few, many…).
        const base = key.replace(/_(zero|one|two|few|many|other)$/, '');
        const reference = (en.messages as Record<string, string>)[key] ?? (en.messages as Record<string, string>)[`${base}_other`];
        expect(reference, key).toBeDefined();
        expect(value.trim(), key).not.toBe('');
        expect(placeholders(value), key).toEqual(placeholders(reference));
      }
    }
  });

  it('resolves stored and browser preferences, regional variants, and fallback', () => {
    expect(resolveLanguage(['zh-CN', 'en-US'], ['en', 'zh'])).toBe('zh');
    expect(resolveLanguage(['pt-BR', 'fr-CA', 'en-US'], ['en', 'fr'])).toBe('fr');
    expect(resolveLanguage(['EN_us'], ['en', 'zh'])).toBe('en');
    expect(resolveLanguage(['zh-Hant'], ['en', 'zh', 'zh-Hant'])).toBe('zh-Hant');
    expect(resolveLanguage(['zh-Hant-TW'], ['en', 'zh', 'zh-Hant'])).toBe('zh-Hant');
    expect(resolveLanguage(['not-installed', 'zh-TW'], ['en', 'zh'])).toBe('zh');
    expect(resolveLanguage(['ja'], ['en', 'zh'])).toBe('en');
  });

  it('selects singular and plural messages and interpolates diagnostics', async () => {
    const instance = createLocaleInstance(resources, ['en-US']);
    expect(instance.t('common.stationCount', { count: 1 })).toBe('1 station');
    expect(instance.t('common.stationCount', { count: 2 })).toBe('2 stations');
    expect(instance.t('issues.STATION_UNCONFIRMED', { name: 'CP <north>' })).toContain('CP <north>');
    await instance.changeLanguage('zh');
    expect(instance.t('common.stationCount', { count: 1 })).toBe('1 个站点');
    expect(instance.t('issues.STATION_UNCONFIRMED', { name: 'CP <north>' })).toBe('请确认“CP <north>”对应的经过位置。');
    expect(instance.t('app.routeName')).toBe(zh.messages['app.routeName']);
  });

  it('supports a third language and missing-message fallback without UI branches', () => {
    const instance = createLocaleInstance({
      ...resources,
      fr: { label: 'Français', direction: 'ltr', messages: { 'app.routeName': 'Nom du parcours' } },
    }, ['fr-CA']);
    expect(instance.resolvedLanguage).toBe('fr');
    expect(instance.t('app.routeName')).toBe('Nom du parcours');
    expect(instance.t('app.chooseRouteFile')).toBe(en.messages['app.chooseRouteFile']);
  });
});
