# Preprocessing policy

This document describes application behavior in `src/core/import.ts` and
`src/core/process.ts`. Binary layout and required semantics are defined by the
[pinned TRL-X Route specification](specification.md). Defaults, interpolation
choices and browser budgets are application policy and cannot relax format
requirements.

`src/core/policy.ts` defines shared defaults, parameter ranges, control choices and
import/processing budgets. The interface uses those definitions; common controls
may intentionally expose a narrower range than the core accepts.

## Input and continuous segments

`parseRouteFile(xml, fileName)` uses `fast-xml-parser`, without the browser DOM.
Each GPX `trkseg` or `rte` and each KML `LineString` becomes a separate
`SourceRoute`. Segments with fewer than two points are skipped with a warning;
segments are never joined automatically. GPX `wpt` and KML `Point` elements become
`SourceLandmark` values for matching.

Latitude must be in `[-90, 90]`, source longitude in `[-180, 180]`, and supplied
coordinates and heights must be finite. Missing height is `null`; zero and
negative heights are valid. Labels have control characters removed, whitespace
collapsed, edges trimmed and Unicode normalized to NFC. Names and CP numbers do
not reorder points. UTF-8 byte limits are checked before export. Imported text is
displayed as plain text.

DOCTYPE, entity declarations, unsupported entity references, multiple roots and
invalid XML are rejected. Predefined XML entities and numeric character references
are allowed.

| Import budget                |     Limit |
| ---------------------------- | --------: |
| File size                    |    20 MiB |
| Route points across the file |   200,000 |
| Selectable route segments    |       256 |
| Input landmarks              |     4,096 |
| XML nesting depth            |        64 |
| Scanned XML tags             | 1,500,000 |

`IMPORT_LIMITS` and XML guards enforce these budgets. The exported event limit is
separate and includes generated start and finish events.

## Reference distance and direction

`buildReference(source, { reverse, startIndex })` changes the closed-route start
if requested, reverses direction if requested, merges consecutive duplicate
coordinates and accumulates horizontal distance. Nonconsecutive repeated points
remain, preserving crossings, out-and-back sections and repeated visits.

Distance uses the haversine formula with a fixed radius of **6,371,008.8 m** and
the shortest wrapped longitude difference. This spherical approximation uses
WGS84 input coordinates; it is neither an ellipsoidal geodesic solution nor a
Web Mercator measurement. Elevation does not contribute to horizontal distance.

Each reference point receives cumulative distance `s` before simplification. Its
final value is `totalM`. Geometry, elevation and stations share this distance
axis; simplified chord lengths must not replace it. `positionAt(reference, s)`
interpolates latitude and longitude by reference-distance fraction, wraps
longitude at the antimeridian and rejects out-of-range distances. A longitude
difference of exactly ±180 degrees keeps its sign. `queryGeometry` applies the
same interpolation rule to encoded nodes.

A route is closed only when it has at least three points and its first and last
normalized coordinates match.
Nearby endpoints are not snapped together, and no closing edge is added.
`startIndex` refers to the original source point. `ReferencePoint.sourceIndex`
lets the interface select it from the cursor; the closing duplicate maps to
index 0. Moving the start preserves both observations at the original seam so
height conflicts remain detectable. Reversal follows the start adjustment.

Merged consecutive duplicates retain an unknown height if any observation is
missing or contradictory. Issues are recorded on `ReferenceRoute.issues`.
Adjacent source points more than 1 km apart produce a warning to check their
connection. Users must review and confirm the route and direction before export.

## Stations and repeated visits

`matchLandmark` projects a landmark onto reference segments in a local plane,
then compares candidates by great-circle distance. Candidates must be local
minima whose offset is at most 20 m greater than the nearest offset. Nearby candidates less than
20 m apart along the route are merged. At most 32 are returned, ordered by offset
and then route distance. These are matching heuristics, not accuracy guarantees.

`createStations` creates start and finish events and matches imported landmarks.
A single candidate within 50 m can be confirmed automatically; ambiguous or more
distant matches require confirmation. A landmark within 100 m of an endpoint
whose name identifies it as a start or finish may supply that endpoint's name
without adding another POI. Endpoint roles swap when an open route is reversed.
Start and finish remain distinct events even at the same coordinate.

Events are ordered by `(s_dm, event_id)`, independent of CP numbers or source
landmark order. `processRoute` requires:

- Unique, nonzero `u32` event IDs and 2–4,096 events.
- Exactly one start and finish, first and last in event order, at 0 and `S`, both
  marked as stage boundaries.
- Confirmed stations, names of 1–96 UTF-8 bytes and short labels of 1–16 bytes.
- Strictly increasing stage-boundary distances after decimeter quantization,
  with exact distance nodes in both GEOM and ELEV.

Ordinary events may share a distance; stage boundaries may not. Conflicts require
editing the distance or clearing a boundary rather than silently moving it.

## Geometry and quantization

The default geometry tolerance is **2 m**. Core accepts 0–1,000 m; the interface
provides a **1–5 m** slider in **0.5 m** steps. Restored drafts retain their saved
tolerance, including values outside the slider's range or step. Such values are
shown explicitly and remain unchanged until the user resets to the 2 m default;
core validation still determines whether they can be processed. Constrained Douglas–Peucker simplification preserves
endpoints and stage boundaries while limiting lateral deviation and progress
interpolation error. The latter threshold is `max(2 m, geometryToleranceM)`.

Reference edges longer than **250 m** are subdivided along their represented
segments before simplification. The simplifier also uses 250 m as a span guard.
Subdivision preserves the distance axis and adds no source precision. Its point
budget is 400,000, checked before adding required boundary nodes.

