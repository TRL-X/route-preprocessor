# TRL-X Route reference vectors

These hexadecimal dumps come from Appendix B of the
[TRL-X Route 1.0 initial edition](https://github.com/TRL-X/route-specification/blob/f4e4e3d365e7f44e10bcb6b86365a9f2257b65d6/specification.md)
(2026-10-23), commit `f4e4e3d365e7f44e10bcb6b86365a9f2257b65d6`.

Each line starts with an eight-digit offset followed by file bytes. Unit tests
reconstruct the files and check their sizes, CRC32 and SHA-256 values, decoded
content and exact serialization. Their bytes also match the upstream binary
`vectors/a.rte`, `vectors/b.rte` and `vectors/c.rte` files at the pinned commit.

| Vector | Size | CRC32        | Revision |
| ------ | ---: | ------------ | -------: |
| A      |  492 | `0x9F58F1AA` |        8 |
| B      |  492 | `0x8861C349` |       12 |
| C      |  432 | `0xAD71ED27` |       13 |

All three contain the required stage summaries. B contains the same route data
as A under a different revision. C omits only the magnetic declination metadata.
A is unchanged from the 2026-10-17 draft.

SHA-256 values below refer to reconstructed binary files, not the text dumps:

| Vector | SHA-256                                                            |
| ------ | ------------------------------------------------------------------ |
| A      | `1eb37069ffd714b38fd8d6f3b2b2778b6ab09b4c05b800b9029d40c3bb06056b` |
| B      | `a47447193984ecc17e03d003a65d48a670435318d329d2ef12aa3fc6a15279d7` |
| C      | `4bd9ae982090760817d2358296032093c80cae0acd1649d941772ddd08338dfd` |

## Historical rejection fixtures

`legacy/2026-10-17-vector-b.hex` and `legacy/2026-10-17-vector-c.hex` preserve the
original Appendix B bytes from
[the 2026-10-17 draft](https://github.com/TRL-X/route-specification/blob/50f585dd92b02cb0bb0de4b4a0be83695f296200/specification.md),
commit `50f585dd92b02cb0bb0de4b4a0be83695f296200`. They omit stage summaries and
are invalid under the current draft even though their CRCs remain valid.

| Legacy vector | Size | CRC32        | Revision | Binary SHA-256                                                     |
| ------------- | ---: | ------------ | -------: | ------------------------------------------------------------------ |
| B             |  464 | `0x73CFBD2C` |        9 | `956eda7c0a704f0b0651632a02ff6cce754920758b7d201c92196875a29e6478` |
| C             |  404 | `0xBB625A01` |       10 | `2362b1a26f6d82bd399c5e0436544642f3cd1db941332842cd2843b5e10abf5d` |
