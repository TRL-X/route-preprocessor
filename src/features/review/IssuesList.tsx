import { useLocale } from '../../i18n/useLocale';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import type { ProcessingIssue } from '../../core/types';

export interface IssuesListProps {
  issues: readonly ProcessingIssue[];
  onLocate: (distanceM: number) => void;
}

export default function IssuesList({ issues, onLocate }: IssuesListProps) {
  const { t, km, message, issueTitle } = useLocale();
  if (!issues.length) return null;
  return (
    <section className="issues-list" aria-label={t('issues.noteCount', { count: issues.length })}>
      <h3 className="issues-heading">
        <TriangleAlert size={15} />
        {t('issues.noteCount', { count: issues.length })}
      </h3>
      {issues.map((issue, index) => (
        <div key={index} className={'issue ' + issue.severity} data-code={issue.code}>
          <span className="issue-dot" />
          <div>
            <strong>{issueTitle(issue.code)}</strong>
            <p>{message(issue)}</p>
            {issue.s !== undefined && (
              <button className="text-button" onClick={() => onLocate(issue.s!)}>
                {t('issues.showAtDistance', { distance: km(issue.s) })}
                <ArrowRight size={12} />
              </button>
            )}
          </div>
        </div>
      ))}
    </section>
  );
}
