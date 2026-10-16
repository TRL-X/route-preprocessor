import { normalizeLongitude, positionAt, quantize } from './process';
import { validateMagneticDeclination } from './rte';
import type { MagneticDeclinationInfo, ReferenceRoute } from './types';

export const DECLINATION_ENDPOINT = 'https://geomag.bgs.ac.uk/web_service/GMModels/wmm/2025/';
export const DECLINATION_TIMEOUT_MS = 8000;
export const utcToday = () => new Date().toISOString().slice(0, 10);

/** One route-wide reference at half the reference distance, using assumed 0 m ellipsoid height. */
export function declinationReference(reference: ReferenceRoute, date: string): MagneticDeclinationInfo {
  const point = positionAt(reference, reference.totalM / 2);
  const lon = quantize(normalizeLongitude(point.lon) * 1e7);
  return { declinationCdeg: 0, referenceLatE7: quantize(point.lat * 1e7),
    referenceLonE7: lon === 1800000000 ? -1800000000 : lon,
    referenceDate: date, source: 'WMM2025 / BGS', referenceHeightDm: 0 };
}

/** Any service, network, timeout or validation failure leaves the optional metadata absent. */
export async function fetchRouteDeclination(reference: ReferenceRoute, date: string, signal?: AbortSignal): Promise<MagneticDeclinationInfo | undefined> {
  try {
    const info = declinationReference(reference, date);
    validateMagneticDeclination(info);
    if (date < '2025-01-01' || date > '2029-12-31') return undefined;
    const url = new URL(DECLINATION_ENDPOINT);
    url.search = new URLSearchParams({ latitude: String(info.referenceLatE7 / 1e7),
      longitude: String(info.referenceLonE7 / 1e7), altitude: '0', date, format: 'json' }).toString();
    const timeout = AbortSignal.timeout(DECLINATION_TIMEOUT_MS);
    const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!response.ok) return undefined;
    const body = await response.json();
    const result = body?.['geomagnetic-field-model-result'];
    const declination = result?.['field-value']?.declination;
    const coordinates = result?.coordinates;
    // Verify the response describes this request, with the expected angle convention and model.
    if (result?.model !== 'wmm' || String(result?.model_revision) !== '2025' || result?.date?.value !== date ||
        coordinates?.latitude?.value !== info.referenceLatE7 / 1e7 || coordinates?.longitude?.value !== info.referenceLonE7 / 1e7 ||
        coordinates?.altitude?.value !== 0 || declination?.units !== 'deg (east)' ||
        typeof declination?.value !== 'number' || !Number.isFinite(declination.value) || Math.abs(declination.value) > 180) return undefined;
    info.declinationCdeg = quantize(declination.value * 100);
    validateMagneticDeclination(info);
    return info;
  } catch { return undefined; }
}
