# TRL-X Route reference vectors

These hexadecimal byte dumps are copied from Appendix B of the upstream TRL-X Route V1.0 initial edition (2026-10-17):

https://github.com/TRL-X/route-specification/blob/50f585dd92b02cb0bb0de4b4a0be83695f296200/specification.md

The source commit is `50f585dd92b02cb0bb0de4b4a0be83695f296200`. Each line begins with an eight-digit offset followed by the file bytes. The unit tests reconstruct the complete files and check their sizes, CRC32 values, decoded content, and exact serialization.

| Vector | Size | CRC32 | Revision |
| --- | ---: | --- | ---: |
| A | 492 | `0x9F58F1AA` | 8 |
| B | 464 | `0x73CFBD2C` | 9 |
| C | 404 | `0xBB625A01` | 10 |
