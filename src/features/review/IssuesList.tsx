import { useLocale } from '../../i18n/useLocale';
import { ArrowRight, ChevronDown, TriangleAlert } from 'lucide-react';
import type { ProcessingIssue } from '../../core/types';

export interface IssuesListProps {
  issues: readonly ProcessingIssue[];
  onLocate: (distanceM: number) => void;
}


export default function IssuesList({ issues, onLocate }: IssuesListProps) {
  const { t, km, message } = useLocale();
  if (!issues.length) return null;
  return <details className="issues-list" open={issues.some(issue => issue.severity === 'error')}>
    <summary>
      <TriangleAlert size={15} />{t('issues.noteCount', { count: issues.length })}<ChevronDown size={14} />
    </summary>
    {issues.map((issue, index) => <div key={index} className={'issue ' + issue.severity}>
      <span className="issue-dot" />
      <div>
        <strong>{issue.code}</strong>
        <p>{message(issue)}</p>
        {issue.s !== undefined && <button className="text-button" onClick={() => onLocate(issue.s!)}>
          {t('issues.showAtDistance', { distance: km(issue.s) })}<ArrowRight size={12} />
        </button>}
      </div>
    </div>)}
  </details>;
}
