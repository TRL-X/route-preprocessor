import type { i18n } from 'i18next';
import type { DiagnosticMessage } from '../core/types';
import en from './locales/en.json';
import { POLICY_MESSAGE_PARAMS } from './policy';

export function diagnosticText(instance: i18n, issue: DiagnosticMessage): string {
  const key = `issues.${issue.code}` as keyof typeof en.messages;
  const template = en.messages[key];
  if (!template) return issue.message ?? issue.code;
  const params: Record<string, string | number> = { ...POLICY_MESSAGE_PARAMS, ...issue.params };
  const required = [...template.matchAll(/{{\s*([^},\s]+)/g)].map((match) => match[1]);
  // A localized summary remains useful when diagnostic details are missing.
  const translatedKey = required.every((parameter) => params[parameter] !== undefined)
    ? key
    : (`issues.title.${issue.code}` as keyof typeof en.messages);
  return String(instance.t(translatedKey, params));
}

export function diagnosticTitle(instance: i18n, code: string): string {
  const key = `issues.title.${code}` as keyof typeof en.messages;
  return instance.exists(key) ? String(instance.t(key)) : String(instance.t('issues.unknownTitle'));
}
