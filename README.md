# TRL-X Route Studio

A browser editor that converts GPX and KML files into validated TRL-X Route `.rte`
files. The six-step workflow supports desktop and mobile editing, with English and
Simplified Chinese interfaces.

## Development

Use Node.js 24, as specified in `.nvmrc`, and npm:

```sh
npm ci
npm run dev
```

Open the local URL printed in the terminal. To build and preview the static site:

```sh
npm run build
npm run preview
```

## Workflow

1. Import a GPX or KML file and select one continuous route segment.
2. Check the route, direction, start and finish. Closed routes can use a different
   starting point.
3. Edit stations, their positions and stage boundaries. Confirm a passing position
   when a landmark matches more than one part of the route.
4. Review elevation, sampling and smoothing. New imports with missing heights
   default to filling internal gaps; complete routes use source elevation.
   Uncertain KML heights require confirmation. Missing endpoint or whole-route
   elevation must be corrected in the source file.
5. Inspect the linked map and elevation profile, stage statistics and processing
   issues. The original profile remains available for comparison.
6. On Export, set the filename, then use **Download .rte** to encode, validate and
   download the route, or **Send to device** to open Bluetooth connection and
   upload controls. File details and a separate processing report show the output
   metadata, input hash, settings and diagnostics.

The editor preserves parsed source data, supports undo and saves a local draft in
IndexedDB. Background processing can be cancelled. Re-exporting the latest content
reuses its bytes and revision; changed content receives a new revision. IndexedDB
transactions coordinate revisions across tabs. If storage is unavailable, each
export receives a new route identity and revision 1, with a notice in the editor.

Downloads and device uploads share the editable filename on Export. Its default
is eight random uppercase ASCII letters followed by `.RTE`, such as `ABCDEFGH.RTE`.
The name stays stable while editing the current route in this session, including
repeated exports and retries. Enter a name with or without the suffix; export
normalizes the suffix to `.RTE`. Changing the filename leaves the route's name,
encoded bytes and revision unchanged.

Files are parsed, edited and exported locally. Automatic magnetic declination
lookup sends the route midpoint and selected date to the BGS WMM2025 service. A
failed lookup leaves declination absent; manual entry and omission are also
available. The optional basemap requests resources from its map provider. It uses
OpenFreeMap Liberty by default. To use another public style, copy `.env.example`
to `.env.local` and set `VITE_MAP_STYLE_URL` there, or set it in the hosting
environment. A local route preview is available when the map cannot load or WebGL
is unavailable.

## Bluetooth upload

On the Export step, use **Send to device** to expand the upload controls, then
**Connect device**, select a device exposing the mcumgr SMP Bluetooth service,
and choose **Upload route**. **Download .rte** remains available above the upload
controls. The validated RTE bytes go
directly from the browser to the device; no server or nRF app is needed. The
target directory defaults to `/SD:/ROUTES/` and is saved in this browser. Existing
saved directories are retained. The chosen `.RTE` filename is appended to that
directory. Create the directory on the device first; uploading overwrites an
existing file of the same name.

Use Chrome on Windows, macOS, ChromeOS or Android, over HTTPS (or localhost for
development). Browser access requires selecting the device in a permission
prompt. Safari and Firefox do not natively support this upload flow; the download
option remains available. Keep the page open and the device nearby during the
transfer. Cancelled or interrupted transfers can leave a partial file; reconnect
and upload again from the beginning.

The firmware must support mcumgr filesystem uploads over BLE, not only firmware
image updates. See the [SMP Bluetooth transport](https://docs.zephyrproject.org/latest/services/device_mgmt/smp_transport.html)
and [filesystem management](https://docs.zephyrproject.org/latest/services/device_mgmt/smp_groups/smp_group_8.html)
specifications. This client uses 20-byte GATT writes, so Zephyr firmware needs
`CONFIG_MCUMGR_TRANSPORT_BT_REASSEMBLY=y` and
`CONFIG_MCUMGR_TRANSPORT_NETBUF_SIZE` of at least 256 bytes to reassemble SMP
requests. Transfers report progress from device acknowledgements, and only
report success after the device acknowledges the complete file.

## Verification

```sh
npm run check
npx playwright install chromium webkit
npm run test:e2e
```

`npm run check` runs formatting, lint, type checks, unit tests and the production
build. Each check is also available separately. `npm run lint` checks React Hooks
and the dependency boundaries of core, device transport and workers.

Run `npm run format` to apply the shared Prettier configuration. CI checks formatting;
source route files and reference vectors are excluded to preserve their original bytes.

Unit tests cover the specification's A/B/C vectors, malformed files, quantization,
cross-section relationships, preprocessing, elevation statistics and revision
allocation. Playwright covers desktop Chromium, a phone-sized Chromium viewport
and WebKit, including validation of downloaded files. These browser profiles do
not replace testing on physical devices. GitHub Actions runs formatting, lint,
type checks, unit tests, the production build and browser tests.

The [2026MY fixtures](tests/fixtures/routes/2026MY/README.md) contain eight original
GPX/KML files across four route groups, with SHA-256 hashes and source observations.
They are test data and are excluded from the website build.

## Deployment

The project is a React, TypeScript and Vite static application. For Vercel, import
the repository with these settings; `vercel.json` is included:

| Setting          | Value           |
| ---------------- | --------------- |
| Framework preset | Vite            |
| Root directory   | Repository root |
| Node.js          | 24.x            |
| Install command  | `npm ci`        |
| Build command    | `npm run build` |
| Output directory | `dist`          |

The wizard uses the root URL and needs no route rewrites. Map configuration is
optional; `VITE_` values are included in the browser build and must be public.

## Code and documentation

```text
src/
  app/          Navigation, worker client, drafts and export revisions
  components/   Map and elevation chart
  features/     Workflow components
  i18n/         Locale resources, formatting and diagnostic messages
  core/         Models, parsing, preprocessing, CBOR/RTE encoding and validation
  workers/      Import, reference, processing and export tasks
tests/
  unit/         Algorithms, file format and persistence
  e2e/          Browser workflows
  fixtures/     Source samples and reference vectors
docs/           Implementation and maintenance notes
```

`src/core` is independent of React, the browser DOM and the map SDK.

- [Development agreements](AGENTS.md): focused changes, module ownership and
  verification requirements for contributors and coding agents.
- [Specification alignment](docs/specification.md): the pinned upstream format
  specification and the procedure for updating the implementation.
- [Architecture](docs/architecture.md): module boundaries, state and persistence.
- [Preprocessing](docs/preprocessing.md): algorithms, defaults and resource limits.
- [Internationalization](docs/i18n.md): locales, messages and formatting.

## Scope

The editor processes one continuous route at a time. It does not join disconnected
segments, fetch DEM elevation, snap routes to roads or synchronize with cloud
storage. Distance uses a fixed-radius spherical model, described in the
preprocessing notes. The application has no offline installation or navigation
mode.
