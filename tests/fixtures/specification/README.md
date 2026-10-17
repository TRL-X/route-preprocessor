# TRL-X Route reference vectors

These hexadecimal dumps come from Appendix B of the
[TRL-X Route 1.0 initial edition](https://github.com/TRL-X/route-specification/blob/50f585dd92b02cb0bb0de4b4a0be83695f296200/specification.md)
(2026-10-17), commit `50f585dd92b02cb0bb0de4b4a0be83695f296200`.

Each line starts with an eight-digit offset followed by file bytes. Unit tests
reconstruct the files and check their sizes, CRC32 values, decoded content and
exact serialization.

| Vector | Size | CRC32        | Revision |
| ------ | ---: | ------------ | -------: |
| A      |  492 | `0x9F58F1AA` |        8 |
| B      |  464 | `0x73CFBD2C` |        9 |
| C      |  404 | `0xBB625A01` |       10 |
