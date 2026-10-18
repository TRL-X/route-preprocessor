import { CheckCircle2, LoaderCircle, TriangleAlert } from 'lucide-react';
import { issueStage } from '../../app/flow';
import { PROCESSING_CHOICES } from '../../core/policy';
import type {
  ProcessingIssue,
  ProcessingOptions,
  ReferenceRoute,
  RouteData,
} from '../../core/types';
import { useLocale } from '../../i18n/useLocale';

interface Props {
  reference: ReferenceRoute;
  options: ProcessingOptions;
  issues: readonly ProcessingIssue[];
  currentResult: boolean;
  route: RouteData | null;
  compareSource: boolean;
  onOptionsChange: (patch: Partial<ProcessingOptions>) => void;
  onCompareSourceChange: (compare: boolean) => void;
}

export default function ElevationSettings({
  reference,
  options,
  issues,
  currentResult,
  route,
  compareSource,
  onOptionsChange,
  onCompareSourceChange,
}: Props) {
  const { t, number } = useLocale();
  const missing = reference.points.filter((point) => point.elevation === null).length;
  const elevationErrors = currentResult
    ? issues.filter(
        (issue) => issue.severity === 'error' && issueStage(issue, options) === 'elevation',
      )
    : [];
  let title;
  let help;
  let status: 'checking' | 'attention' | 'complete' | 'neutral' = 'attention';
  if (!currentResult) {
    title = t('app.elevationChecking');
    help = t('app.waitForProcessing');
    status = 'checking';
  } else if (missing === reference.points.length) {
    title = t('app.elevationNeedsAttention');
    help = t('app.elevationMissingSourceHelp');
  } else if (
    reference.points[0]?.elevation === null ||
    reference.points.at(-1)?.elevation === null
  ) {
    title = t('app.elevationNeedsAttention');
    help = t('app.elevationMissingEndpointsHelp');
  } else if (missing > 0 && options.elevationMode === 'source') {
    title = t('app.elevationNeedsAttention');
    help = t('app.elevationGapsHelp', { count: missing });
  } else if (reference.elevationUncertain && !options.acceptUncertainElevation) {
    title = t('app.elevationPendingConfirmation');
    help = t('app.elevationConfirmationHelp');
  } else if (elevationErrors.length > 0) {
    title = t('app.elevationNeedsAttention');
    help = t('app.resolveElevationIssues');
  } else if (route?.elevationInfo.containsFilledValues) {
    title = t('app.elevationFilled');
    help = t('app.elevationFilledHelp');
    status = 'complete';
  } else if (missing > 0) {
    title = t('app.elevationFillSelected');
    help = t('app.elevationAwaitingRouteHelp');
    status = 'neutral';
  } else {
    title = t('app.elevationComplete');
    help = t('app.elevationCompleteHelp');
    status = 'complete';
  }

  return (
    <>
      <section className={'elevation-status ' + status} role="status">
        {status === 'checking' ? (
          <LoaderCircle size={20} className="spin" />
        ) : status === 'complete' ? (
          <CheckCircle2 size={20} />
        ) : (
          <TriangleAlert size={20} />
        )}
        <div>
          <h3>{title}</h3>
          <p>{help}</p>
        </div>
      </section>
      <fieldset className="radio-cards">
        <legend>{t('app.elevationSettings')}</legend>
        {(['source', 'interpolate'] as const).map((mode, i) => (
          <label
            className={'radio-card ' + (options.elevationMode === mode ? 'selected' : '')}
            key={mode}
          >
            <input
              type="radio"
              name="elevation"
              value={mode}
              checked={options.elevationMode === mode}
              onChange={() => onOptionsChange({ elevationMode: mode })}
            />
            <span>
              <strong>{[t('app.useSourceElevation'), t('app.fillElevationGaps')][i]}</strong>
              <small>
                {[t('app.sourceElevationHelp'), t('app.interpolateElevationGapsDescription')][i]}
              </small>
            </span>
          </label>
        ))}
      </fieldset>
      <section className="elevation-advanced" aria-labelledby="elevation-advanced-title">
        <h3 id="elevation-advanced-title">{t('app.advancedElevationSettings')}</h3>
        <label className="field">
          <span id="elevation-interval-label">{t('app.samplingIntervalM')}</span>
          <select
            aria-labelledby="elevation-interval-label"
            value={options.elevationIntervalM}
            onChange={(event) =>
              onOptionsChange({ elevationIntervalM: Number(event.target.value) })
            }
          >
            {!PROCESSING_CHOICES.elevationIntervalM.some(
              (value) => value === options.elevationIntervalM,
            ) && (
              <option value={options.elevationIntervalM}>
                {number(options.elevationIntervalM)} m
              </option>
            )}
            {PROCESSING_CHOICES.elevationIntervalM.map((value) => (
              <option key={value} value={value}>
                {value} m
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span id="elevation-smoothing-label">{t('app.smoothingWindowM')}</span>
          <select
            aria-labelledby="elevation-smoothing-label"
            aria-describedby="elevation-smoothing-help"
            value={options.smoothingWindowM}
            onChange={(event) => onOptionsChange({ smoothingWindowM: Number(event.target.value) })}
          >
            {!PROCESSING_CHOICES.smoothingWindowM.some(
              (value) => value === options.smoothingWindowM,
            ) && (
              <option value={options.smoothingWindowM}>{number(options.smoothingWindowM)} m</option>
            )}
            {PROCESSING_CHOICES.smoothingWindowM.map((value) => (
              <option key={value} value={value}>
                {value === 0 ? t('app.smoothingOff') : `${value} m`}
              </option>
            ))}
          </select>
          <small id="elevation-smoothing-help">{t('app.smoothingHelp')}</small>
        </label>
        {route && (
          <label className="check-field">
            <input
              type="checkbox"
              checked={compareSource}
              onChange={(event) => onCompareSourceChange(event.target.checked)}
            />
            <span>{t('app.compareOriginalElevation')}</span>
          </label>
        )}
      </section>
    </>
  );
}
