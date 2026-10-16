import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildReference } from '../../src/core/process';
import { DECLINATION_ENDPOINT, declinationReference, fetchRouteDeclination } from '../../src/core/declination';

const reference = buildReference({ id: 'test', name: 'Test', elevationDatum: 0, elevationUncertain: false,
  points: [{ lat: 40, lon: 115.99, elevation: 100 }, { lat: 40, lon: 116.01, elevation: 200 }] });
// Shape and values from BGS's live WMM2025 endpoint at 40 N, 116 E, 0 km, 2026-10-16.
const fixture = () => ({ 'geomagnetic-field-model-result': {
  model: 'wmm', model_revision: '2025', date: { value: '2026-10-16' },
  coordinates: { latitude: { units: 'deg (north)', value: 40 }, longitude: { units: 'deg (east)', value: 116 }, altitude: { units: 'km', value: 0 } },
  'field-value': { declination: { units: 'deg (east)', value: -7.464 } },
} });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
afterEach(() => vi.unstubAllGlobals());

describe('online magnetic declination defaults', () => {
  it('requests only a quantized midpoint, date and assumed zero ellipsoid altitude and records provenance', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(fixture()));
    vi.stubGlobal('fetch', fetcher);
    const info = await fetchRouteDeclination(reference, '2026-10-16');
    expect(info).toEqual({ declinationCdeg: -746, referenceLatE7: 400000000, referenceLonE7: 1160000000,
      referenceDate: '2026-10-16', source: 'WMM2025 / BGS', referenceHeightDm: 0 });
    const [url, options] = fetcher.mock.calls[0];
    expect(url.origin + url.pathname).toBe(DECLINATION_ENDPOINT);
    expect(Object.fromEntries(url.searchParams)).toEqual({ latitude: '40', longitude: '116', altitude: '0', date: '2026-10-16', format: 'json' });
    expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    expect(info).not.toHaveProperty('validUntil');
  });
  it('keeps a genuine service zero and rounds negative halves away from zero', async () => {
    for (const [value, expected] of [[0, 0], [-3.125, -313]]) {
      const body = fixture(); body['geomagnetic-field-model-result']['field-value'].declination.value = value;
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
      expect((await fetchRouteDeclination(reference, '2026-10-16'))?.declinationCdeg).toBe(expected);
    }
  });
  it('leaves missing data for network errors, failed HTTP responses, invalid JSON and malformed results', async () => {
    for (const value of [response({}, 503), new Response('bad json'), response({}), response(null)]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(value));
      expect(await fetchRouteDeclination(reference, '2026-10-16')).toBeUndefined();
    }
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect(await fetchRouteDeclination(reference, '2026-10-16')).toBeUndefined();
  });
  it('rejects wrong models, coordinates, dates, units and nonnumeric or out-of-range values', async () => {
    const changes = [
      (r: any) => { r.model = 'igrf'; }, (r: any) => { r.model_revision = '2020'; },
      (r: any) => { r.date.value = '2026-10-15'; }, (r: any) => { r.coordinates.latitude.value = 41; },
      (r: any) => { r.coordinates.longitude.value = 117; }, (r: any) => { r.coordinates.altitude.value = 1; },
      (r: any) => { r['field-value'].declination.units = 'radians'; },
      ...[null, '-7.464', 181].map(value => (r: any) => { r['field-value'].declination.value = value; }),
    ];
    for (const change of changes) {
      const body = fixture(); change(body['geomagnetic-field-model-result']);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(body)));
      expect(await fetchRouteDeclination(reference, '2026-10-16')).toBeUndefined();
    }
  });
  it('does not request impossible dates or dates outside the model period', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const date of ['', '2026-02-29', '2024-12-31', '2030-01-01']) expect(await fetchRouteDeclination(reference, date)).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('propagates cancellation to fetch and treats it as unavailable', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })));
    const pending = fetchRouteDeclination(reference, '2026-10-16', controller.signal);
    controller.abort();
    expect(await pending).toBeUndefined();
  });
  it('locates a midpoint correctly across the antimeridian', () => {
    const crossing = buildReference({ id: 'crossing', name: 'Crossing', elevationDatum: 0, elevationUncertain: false,
      points: [{ lat: 0, lon: 179, elevation: null }, { lat: 0, lon: -179, elevation: null }] });
    expect(declinationReference(crossing, '2026-10-16').referenceLonE7).toBe(-1800000000);
  });
});
