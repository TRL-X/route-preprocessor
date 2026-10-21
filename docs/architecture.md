# Architecture

Route Studio is a single React, TypeScript and Vite application. It builds to
ES2022 static assets in `dist` and has no application backend. Desktop and mobile
layouts share the same editing model and processing rules.

## Module boundaries

| Module                                         | Responsibility                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `src/App.tsx`                                  | UI coordination, view state and rendering                                           |
| `src/app/useEditorSession.ts`                  | Editor state, undo, draft loading and saving                                        |
| `src/app/useRouteProcessing.ts`                | Debounced processing and automatic declination                                      |
| `src/app/useRouteFiles.ts`                     | File operation status, output filename, cancellation and export feedback            |
| `src/app/route-files.ts`                       | Import, rebuild, filename validation, revision allocation, encoding and downloads   |
| `src/app/editor.ts`                            | Editor, revision ledger and versioned draft types                                   |
| `src/app/draft-schema.ts`                      | Draft validation and supported migrations                                           |
| `src/app/flow.ts`                              | Wizard completion, navigation, confirmation invalidation and issue ownership        |
| `src/app/worker-client.ts`                     | Worker creation, results and cancellation                                           |
| `src/app/drafts.ts`                            | IndexedDB drafts and export revision reservations                                   |
| `src/i18n`                                     | Locale discovery, preferences, typed messages and formatting                        |
| `src/features`                                 | Workflow controls, issue visibility and stage summaries                             |
| `src/features/elevation/ElevationSettings.tsx` | Elevation status and source controls, with optional sampling and smoothing settings |
| `src/device`                                   | mcumgr SMP frames, CBOR and browser Bluetooth file transport                        |
| `src/components/RouteMap.tsx`                  | MapLibre rendering and route/station interaction                                    |
| `src/components/ElevationChart.tsx`            | Profile rendering and linked cursor                                                 |
| `src/workers/route.worker.ts`                  | Import, reference, processing and export task entry points                          |
| `src/core/types.ts`                            | Source, editor and encoded route types, with units in field names                   |
| `src/core/policy.ts`                           | Processing defaults, parameter ranges, controls and browser budgets                 |
| `src/core/diagnostics.ts`                      | Known diagnostic codes and producer types                                           |
| `src/core/import.ts`                           | XML parsing, input validation and import limits                                     |
| `src/core/process.ts`                          | Reference distance, matching, geometry, elevation and stages                        |
| `src/core/cbor.ts`, `src/core/rte.ts`          | Deterministic encoding, validation and route queries                                |
| `src/core/declination.ts`                      | BGS magnetic declination lookup                                                     |

UI code uses worker tasks and core types. Workers call the core algorithms. Core
code has no React, DOM, MapLibre, persistence or download dependency; its XML
parser uses `fast-xml-parser`. Keep business validation in core so it applies
equally to browser actions and unit tests.

`eslint.config.js` enforces dependency boundaries for core, device transport and
workers, including type imports and re-exports. These layers use static imports
so their dependencies remain checkable. React Hooks checks cover UI components
and application hooks. The existing BGS HTTP lookup in core is retained; the
boundary rules do not prohibit network requests.

Radix Dialog, Lucide and shared CSS provide the interface controls. Layout rules
are in `src/app/layout.css`. The editor's fields scroll within the available
window height while navigation remains accessible. Mobile places the collapsible
preview above the editor; map and chart stay mounted when their visibility
changes, preserving the cursor. Entering Route or Stations selects the map;
entering Elevation selects the profile. Manual view selection lasts until the
next editing step, while preview collapse and the linked cursor are preserved.
Tall preview panes continue to show the map and profile together. Route
confirmation stays in the fixed editor footer beside continuation feedback and
navigation. The feedback explains existing workflow restrictions through
`src/app/flow.ts`; it does not introduce additional completion requirements.
Short phone layouts reduce repeated headings and spacing to keep the fields and
fixed footer usable; the preview can still be collapsed for more editing space.
The import card and stepper share the same horizontal bounds as the editing
workspace. Route simplification and magnetic-declination controls remain expanded;
the simplification slider uses the UI range defined in `src/core/policy.ts`.
Rendering and display simplification leave the computational profile and its
accumulated ascent and descent unchanged.

Station controls expand directly below the selected row without changing station
order. Rows show an expand/collapse action, and opening animates the editor height
unless reduced motion is requested. On phones, action labels wrap within a bounded
column to leave room for station metadata across system fonts and scrollbar widths.
The pending-station list links each station
name and distance to its editor, focuses its row and updates the linked cursor.
The next-unconfirmed action still cycles through pending positions; neither action
confirms a position automatically. The list replaces duplicate unconfirmed-position
diagnostics on Stations without changing validation or report contents. Map and
profile selection bring the matching row into view.

