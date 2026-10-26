# Specification alignment

The binary format, META CDDL and reference vectors are maintained in
[TRL-X/route-specification](https://github.com/TRL-X/route-specification).
This repository does not keep a separate copy of the normative specification.

The implementation targets the
[2026-10-23 initial edition](https://github.com/TRL-X/route-specification/blob/f4e4e3d365e7f44e10bcb6b86365a9f2257b65d6/specification.md),
commit `f4e4e3d365e7f44e10bcb6b86365a9f2257b65d6`, with file format version 1.0 and
META schema 1. The upstream document is marked Draft.

## Implementation requirements

- Every file includes META, GEOM, ELEV and GIDX. Complete elevation and elevation
  metadata are required for export.
- Magnetic declination, when present, uses core META key 9 and is validated by the
  reader.
- Processing settings and input SHA-256 belong to the local editor and report,
  rather than RTE metadata.
- Stage summaries at core META key 8 are required. The array contains exactly one
  summary for every consecutive pair of stage-boundary events, in route order,
  with the exact minimum and maximum ELEV height over each inclusive interval.
- Declination queries distinguish an unspecified interval, a date inside or outside
  the interval, and an unknown query date. A reference date cannot stand in for a
  missing query date.
- Geometry interpolation preserves the sign of a longitude difference of exactly
  ±180 degrees, allowing reversed traversal to retrace the represented path.

The application imports GPX/KML, not RTE files. Inputs without a complete usable
profile must be corrected or explicitly interpolated where the policy permits.

## Compatibility with the 2026-10-23 draft

The upstream draft makes the formerly optional `stages` array mandatory without
changing file format version 1.0 or META schema 1. The reader now rejects files
that omit it, including the former B/C reference vectors, as invalid. The encoder
also rejects absent, empty or incomplete stage summaries rather than generating
or silently repairing them. Updated B/C fixtures use revisions 12/13; vector A
remains byte-for-byte unchanged. Historical B/C bytes are retained as rejection
fixtures with their original provenance and checksums.

Route Studio already generated all stage summaries, so existing application
exports remain valid and identical content retains its bytes and revision.
Processing, stage editing, filename handling and Bluetooth upload behavior are
unchanged. No draft migration, route identity reset or forced revision increment
is needed for this update.

Local drafts retain edits and route identity for the current draft version.
Unsupported older drafts are rejected at the storage boundary without rewriting
the stored record; users recover by re-importing the source file. Export history
is preserved so new content receives a new revision instead of reusing an existing
identity/revision pair. See [draft validation](architecture.md#draft-boundary).

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
