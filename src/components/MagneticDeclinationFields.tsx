import { useEffect, useRef, useState } from 'react';
import type { MagneticDeclinationInfo, SourcePoint } from '../core/types';
import { quantize } from '../core/process';
import { useLocale } from '../i18n/useLocale';

const display = (n: number | undefined, scale: number) =>
  n !== undefined && Number.isFinite(n) ? String(n / scale) : '';

// Keep incomplete signed/decimal input while editing; quantization must not erase a typed minus sign.
function NumericField({
  label,
  value,
  scale,
  onChange,
}: {
  label: string;
  value?: number;
  scale: number;
  onChange: (value: number) => void;
}) {
  const [raw, setRaw] = useState(() => display(value, scale));
  const editing = useRef(false);
  useEffect(() => {
    if (!editing.current) setRaw(display(value, scale));
  }, [value, scale]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        value={raw}
        onFocus={() => {
          editing.current = true;
        }}
        onBlur={() => {
          editing.current = false;
          setRaw(display(value, scale));
        }}
        onChange={(event) => {
          const text = event.target.value;
          setRaw(text);
          const number = text.trim() === '' ? NaN : Number(text);
          const scaled = number * scale;
          onChange(Number.isFinite(scaled) ? quantize(scaled) : NaN);
        }}
      />
    </label>
  );
}

export default function MagneticDeclinationFields({
  value,
  reference,
  mode,
  queryDate,
  status,
  onModeChange,
  onDateChange,
  onRetry,
  onChange,
}: {
  value?: MagneticDeclinationInfo;
  reference: SourcePoint;
  mode: 'auto' | 'manual' | 'omit';
  queryDate: string;
  status: 'loading' | 'available' | 'unavailable' | null;
  onModeChange: (mode: 'auto' | 'manual' | 'omit') => void;
  onDateChange: (date: string) => void;
  onRetry: () => void;
  onChange: (value: MagneticDeclinationInfo | undefined) => void;
}) {
  const { t } = useLocale();
  const update = (patch: Partial<MagneticDeclinationInfo>) => onChange({ ...value!, ...patch });
  return (
    <details className="advanced">
      <summary>{t('app.magneticDeclination')}</summary>
      <p className="small muted">{t('app.declinationHelp')}</p>
      <label className="field">
        <span>{t('app.declinationMode')}</span>
        <select
          value={mode}
          onChange={(e) => onModeChange(e.target.value as 'auto' | 'manual' | 'omit')}
        >
          <option value="auto">{t('app.declinationAuto')}</option>
          <option value="manual">{t('app.declinationManual')}</option>
          <option value="omit">{t('app.declinationOmit')}</option>
        </select>
      </label>
      {mode === 'auto' && (
        <>
          <label className="field">
            <span>{t('app.declinationQueryDate')}</span>
            <input
              type="date"
              min="2025-01-01"
              max="2029-12-31"
              value={queryDate}
              onChange={(e) => onDateChange(e.target.value)}
            />
          </label>
          <p className="small muted" role="status">
            {t(
              status === 'available'
                ? 'app.declinationAvailable'
                : status === 'unavailable'
                  ? 'app.declinationUnavailable'
                  : 'app.declinationLoading',
            )}
            {status === 'available' && value && (
              <>
                {' '}
                {value.declinationCdeg / 100}° · {value.source} · {value.referenceDate}
              </>
            )}
          </p>
          <button
            className="button button-secondary"
            disabled={status === 'loading'}
            onClick={onRetry}
          >
            {t('app.declinationRetry')}
          </button>
        </>
      )}
      {mode === 'manual' && (
        <>
          <label className="check-field">
            <input
              type="checkbox"
              checked={value !== undefined}
              onChange={(event) => {
                const lon = quantize(reference.lon * 1e7);
                onChange(
                  event.target.checked
                    ? {
                        declinationCdeg: NaN,
                        referenceLatE7: quantize(reference.lat * 1e7),
                        referenceLonE7: lon === 1800000000 ? -1800000000 : lon,
                        referenceDate: '',
                        source: '',
                      }
                    : undefined,
                );
              }}
            />
            {t('app.includeDeclination')}
          </label>
          {value && (
            <>
              <NumericField
                label={t('app.declinationDegrees')}
                value={value.declinationCdeg}
                scale={100}
                onChange={(n) => update({ declinationCdeg: n })}
              />
              <div className="field-pair">
                <NumericField
                  label={t('app.declinationLatitude')}
                  value={value.referenceLatE7}
                  scale={10000000}
                  onChange={(n) => update({ referenceLatE7: n })}
                />
                <NumericField
                  label={t('app.declinationLongitude')}
                  value={value.referenceLonE7}
                  scale={10000000}
                  onChange={(n) => update({ referenceLonE7: n })}
                />
              </div>
              <label className="field">
                <span>{t('app.declinationDate')}</span>
                <input
                  type="date"
                  min="0001-01-01"
                  max="9999-12-31"
                  value={value.referenceDate}
                  onChange={(e) => update({ referenceDate: e.target.value })}
                />
              </label>
              <label className="field">
                <span>{t('app.declinationSource')}</span>
                <input
                  value={value.source}
                  placeholder="WMM2025"
                  onChange={(e) => update({ source: e.target.value })}
                />
              </label>
              <p className="small muted">{t('app.declinationValidityHelp')}</p>
              <div className="field-pair">
                <label className="field">
                  <span>{t('app.declinationValidFrom')}</span>
                  <input
                    type="date"
                    min="0001-01-01"
                    max="9999-12-31"
                    value={value.validFrom ?? ''}
                    onChange={(e) => update({ validFrom: e.target.value || undefined })}
                  />
                </label>
                <label className="field">
                  <span>{t('app.declinationValidUntil')}</span>
                  <input
                    type="date"
                    min="0001-01-01"
                    max="9999-12-31"
                    value={value.validUntil ?? ''}
                    onChange={(e) => update({ validUntil: e.target.value || undefined })}
                  />
                </label>
              </div>
            </>
          )}
        </>
      )}
    </details>
  );
}