The elevation view distinguishes source completeness, required user confirmation
and the current processing result. It only reports filled gaps after the current
route records estimated heights. New imports select gap filling when the normalized
reference has missing heights; complete references select source mode. Restored
drafts and reference rebuilds retain the user's mode. Sampling, smoothing and
source comparison remain visible in the expanded advanced settings. KML elevation
confirmation stays in the fixed footer, with its checkbox disabled during file
operations or transfers. The status and footer replace the duplicate confirmation
diagnostic on Elevation; other errors, reports and core validation remain unchanged.
Missing endpoint or whole-route heights still block export in either mode. Short
phone layouts reserve more room for editing when elevation confirmation is present.

Export shows Download .rte and Send to device as direct actions. Download starts
the existing export preparation and download flow. Send to device toggles the
initially closed Bluetooth connection and upload controls. Both actions remain
visible; hiding the upload controls keeps their component mounted, preserving the
connection and feedback. Both actions are disabled during export or transfer,
while upload cancellation remains outside the disabled editor fieldset. File
details and the processing report remain visible below the controls. Export
validation and revision allocation follow the existing rules.

The editable export filename is shared by downloads and device uploads.
`useRouteFiles` retains it for the current route session, across route edits,
navigation, repeated exports and retries. A new route starts with eight random
uppercase ASCII letters and a `.RTE` suffix. `route-files` validates the chosen
name and normalizes its optional suffix to `.RTE` before preparing the export.
The filename is separate from route metadata and does not participate in content
hashing or revision allocation. The device directory defaults to `/SD:/ROUTES/`;
existing saved directory preferences retain their exact casing.

## State and processing

```text
File bytes -> SHA-256 and decoding -> import worker
                                          |
                              Parsed sources and segment choice
                                          |
                              Reference route and station matches
                                          |
                              Editor settings and user changes
                                          |
                                    process worker
                                          |
                                   ProcessingResult
                                          |
                         Revision reservation -> encode -> decode -> download / BLE upload
```

Parsed source points and landmarks remain separate from editing parameters and
computed results. Changing direction, segment or closed-route start rebuilds the
reference and station matches. The input SHA-256 and processing settings belong
to the editor and report, rather than RTE metadata. Drafts save parsed data, not a
copy of the original input bytes.

React state controls navigation. Processing results, task status and explicit
user confirmations determine whether a step can be completed. Export requires a
result for the current editor state, no blocking issues or active tasks, and a
confirmed route and direction. Station confirmations also participate in
processing. Changes invalidate affected later steps.

`src/app/flow.ts` owns the pure workflow rules. App applies their results to React
state and handles view effects. Import, draft restoration and rebuilding reset
the workflow to the Route step. Undo clears route confirmation and later-step
access while retaining the current step. Ordinary edits invalidate only the
affected confirmations and step access. Unit tests protect these distinctions.

The Bluetooth upload card shares the same export preparation and revision
reservation as downloads. During a transfer, route editing and navigation are
locked while the card's cancel button remains available. The transport handles
SMP notifications, acknowledgements, timeouts and disconnects separately from
the RTE codec. Its CBOR codec supports string keys without relaxing the restricted
RTE metadata profile. The configured device directory is an origin-local
preference; Bluetooth device permissions are managed by the browser.

Processing runs after a 120 ms debounce. Each task has its own worker, which is
terminated on completion or cancellation. The client discards stale results using
an activity flag and editor identity. This allows cancellation without polling
inside synchronous algorithms. Automatic declination requests use an abort
signal and also reject stale responses; export waits while a lookup is pending.

Undo retains the latest 25 prior editor states in memory. Draft writes use a
500 ms debounce. Save failures are visible in the interface; an unsaved editor
must not be reported as persisted. Drafts and preferences are local to the browser
and origin.

Issue ownership is defined in `src/app/flow.ts`; presentation filtering remains
in `src/features/review/issue-visibility.ts`. Each step
shows issues the user can address there; automatic cleanup remains in the report.
Preview and export show remaining blocking errors. Filtering never changes the
underlying validation or complete report.

## Draft boundary

`loadDraft()` reads unknown data, validates its envelope and nested editor
structures, and returns the current draft type. Source and reference data must
have safe coordinates, distances, indices and array sizes. Editable values may
still be incomplete or invalid for export, including empty names and unfinished
numeric input; processing reports those errors after restoration.

