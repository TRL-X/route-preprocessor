import type { i18n } from 'i18next';
import type { DiagnosticMessage } from '../core/types';
import en from './locales/en.json';

/** Old drafts contain rendered English diagnostics instead of parameters. */
export function diagnosticText(instance: i18n, issue: DiagnosticMessage): string {
  const key = `issues.${issue.code}` as keyof typeof en.messages;
  const template = en.messages[key];
  if (!template) return issue.message ?? issue.code;
  const params = { ...issue.params };
  const legacy = issue.message ?? '';
  const count = legacy.match(/\bCount:\s*([\d,]+)/i);
  const limit = legacy.match(/\b(?:at most|up to)\s+([\d,]+)\s*m\b/i);
  const name = legacy.match(/\(([^()]*)\)\s*$/);
  if (params.count === undefined && count) params.count = Number(count[1].replaceAll(',', ''));
  if (params.limit === undefined && limit) params.limit = Number(limit[1].replaceAll(',', ''));
  if (params.name === undefined && name) params.name = name[1];
  const required = [...template.matchAll(/{{\s*([^},\s]+)/g)].map(match => match[1]);
  // Do not invent missing values or show untranslated text for a known issue.
  const translatedKey = required.every(parameter => params[parameter] !== undefined)
    ? key : `issues.title.${issue.code}` as keyof typeof en.messages;
  return String(instance.t(translatedKey, params));
}

export function diagnosticTitle(instance: i18n, code: string): string {
  const key = `issues.title.${code}` as keyof typeof en.messages;
  return instance.exists(key) ? String(instance.t(key)) : String(instance.t('issues.unknownTitle'));
}
