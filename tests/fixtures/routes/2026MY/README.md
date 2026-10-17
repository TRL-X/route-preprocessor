# 2026MY route fixtures

These eight files were copied unchanged from the user-supplied `2026MY` directory
on 2026-10-15. They total 4,083,558 bytes. [manifest.json](manifest.json) records
file sizes, SHA-256 hashes and observations from the original XML.

The files are regression inputs outside the application source and Vite's
`public` directory. Runtime code must not import them. Unit tests read them from
the filesystem; browser tests upload them through the file picker.

## Source observations

Each file contains one track segment or LineString. Counts below describe the raw
input before cleanup, quantization or simplification; they do not verify geographic
accuracy.

| Group   | Points per file | GPX / KML landmarks | GPX points without elevation | GPX / KML conflicting-height pairs |
| ------- | --------------: | ------------------: | ---------------------------: | ---------------------------------: |
| EMY20K  |           1,898 |               3 / 5 |                            8 |                              1 / 6 |
| MMY50K  |           6,749 |               6 / 8 |                           10 |                              1 / 9 |
| DMY100K |           6,588 |             10 / 12 |                           17 |                              0 / 5 |
| UMY100M |          12,324 |             16 / 18 |                           47 |                            12 / 23 |

Distance labels in filenames are not calculated route lengths. GPX/KML pairs may
have equal point counts while differing in coordinate precision, heights and
landmarks, so they need not produce identical RTE bytes.

The manifest uses these definitions:

| Field                                                    | Definition                                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `segment_point_counts`                                   | Coordinate counts per GPX `trkseg`/`rte` or KML `LineString`, in source order, without joining segments |
| `landmark_count`                                         | Number of GPX `wpt` or KML `Point` elements, including duplicates                                       |
| `missing_elevation_count`                                | Track points without a height value; zero and negative values remain valid                              |
| `candidate_elevation_min_m`, `candidate_elevation_max_m` | Source height range, without asserting that values describe ground elevation                            |
| `consecutive_same_coordinate_pairs`                      | Adjacent pairs with equal numeric latitude/longitude, before E7 quantization                            |
| `same_coordinate_elevation_conflict_pairs`               | Those pairs where both heights exist and differ, with no difference threshold                           |
| `line_altitude_modes`                                    | Direct KML LineString altitude-mode declarations; `null` means absent                                   |

These KML files do not declare altitude modes. Their third coordinate values
remain candidate heights until accepted under the
[preprocessing policy](../../../../docs/preprocessing.md).

## Regression expectations

Tests cover missing elevation, repeated coordinates, height conflicts, name
cleanup, endpoint landmarks and event ordering by route distance. GPX/KML pairs
are processed independently. Incomplete profiles must block export unless explicit
interpolation can fill internal gaps; complete ELEV is always required.

The manifest identifies the source bytes and observations. Algorithm expectations
and RTE validation belong in tests. Preserve fixture bytes when changing tests or
documentation.
