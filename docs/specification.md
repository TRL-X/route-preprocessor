# Specification alignment

The binary format, META CDDL and reference vectors are maintained in
[TRL-X/route-specification](https://github.com/TRL-X/route-specification).
This repository does not keep a separate copy of the normative specification.

The implementation targets the
[2026-10-17 initial edition](https://github.com/TRL-X/route-specification/blob/50f585dd92b02cb0bb0de4b4a0be83695f296200/specification.md),
commit `50f585dd92b02cb0bb0de4b4a0be83695f296200`, with file format version 1.0 and
META schema 1. The upstream document is marked Draft.

## Implementation requirements

- Every file includes META, GEOM, ELEV and GIDX. Complete elevation and elevation
  metadata are required for export.
- Magnetic declination, when present, uses core META key 9 and is validated by the
  reader.
- Processing settings and input SHA-256 belong to the local editor and report,
  rather than RTE metadata.
- A stage cache may be omitted. If present, it includes every stage and its exact
  minimum and maximum elevation.
- Declination queries distinguish an unspecified interval, a date inside or outside
  the interval, and an unknown query date. A reference date cannot stand in for a
  missing query date.
- Geometry interpolation preserves the sign of a longitude difference of exactly
  ±180 degrees, allowing reversed traversal to retrace the represented path.

The application imports GPX/KML, not RTE files. Inputs without a complete usable
profile must be corrected or explicitly interpolated where the policy permits.

Existing local drafts retain edits and route identity. The small settings
migration at the storage boundary changes the former elevation omission option to `source` and removes
obsolete declination height data. Export history is preserved so new content
receives a new revision instead of reusing an existing identity/revision pair.
See [draft validation and supported versions](architecture.md#draft-boundary).

## Update the implementation

1. Review the upstream specification, CDDL and changes, then pin the target commit.
2. Update encoding, decoding, processing and interface rules together. Record the
   resulting alignment and compatibility changes here.
3. Copy Appendix B's [A/B/C vectors](../tests/fixtures/specification/README.md) from
   that commit without modifying their bytes. Keep their source and checksums;
   tests must run without downloading the specification.
4. Run `npm run typecheck`, `npm test` and `npm run build`. Run the relevant
   Playwright tests for interaction changes.

Submit normative format changes to the specification repository. Application
algorithms, defaults and browser budgets are documented in
[preprocessing](preprocessing.md).