New writes use draft version 3. Versions 1 and 2 are supported only at the read
boundary: their settings are migrated in memory, and the next successful save
writes version 3. Loading never rewrites the stored record. Invalid structures and
unknown versions produce a visible error while leaving the original record intact.

The supported legacy versions are explicit in the schema. Retire them only with a
documented recovery path for existing users, such as re-importing the original
source file. There is no date-based expiry or fallback for an unknown version.

## Route identity and revisions

Import creates a random 16-byte route ID. A `(route_id, revision)` pair must always
identify identical bytes.

Before export, the editor encodes and validates a candidate with revision 1, then
hashes those bytes. An IndexedDB `readwrite` transaction reserves the real revision
in the `exports` store. Identical content to the latest export reuses its revision;
different content increments it. Returning to older content after another export
may therefore allocate a new revision. Failed encoding or download after a
reservation may leave an unused revision, which must not be reassigned.

`RevisionExhaustedError` at `0xffffffff` requires importing the source as a new
route. If persistence is unavailable, an export uses a fresh route ID and revision
1, with a visible notice. Coordination covers tabs on the same browser origin,
not different browsers, devices or cleared site data.

## Errors and limits

Import and invalid reference operations throw `Error` with a diagnostic message.
Expected processing problems return `ProcessingIssue` values:

- `code` identifies a stable diagnostic category.
- `severity` is `warning` or `error`; errors prevent `RouteData` generation.
- `params` contains locale-independent values for message interpolation.
- Optional `s` locates the issue on the reference distance axis.

The UI translates issues by code. Reports retain the structured diagnostics and
add the selected language and rendered explanations. See
[internationalization](i18n.md) for message conventions.

RTE and CBOR operations throw `RteError`:

| Code          | Meaning                                                                |
| ------------- | ---------------------------------------------------------------------- |
| `invalid`     | Invalid layout, value, CRC or cross-section relationship               |
| `unsupported` | Unsupported major version, schema, section version or critical section |
| `resource`    | Reader or encoder budget exceeded                                      |
| `unavailable` | Query data absent, or declination applicability cannot be established  |
| `range`       | Geometry or profile distance outside the route                         |

Workers return thrown errors as `{ ok: false, error: message }`; they currently do
not preserve `RteError.code`. Structured processing issues are returned intact.
Client cancellation uses `AbortError`.

RTE limits are 64 MiB per file, 256 directory entries and 1,000,000 records per
GEOM, ELEV or GIDX section. CBOR limits are 8 MiB, depth 16, 200,000 total items and
100,000 entries per container. These are implementation budgets, separate from the
format's permitted ranges and the smaller
[preprocessing limits](preprocessing.md).

## External resources

File parsing, processing and encoding run locally. BGS requests send the route
midpoint and selected date, with an 8-second timeout. Failed requests leave
declination absent. Users can enter it manually or omit it. MapLibre requests the
configured third-party style, tiles and fonts; `VITE_MAP_STYLE_URL` overrides the
default OpenFreeMap Liberty style. Local route rendering remains available if the
basemap fails. There is no service worker to cache the application for offline use.

World copies, antimeridian unwrapping and Mercator latitude limits affect display
only. Source coordinates and encoded WGS84 E7 values remain unchanged.

## Verification and ownership

The [upstream specification](specification.md) owns the binary format and CDDL.
This repository owns processing policy and interface behavior. A change in one
does not authorize changing the meaning of the other.

Format tests use pinned reference vectors and malformed inputs. Processing tests
use synthetic routes with explicit expectations and the eight
[2026MY fixtures](../tests/fixtures/routes/2026MY/README.md). Persistence tests cover
drafts and revision reservations. Core changes require type checks, unit tests
and a production build; interaction changes also require the relevant Playwright
tests. `npm run check` runs formatting, lint, type checks, unit tests and a
production build. TypeScript checks reject unused locals and parameters.
`npm run format:check` enforces the shared Prettier configuration in CI;
`npm run format` applies it locally. Original route samples and reference vectors
are excluded from formatting.

See [development agreements](../AGENTS.md) for the concise contributor and coding
agent workflow. Update this document when module responsibilities change.

Write documentation, code comments and test descriptions in English. Keep
localized interface text in locale resources and preserve source fixture bytes.

The source fixtures are excluded from runtime assets. Their creator metadata is
not a license grant; no explicit license was found in the supplied samples. Keep
their recorded hashes and provenance when updating the fixture collection.
