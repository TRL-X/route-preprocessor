import { useTranslation } from 'react-i18next';
import type { ProcessingIssue } from '../core/types';
import type en from './locales/en.json';

export function useLocale() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(language, options).format(value);
  const km = (meters: number) => number(meters / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const message = (issue: Pick<ProcessingIssue, 'code' | 'params' | 'message'>) => {
    // Older drafts stored rendered diagnostics without interpolation parameters.
    if (issue.params === undefined && issue.message) return issue.message;
    const key = `issues.${issue.code}` as keyof typeof en.messages;
    return i18n.exists(key) ? String(t(key, { ...issue.params, defaultValue: issue.message ?? issue.code })) : issue.message ?? issue.code;
  };
  const uiText = (keyOrText: string) => i18n.exists(keyOrText) ? String(t(keyOrText as keyof typeof en.messages)) : keyOrText;
  return { t, language, number, km, message, uiText, changeLanguage: (code: string) => i18n.changeLanguage(code) };
}
