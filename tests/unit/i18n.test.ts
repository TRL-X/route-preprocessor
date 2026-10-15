import { describe, expect, it } from 'vitest';
import { createLocaleInstance, resolveLanguage, type LocaleBundle } from '../../src/i18n/catalog';
import { diagnosticText } from '../../src/i18n/diagnostics';
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

  it('translates legacy draft diagnostics and recovers their counts when switching languages', async () => {
    const instance = createLocaleInstance(resources, ['zh']);
    const legacy = { code: 'DUPLICATE_COORDINATES', message: 'Consecutive duplicate coordinates were merged without changing traversal order. Count: 5.' };
    expect(diagnosticText(instance, legacy)).toBe('已合并 5 个连续重复坐标，保留经过顺序。');
    expect(diagnosticText(instance, { code: 'ELEVATION_CONFLICT', message: 'Conflicting elevations at repeated coordinates are marked missing. Count: 1.' })).toContain('1 处重复坐标');
    expect(diagnosticText(instance, { code: 'ELEVATION_MISSING', message: 'Some route points have no elevation. Count: 8.' })).toBe('8 个有效路线点缺少高程。');
    expect(diagnosticText(instance, { code: 'INCOMPLETE_ELEVATION', message: 'Only interior gaps of at most 100 m can be filled.' })).toContain('100 米');
    await instance.changeLanguage('en');
    expect(diagnosticText(instance, legacy)).toContain('Count: 5.');
  });

  it('uses localized summaries for missing legacy parameters and keeps unknown diagnostics readable', () => {
    const instance = createLocaleInstance(resources, ['zh']);
    expect(diagnosticText(instance, { code: 'ELEVATION_MISSING', message: 'An older unrecognized message.' })).toBe('缺少高程');
    expect(diagnosticText(instance, { code: 'ROUTE_TOO_SHORT', message: 'The route is too short.' })).toBe(zh.messages['issues.ROUTE_TOO_SHORT']);
    expect(diagnosticText(instance, { code: 'ELEVATION_MISSING', params: { count: 0 }, message: 'Count: 8.' })).toBe('0 个有效路线点缺少高程。');
    expect(diagnosticText(instance, { code: 'OTHER', message: 'Additional diagnostic' })).toBe('Additional diagnostic');
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
