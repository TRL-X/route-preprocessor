import { useTranslation } from 'react-i18next';
import type { ProcessingIssue } from '../core/types';
import { diagnosticText, diagnosticTitle } from './diagnostics';
import type en from './locales/en.json';

export function useLocale() {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? i18n.language;
  const number = (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(language, options).format(value);
  const km = (meters: number) => number(meters / 1000, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const message = (issue: Pick<ProcessingIssue, 'code' | 'params' | 'message'>) => diagnosticText(i18n, issue);
  const uiText = (keyOrText: string) => i18n.exists(keyOrText) ? String(t(keyOrText as keyof typeof en.messages)) : keyOrText;
  return { t, language, number, km, message, issueTitle: (code: string) => diagnosticTitle(i18n, code), uiText, changeLanguage: (code: string) => i18n.changeLanguage(code) };
}