All integer conversion uses the specification's `Q(x)`: round to nearest, with
half values away from zero. JavaScript's `Math.round` does not implement this for
negative half values. Longitude is normalized to `[-180, 180)`; E7 quantization
that produces `+1800000000` is mapped to `-1800000000`.

Geometry points at the same quantized `s_dm` merge, with required boundaries
preferred. Adjacent equal E7 coordinates also merge where possible. If necessary
boundaries cannot survive in valid geometry, export fails. Integer overflow is
rejected rather than truncated or saturated. Final GEOM distances increase
strictly from 0 to `S`. Quantization can introduce resolution-scale differences.

## Elevation

Geometry and elevation are sampled independently and linked by distance, not
array index. Core defaults remain a **10 m** elevation grid, **0 m** smoothing
window and `source` mode. New imports select `interpolate` when the normalized
reference contains any missing height; complete routes select `source`, including
routes with zero or negative heights. Restored drafts and reference rebuilds keep
their existing elevation mode. Every export requires complete ELEV and elevation
metadata.

| `elevationMode` | Behavior                                                                  |
| --------------- | ------------------------------------------------------------------------- |
| `source`        | Every source height must be known                                         |
| `interpolate`   | Fill internal gaps by distance-linear interpolation between known heights |

Missing endpoint or whole-route elevation produces `INCOMPLETE_ELEVATION` in
either mode. Unknown terrain is never extended flat from a nearby height. Gap
span is the route distance between the known points on either side. Each filled
gap over **100 m** produces `ELEVATION_LARGE_GAP` with its location and span, but
does not block export. Filled profiles set `containsFilledValues: true` and report
the repair. `source` mode requires completeness even if the sampling grid would
skip a missing point.

KML third-coordinate values are candidate heights, regardless of `altitudeMode`.
Using them requires `acceptUncertainElevation`. Both GPX and KML currently use an
unknown vertical datum, `verticalDatum: 0`; WGS84 horizontal coordinates do not
establish a height datum. Generated elevation metadata uses `source: 1` and
`quality: 1` without claiming verified accuracy.

The grid includes 0, `S`, regular sample distances and every stage boundary.
Duplicate quantized distances are removed. Core accepts intervals of 0.1–1,000 m
and limits the profile to 200,000 samples.

A nonzero smoothing window applies a distance-integrated moving average to the
piecewise-linear source profile. At endpoints the window is clipped and divided
by its actual length, so endpoint heights may change. Core accepts windows up to
10,000 m. Final heights are quantized to `h_dm` before accumulating `up_dm` and
`down_dm`, preserving their exact difference equations. Sampling and smoothing
can change ascent and descent totals. Their settings remain in the local editor
and quality report. Display thinning must not replace this calculation profile.

A complete `stages` cache is generated between each pair of stage boundaries.
`minHDm` and `maxHDm` are the exact extrema of final ELEV nodes in the inclusive
stage interval.

## Magnetic declination

New imports default to automatic BGS WMM2025 lookup at the reference-distance
midpoint, `S/2`. The editable date starts at the current UTC calendar date. The
request sends the reference coordinates and date, assuming WGS84 ellipsoid
height 0 m rather than using source heights with an unknown datum. Credentials
and referrer are omitted, with an 8-second timeout.

Offline operation, service failures, invalid responses and dates outside
2025–2029 leave declination absent and permit export after the lookup ends. There
is no local model fallback. Automatic mode clears and refreshes the value when
its date or reference route changes, and when a draft is restored. Cancelled or
stale responses cannot overwrite current edits.

Responses are checked for model, date, coordinates, angle units and range. A
successful value uses `source: "WMM2025 / BGS"`. Automatic values omit validity
dates: the model's lifetime is not treated as a constant's applicability interval.

Manual mode retains the user's reference location, date, source and optional
validity interval, including when route direction changes. Omission excludes the
object entirely. The interface accepts degrees and applies `Q` to obtain
centidegrees and E7 coordinates. Declination is positive east and negative west;
zero is valid. Reference and validity dates use UTC Gregorian dates. Validity
endpoints must appear together, are inclusive and must enclose the reference
date. Source text must occupy 1–64 UTF-8 bytes. Invalid or incomplete values block
export.

Declination is retained in drafts, undo and reports, and encoded at core
`META[9]`. `queryMagneticDeclination` returns the stored constant with applicability
`unspecified` if no validity interval exists, and `applicable` for a trusted date
inside the interval. Missing data, a date outside the interval or a missing
trusted date for a declared interval throw `unavailable`, with applicability
`unavailable`, `outside_interval` or `time_unknown` respectively. The reference
date cannot substitute for a query date. `convertHeading` applies the format's
magnetic/true conversion and normalizes to `[0, 36000)` centidegrees.

## Encoding and validation

`processRoute` returns `RouteData`, or `route: null` with structured issues. The
export worker runs `encodeRte` followed by `decodeRte` before returning downloadable
bytes. Validation covers the header, layout, deterministic CBOR, CRC, geometry,
elevation, events, stages and GIDX relationships.

Regression tests cover the eight source fixtures and synthetic cases for separate
segments, duplicate coordinates, height conflicts, antimeridian crossings,
repeated visits, reversal, closed-route start changes, quantization collisions,
UTF-8 limits and elevation totals. Complete profiles are checked by encoding,
strict decoding and deterministic re-encoding. Incomplete profiles must fail
unless the selected interpolation mode can fill their internal gaps. These checks do not
certify the source elevation's accuracy.

The editor does not fetch DEM heights, transform source coordinate systems, join
disconnected routes, snap to roads, draw missing route sections or synchronize
with devices. Map display adaptations never change source coordinates.
