import { ArrowRight, ChevronDown, TriangleAlert } from 'lucide-react';
import type { ProcessingIssue } from '../../core/types';

export interface IssuesListProps {
  issues: readonly ProcessingIssue[];
  language: 'en' | 'zh';
  onLocate: (distanceM: number) => void;
}

const km = (meters: number) => (meters / 1000).toLocaleString('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export default function IssuesList({ issues, language, onLocate }: IssuesListProps) {
  if (!issues.length) return null;
  const zh = language === 'zh';
  return <details className="issues-list" open={issues.some(issue => issue.severity === 'error')}>
    <summary>
      <TriangleAlert size={15} />{issues.length} {zh ? '条处理提示' : 'processing notes'}<ChevronDown size={14} />
    </summary>
    {issues.map((issue, index) => <div key={index} className={'issue ' + issue.severity}>
      <span className="issue-dot" />
      <div>
        <strong>{issue.code}</strong>
        <p>{zh ? issue.messageZh ?? issue.message : issue.message}</p>
        {issue.s !== undefined && <button className="text-button" onClick={() => onLocate(issue.s!)}>
          {zh ? '查看' : 'Show at'} {km(issue.s)} km<ArrowRight size={12} />
        </button>}
      </div>
    </div>)}
  </details>;
}
