# TRL-X Route
## 文件格式规范 / File Format Specification

| 项目 / Item | 值 / Value |
|---|---|
| 文档标识 / Document ID | `TRL-X-ROUTE-SPEC` |
| 格式版本 / Format version | **1.0** |
| 文档修订 / Document revision | **0.2** |
| 状态 / Status | **Draft / 草案** |
| 日期 / Date | 2026-10-15 |
| 推荐扩展名 / Recommended extension | `.rte` |

本文定义 TRL-X Route 的二进制布局、数据语义及验证要求，与硬件、操作系统、文件系统和传输协议无关。本文仍为草案。

This document specifies the binary layout, data semantics, and validation requirements of TRL-X Route, independently of hardware, operating system, filesystem, or transport. This document remains a draft.

中英文共享字段表、公式和 CDDL；如有歧义，以英文规范性文字及共享定义为准。除注明为资料性的内容外，正文和附录均为规范性内容。`MUST`、`MUST NOT`、`SHOULD`、`SHOULD NOT`、`MAY` 分别对应“必须”“不得”“应”“不应”“可以”，按 BCP 14 解释。[R1] [R2]

The Chinese and English text share field tables, equations, and CDDL. In case of ambiguity, the English normative text and shared definitions prevail. The body and appendices are normative unless marked informative. The uppercase terms `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, and `MAY` are interpreted as specified in BCP 14.[R1] [R2]

### 目录 / Contents

1. [数据模型 / Data model](#model)
2. [通用编码 / General encoding](#encoding)
3. [文件布局与文件头 / Layout and header](#header)
4. [数据段目录 / Section directory](#directory)
5. [路线几何 / Route geometry — GEOM](#geom)
6. [高程剖面 / Elevation profile — ELEV](#elev)
7. [元数据 / Metadata — META](#meta)
8. [几何索引 / Geometry index — GIDX](#gidx)
9. [完整性 / Integrity](#integrity)
10. [符合性与扩展 / Conformance and extensions](#conformance)

[A. META CDDL](#cddl) · [B. 参考向量 / Reference vectors](#vectors) · [规范性引用 / Normative references](#references)

<a id="model"></a>
## 1. 数据模型 / Data model

每个文件表示一条连续、有向路线的不可变版本，包含平面几何、有序站点事件和几何索引，可以包含全程高程剖面及累计上升、下降。V1 不定义不连续轨迹、未知高程缺口、压缩或加密数据段；源数据解析、预处理算法、显示、实时状态、传输、存储发布及签名机制不在本规范范围内。

Each file represents an immutable version of one continuous, directed route. It contains planimetric geometry, ordered station events, and a geometry index, and MAY contain a complete elevation profile with cumulative ascent and descent. V1 does not define discontinuous tracks, unknown elevation gaps, or compressed or encrypted sections. Source parsing, preprocessing algorithms, presentation, live state, transport, storage publication, and signature mechanisms are outside its scope.

| 术语 / Term | 定义 / Definition |
|---|---|
| 生成器 / Producer | 生成文件的实现。 / An implementation that creates files. |
| 读取器 / Reader | 验证并解释文件的实现。 / An implementation that validates and interprets files. |
| `s` | 沿路线方向累计的基准水平距离，不是点编号、三维坡面距离或直线距离。 / Reference cumulative horizontal distance in route order; not a node index, 3D surface distance, or straight-line distance. |
| `S` | `META.total_s_dm`，以 dm 表示的基准全长。 / `META.total_s_dm`, the total reference distance in dm. |
| 站点事件 / Station event | 路线中一次经过站点的逻辑事件。 / One logical visit to a station along the route. |
| 阶段 / Stage | 相邻阶段边界站点之间的区间。 / The interval between consecutive stage-boundary events. |

生成器必须在平面简化前建立里程轴，并在所有数据段中保持一致。`GEOM` 与 `ELEV` 独立采样，只通过里程关联；不得按相同数组下标关联，也不得以简化几何重算的距离替换基准里程。改变方向或起点时，必须重新生成里程、站点顺序及累计升降。

The producer MUST establish the distance axis before planimetric simplification and use it consistently across sections. `GEOM` and `ELEV` are independently sampled and related only by distance, not by equal array indices. Distances recomputed from simplified geometry MUST NOT replace reference distances. Changing direction or the start requires regeneration of distances, station order, and cumulative elevation statistics.

<a id="encoding"></a>
## 2. 通用编码 / General encoding

| 项目 / Item | 规则 / Rule |
|---|---|
| 字节 / Byte | 8 位 / 8 bits |
| `u16`, `u32` | 16、32 位无符号整数。 / Unsigned 16- and 32-bit integers. |
| `i32` | 32 位二进制补码有符号整数。 / Signed 32-bit two's-complement integer. |
| 二进制字节序 / Binary byte order | 文件头、目录及记录中的多字节整数为小端；字节数组原样保存。 / Multibyte integers in headers, directory entries, and records are little-endian; byte arrays preserve their order. |
| CBOR | 按 RFC 8949 编码，不套用二进制字段的小端规则。 / Encoded according to RFC 8949, not the little-endian binary-field rule.[R3] |
| 索引、偏移 / Indices and offsets | 索引从 0 开始；偏移和长度以字节计；数据段偏移相对文件起点。 / Indices are zero-based; offsets and lengths are in bytes; section offsets are file-relative. |
| `_e7` | 十进制度乘 `10^7`。 / Decimal degrees multiplied by `10^7`. |
| `_dm` | 分米；`1 dm = 0.1 m`。 / Decimeters; `1 dm = 0.1 m`. |

量化必须舍入到最接近整数，半值远离零；超出字段范围必须拒绝，不得截断、回绕或饱和。经度在量化前归一到 `[-180,180)`；若量化得到 `+1800000000`，必须改为 `-1800000000`。量化后的节点里程必须严格递增；重复里程须由生成器消解。

Quantization MUST round to the nearest integer, with ties away from zero. Out-of-range results MUST be rejected, not truncated, wrapped, or saturated. Longitude is normalized to `[-180,180)` before quantization; a result of `+1800000000` MUST become `-1800000000`. Quantized node distances MUST strictly increase; the producer MUST resolve collisions.

```text
Q(x) = floor(x + 0.5), x >= 0
Q(x) = ceil(x - 0.5),  x < 0
```

文本必须为有效 UTF-8，不含 U+0000；长度均按 UTF-8 字节数计算，不含结尾 NUL。路线名称、站点名称及短标签还不得包含 U+0001–U+001F 或 U+007F。编码分辨率不代表源数据准确度。

Text MUST be valid UTF-8 without U+0000. Lengths count UTF-8 bytes, with no terminating NUL. Route names, station names, and short labels MUST also exclude U+0001–U+001F and U+007F. Encoding resolution does not imply source accuracy.

<a id="header"></a>
## 3. 文件布局与文件头 / Layout and header

文件以 64 字节文件头开始，随后为 `N × 24` 字节目录。目录项按数据段偏移升序排列；数据段类型顺序不限。各段长度必须为正，起点按 4 字节对齐，仅允许 0–3 字节的零填充。末段必须精确结束于文件末尾，不允许尾部填充或未登记数据。

A file starts with a 64-byte header followed by an `N × 24`-byte directory. Directory entries are ordered by increasing section offset; section types may occur in any order. Every section has positive length and a four-byte-aligned start, with only 0–3 zero padding bytes between regions. The last section MUST end exactly at EOF; trailing padding and unregistered data are prohibited.

```text
align4(x) = ((x + 3) // 4) * 4
first.offset = align4(64 + N * 24)
next.offset  = align4(previous.offset + previous.length)
file_size    = last.offset + last.length
```

以下偏移相对文件起点。 / The following offsets are relative to the file start.

| Offset | Size | Field | Type | 约束 / Constraint |
|---:|---:|---|---|---|
| 0 | 4 | `magic` | `byte[4]` | ASCII `ARRT`：`41 52 52 54` |
| 4 | 2 | `major_version` | `u16` | `1` |
| 6 | 2 | `minor_version` | `u16` | `0`；扩展规则见第 10 节。 / `0`; extension handling in Section 10. |
| 8 | 2 | `header_size` | `u16` | `64` |
| 10 | 2 | `directory_entry_size` | `u16` | `24` |
| 12 | 4 | `file_size` | `u32` | 等于实际文件长度。 / Equals actual file length. |
| 16 | 4 | `directory_offset` | `u32` | `64` |
| 20 | 2 | `directory_count` | `u16` | `3..65535` |
| 22 | 2 | `flags` | `u16` | `0` |
| 24 | 16 | `route_id` | `byte[16]` | 不透明标识，非全零。 / Opaque, not all zero. |
| 40 | 4 | `revision` | `u32` | `1..4294967295` |
| 44 | 4 | `file_crc32` | `u32` | 按第 9 节计算。 / Calculated as in Section 9. |
| 48 | 16 | `reserved` | `byte[16]` | 全零 / All zero |

同一 `(route_id, revision)` 必须标识完全相同的文件字节。内容或编码表示发生变化时，必须分配新 revision；revision 不得回绕复用。`route_id` 不强制采用 UUID，始终按 16 个原始字节解释。扩展名和文件名不参与格式识别或路线身份。

A `(route_id, revision)` pair MUST identify identical file bytes. Changes to content or serialization require a new revision; revisions MUST NOT wrap and be reused. `route_id` is always 16 raw bytes and need not be a UUID. Extensions and filenames do not determine format recognition or route identity.

<a id="directory"></a>
## 4. 数据段目录 / Section directory

以下偏移相对每个 24 字节目录项。 / Offsets are relative to each 24-byte directory entry.

| Offset | Size | Field | Type | 定义 / Definition |
|---:|---:|---|---|---|
| 0 | 4 | `type` | `byte[4]` | FourCC，每字节为 ASCII `A–Z` 或 `0–9`。 / FourCC; each byte is ASCII `A–Z` or `0–9`. |
| 4 | 2 | `flags` | `u16` | Bit 0：`MUST_UNDERSTAND`；其余为 0。 / Bit 0: `MUST_UNDERSTAND`; other bits zero. |
| 6 | 2 | `section_version` | `u16` | 本文定义的段使用 `1`。 / Sections defined here use `1`. |
| 8 | 4 | `offset` | `u32` | 文件内绝对偏移。 / Absolute file offset. |
| 12 | 4 | `length` | `u32` | 段长度，不含填充。 / Section length excluding padding. |
| 16 | 4 | `record_size` | `u32` | 定长记录大小，非记录段为 0。 / Fixed record size, or 0 for non-record data. |
| 20 | 4 | `record_count` | `u32` | 记录数，非记录段为 0。 / Record count, or 0 for non-record data. |

类型在文件内必须唯一。记录段的两个 record 字段必须均为正，且 `length = record_size × record_count`；非记录段的两个字段必须均为 0。段之间及其与文件头、目录之间不得重叠。以上规则也适用于未知数据段。

Section types MUST be unique within a file. Record sections MUST have two positive record fields and satisfy `length = record_size × record_count`; non-record sections MUST have both fields zero. Sections MUST NOT overlap each other, the header, or the directory. These rules also apply to unknown sections.

| Type | 存在性 / Presence | Version | Flags | Record size | Record count |
|---|---|---:|---:|---:|---:|
| `META` | 必须 / Required | 1 | `0x0001` | 0 | 0 |
| `GEOM` | 必须 / Required | 1 | `0x0001` | 12 | ≥ 2 |
| `ELEV` | 可选 / Optional | 1 | `0x0001` | 16 | ≥ 2 |
| `GIDX` | 必须 / Required | 1 | `0x0001` | 32 | ≥ 1 |

`MUST_UNDERSTAND` 表示读取器不能解释该段时必须拒绝文件。“段可不存在”不代表“存在时可以忽略”：`ELEV` 存在时也是关键段。

`MUST_UNDERSTAND` requires rejection if the reader cannot interpret the section. Optional presence does not imply optional interpretation: `ELEV` is critical when present.

<a id="geom"></a>
## 5. 路线几何 / Route geometry — `GEOM`

每条记录 12 字节，坐标为 WGS84 定点纬度、经度。 / Each record is 12 bytes, using fixed-point WGS84 latitude and longitude.

| Offset | Field | Type | 范围 / Range |
|---:|---|---|---|
| 0 | `lat_e7` | `i32` | `-900000000..900000000` |
| 4 | `lon_e7` | `i32` | `-1800000000..1799999999` |
| 8 | `s_dm` | `u32` | `0..S` |

首末节点里程必须为 0 和 `S`，其余严格递增。相邻记录定义有序线段，相邻节点坐标不得完全相同；非相邻节点允许重合。必须保留经过顺序，不得按坐标排序或全局去重。没有隐含的末点至首点连线；闭合须由显式末节点表示。

The first and last distances MUST be 0 and `S`, with strictly increasing intermediate distances. Adjacent records define ordered segments and MUST have distinct coordinates; nonadjacent vertices may coincide. Traversal order MUST be preserved without coordinate sorting or global deduplication. No implicit last-to-first edge exists; closure requires an explicit final node.

在线段 `i` 上获得正向比例 `0 ≤ t ≤ 1` 时，沿线位置为下式；定位匹配和投影算法不由本规范规定。

For a forward fraction `0 ≤ t ≤ 1` on segment `i`, along-route position is defined below. Matching and projection algorithms are not specified here.

```text
s = s[i] + t * (s[i+1] - s[i])
```

<a id="elev"></a>
## 6. 高程剖面 / Elevation profile — `ELEV`

### 6.1 记录与约束 / Records and constraints

| Offset | Field | Type | 定义 / Definition |
|---:|---|---|---|
| 0 | `s_dm` | `u32` | 沿线里程 / Along-route distance |
| 4 | `h_dm` | `i32` | 路线高程 / Route elevation |
| 8 | `up_dm` | `u32` | 从起点累计上升 / Cumulative ascent from start |
| 12 | `down_dm` | `u32` | 从起点累计下降 / Cumulative descent from start |

每条记录 16 字节。`ELEV` 必须覆盖完整 `[0,S]`，首末里程为 0 和 `S`，并严格递增；无需等距采样。零和负高程均有效，不设缺失值哨兵。无法形成完整剖面时，必须同时省略 `ELEV` 和 `META.elevation`；不得将未知缺口编码为平地。

Each record is 16 bytes. `ELEV` MUST cover all of `[0,S]`, starting at 0, ending at `S`, and strictly increasing in distance; uniform spacing is not required. Zero and negative elevations are valid, with no missing-value sentinel. If a complete profile is unavailable, both `ELEV` and `META.elevation` MUST be omitted; unknown gaps MUST NOT be encoded as flat terrain.

`ELEV` 表示最终计算用剖面。生成器必须先确定节点并量化 `h_dm`，再由下式计算累计值，且每条等式必须精确成立。显示抽稀不得改变本表统计含义。

`ELEV` is the final calculation profile. The producer MUST select nodes and quantize `h_dm` before computing cumulative values below; every equation MUST hold exactly. Display thinning MUST NOT alter the statistics represented by this table.

```text
up[0] = 0; down[0] = 0
For i > 0:
    dh      = h[i] - h[i-1]
    up[i]   = up[i-1]   + max(dh, 0)
    down[i] = down[i-1] + max(-dh, 0)

Consequently: up[i] - down[i] = h[i] - h[0]
```

### 6.2 查询语义 / Query semantics

对 `0 ≤ s ≤ S`，使用相邻节点对 `h`、`up`、`down` 按相同比例分段线性插值。精确命中节点时返回存储值；`s=S` 返回末值。范围外查询必须报告范围错误，不得外推。

For `0 ≤ s ≤ S`, interpolate `h`, `up`, and `down` piecewise linearly using the same bracketing nodes and fraction. Exact node hits return stored values; `s=S` returns the final values. Out-of-range queries MUST report a range error rather than extrapolate.

```text
t = (s - s[i]) / (s[i+1] - s[i])
H(s) = h[i]    + t * (h[i+1]    - h[i])
U(s) = up[i]   + t * (up[i+1]   - up[i])
D(s) = down[i] + t * (down[i+1] - down[i])

For 0 <= a <= b <= S:
    distance(a,b) = b - a
    ascent(a,b)   = U(b) - U(a)
    descent(a,b)  = D(b) - D(a)
    net_height(a,b) = H(b) - H(a)
```

以上是以 dm 表示的数学定义。返回整数时，应在最终差值后使用 `Q` 舍入，而不是分别舍入中间值。源高程质量由元数据描述，累计等式只保证内部一致性。

These are mathematical definitions in dm. Integer results SHOULD be rounded with `Q` after the final subtraction, rather than rounding intermediate values separately. Metadata describes source quality; the cumulative equations establish internal consistency only.

<a id="meta"></a>
## 7. 元数据 / Metadata — `META`

### 7.1 CBOR 配置 / CBOR profile

`META` 必须恰好包含一个 CBOR map，采用 RFC 8949 core deterministic encoding，且满足以下约束：所有 map 键为 `0..65535` 的无符号整数并严格递增；整数和长度采用最短编码；容器和字符串长度确定；禁止重复键、浮点、标签、undefined 及尾随 CBOR 项。只允许 schema 指定的整数、布尔值、null、文本、字节串、数组及 map。所有整数值须在 `-2147483648..4294967295` 内，并满足字段范围。[R3]

`META` MUST contain exactly one CBOR map using RFC 8949 core deterministic encoding with these restrictions: all map keys are unsigned integers `0..65535` in strictly increasing order; integers and lengths use shortest encodings; containers and strings have definite lengths; duplicate keys, floats, tags, undefined, and trailing CBOR items are prohibited. Only schema-permitted integers, booleans, null, text, byte strings, arrays, and maps are allowed. All integer values MUST fit `-2147483648..4294967295` and their field ranges.[R3]

下表中的键为整数，字段名只用于说明。已定义结构 map 中未知的 `0..127` 键必须拒绝；`128..65535` 为可忽略扩展。该保留规则不适用于扩展值内部的自定义 map，但通用 CBOR 编码和取值限制仍然适用。附录 A 定义完整 CDDL；编码顺序和跨段语义仍须单独满足。[R4]

Keys below are integers; field names are descriptive only. In defined structured maps, unknown keys `0..127` MUST be rejected; keys `128..65535` are ignorable extensions. This reservation does not apply inside custom extension-value maps, but the general CBOR encoding and value limits still apply. Appendix A supplies the complete CDDL; encoding order and cross-section semantics remain separate requirements.[R4]

### 7.2 根 map / Root map

除标为可选或条件存在外，字段均为必需；此约定也适用于后续元数据表。

Fields are required unless marked optional or conditional; this convention also applies to the following metadata tables.

| Key | Field | Type / Limit | 定义 / Definition |
|---:|---|---|---|
| 0 | `schema_version` | `1` | 元数据版本 / Metadata version |
| 1 | `name` | text, 1–96 bytes | 路线名称 / Route name |
| 2 | `total_s_dm` | positive `u32` | 基准全长 `S` / Reference total `S` |
| 3 | `route_kind` | `0..1` | `0=open`，`1=loop`；仅分类，不隐含连线或重复圈数。 / Classification only; no implied edge or laps. |
| 4 | `coordinate_ref` | `1` | WGS84 E7 纬度、经度 / WGS84 E7 latitude, longitude |
| 5 | `elevation` | map | 当且仅当存在 `ELEV`。 / Present if and only if `ELEV` exists. |
| 6 | `preprocessing` | map | 生成来源信息 / Production provenance |
| 7 | `stations` | array, 2–4096 | 有序站点事件 / Ordered station events |
| 8 | `stages` | optional array, 1–4095 | 完整阶段缓存 / Complete stage cache |

### 7.3 高程信息 / Elevation metadata

| Key | Field | Type / Limit | 定义 / Definition |
|---:|---|---|---|
| 0 | `source` | `0..4` | `0=unknown`, `1=source file`, `2=DEM`, `3=mixed`, `4=survey` |
| 1 | `vertical_datum` | `0..3` | `0=unknown`, `1=orthometric`, `2=ellipsoidal`, `3=local/relative` |
| 2 | `quality` | `0..2` | `0=unknown`, `1=estimated`, `2=checked` |
| 3 | `source_detail` | optional text, 1–128 bytes | 来源说明 / Source description |
| 4 | `datum_name` | optional text, 1–64 bytes | 高程基准或模型名称 / Vertical reference or model name |
| 5 | `contains_filled_values` | optional boolean | 是否含补全值，缺省 false。 / Contains filled values; default false. |

所有节点必须采用一致的高程基准；基准未知时必须标为 `unknown`，混合来源不得保留未处理的基准跳变。`DEM` 指数字高程模型；`checked` 表示生成器执行了质量检查，不表示认证精度。WGS84 水平坐标不隐含高程基准。

Nodes MUST use a consistent vertical reference. An unknown reference MUST be labeled `unknown`; mixed sources MUST NOT retain unresolved datum steps. `DEM` means digital elevation model. `checked` denotes producer quality checks, not certified accuracy. WGS84 horizontal coordinates do not imply a vertical datum.

### 7.4 预处理信息 / Preprocessing metadata

| Key | Field | Type / Limit | 定义 / Definition |
|---:|---|---|---|
| 0 | `tool` | text, 1–64 bytes | 生成工具 / Producer tool |
| 1 | `tool_version` | text, 1–32 bytes | 工具版本 / Tool version |
| 2 | `recipe_id` | text, 1–64 bytes | 处理流程或配置标识 / Processing recipe or configuration identifier |
| 3 | `input_sha256` | optional bytes, exactly 32 | 单个原始输入文件字节的 SHA-256。 / SHA-256 of one original input file's exact bytes. |
| 4 | `parameters` | optional map | 下表中的追溯参数 / Provenance parameters below |

| Parameter key | Field | Type | 定义 / Definition |
|---:|---|---|---|
| 0 | `geometry_tolerance_dm` | optional `u32` | 名义平面简化容差 / Nominal planimetric simplification tolerance |
| 1 | `elevation_grid_dm` | optional positive `u32` | 名义高程采样间隔，不保证节点等距。 / Nominal elevation spacing; not a uniform-sampling guarantee. |
| 2 | `elevation_smoothing_window_dm` | optional `u32` | 名义平滑窗口；0 表示未平滑。 / Nominal smoothing window; 0 means none. |

这些字段用于追溯，不得改变已编码数据的解释。`input_sha256` 不是路线文件的哈希或签名；多个输入时须省略该字段，或在非关键扩展中另行记录输入清单。

These fields provide provenance and MUST NOT alter interpretation of encoded data. `input_sha256` is not the route file's hash or a signature. With multiple inputs, omit it or record an input manifest separately in a noncritical extension.

### 7.5 站点事件 / Station events

| Key | Field | Type / Limit | 定义 / Definition |
|---:|---|---|---|
| 0 | `event_id` | positive `u32` | 文件内唯一 / Unique within the file |
| 1 | `name` | text, 1–96 bytes | 名称 / Name |
| 2 | `short_label` | text, 1–16 bytes | 短标签 / Short label |
| 3 | `kind` | `0..4` | `0=start`, `1=finish`, `2=CP`, `3=water`, `4=POI` |
| 4 | `stage_boundary` | boolean | 是否切分阶段 / Defines a stage boundary |
| 5 | `s_dm` | `u32`, `0..S` | 对应路线里程 / Associated route distance |
| 6 | `actual_lat_e7` | `i32`, latitude range | 地标实际纬度 / Actual landmark latitude |
| 7 | `actual_lon_e7` | `i32`, longitude range | 地标实际经度 / Actual landmark longitude |

事件按 `(s_dm, event_id)` 数值升序排列。必须恰有一个 start 和一个 finish，分别位于数组首末、里程 0 和 `S`，且均为阶段边界。所有边界里程必须严格递增，并在 `GEOM` 及存在时的 `ELEV` 中具有精确匹配节点。实际地标坐标的范围与 `GEOM` 相同，但不要求位于路线节点上。

Events are sorted numerically by `(s_dm, event_id)`. Exactly one start and one finish are required, first and last in the array, at 0 and `S`, both stage boundaries. Boundary distances MUST strictly increase and exactly match nodes in `GEOM` and, when present, `ELEV`. Actual landmark coordinates use the same ranges as `GEOM` but need not coincide with route vertices.

`CP` 为检查点，`water` 为补水点，`POI` 为其他兴趣点。重复经过同一地点必须使用不同事件 ID 和对应里程；同地点起终点也为两个事件。名称或编号不决定经过顺序。

`CP` denotes a checkpoint, `water` a water station, and `POI` another point of interest. Repeated visits to one location MUST use distinct event IDs and corresponding distances; a shared start/finish location still has two events. Names or labels do not determine traversal order.

### 7.6 阶段缓存 / Stage cache

| Key | Field | Type | 定义 / Definition |
|---:|---|---|---|
| 0 | `from_event_id` | positive `u32` | 起始边界事件 / Starting boundary event |
| 1 | `to_event_id` | positive `u32` | 下一边界事件 / Next boundary event |
| 2 | `min_h_dm` | conditional `i32` | 阶段最低高程 / Minimum stage elevation |
| 3 | `max_h_dm` | conditional `i32` | 阶段最高高程 / Maximum stage elevation |

`stages` 可以整体省略。存在时必须按顺序完整覆盖所有相邻边界对，数量等于边界数减一；不得部分缓存。存在 `ELEV` 时，键 2、3 均必须存在，并等于闭区间内 `ELEV.h_dm` 的精确最小值和最大值；否则两键均须省略。阶段距离、上升和下降由边界里程及剖面查询推导，不另行定义重复字段。

`stages` MAY be omitted entirely. If present, it MUST cover all consecutive boundary pairs in order, with count equal to boundary count minus one; partial caches are prohibited. With `ELEV`, keys 2 and 3 MUST both be present and equal the exact minimum and maximum `ELEV.h_dm` in the closed interval; otherwise both MUST be absent. Stage distance, ascent, and descent are derived from boundary distances and profile queries, without separately defined duplicate fields.

<a id="gidx"></a>
## 8. 几何索引 / Geometry index — `GIDX`

每条记录 32 字节，描述 `GEOM` 中的连续线段块；不是存储介质块。

Each 32-byte record describes a block of consecutive `GEOM` segments, not a storage-media block.

| Offset | Field | Type |
|---:|---|---|
| 0 | `first_node` | `u32` |
| 4 | `node_count` | `u32` |
| 8 | `s_begin_dm` | `u32` |
| 12 | `s_end_dm` | `u32` |
| 16 | `min_lat_e7` | `i32` |
| 20 | `max_lat_e7` | `i32` |
| 24 | `min_lon_e7` | `i32` |
| 28 | `max_lon_e7` | `i32` |

每块含 1–128 条线段，即 `2 ≤ node_count ≤ 129`。首块从节点 0 开始；相邻块恰好共享一个端点，满足下式；末块结束于 `GEOM` 末节点。所有线段须恰好被索引一次。起止里程必须等于块内首末节点里程。

Each block contains 1–128 segments, so `2 ≤ node_count ≤ 129`. The first block begins at node 0; adjacent blocks share exactly one endpoint as below; the final block ends at the last `GEOM` node. Every segment MUST be indexed exactly once. Distance bounds MUST equal the first and last node distances in the block.

```text
next.first_node = previous.first_node + previous.node_count - 1
```

纬度上下界必须等于块内量化顶点的最小、最大值。经度通常同理；若任一相邻节点的经度差绝对值大于 `1800000000`，经度范围必须设为 `[-1800000000,+1800000000]`。其中 `+1800000000` 仅可作索引上界，不是合法的 `GEOM.lon_e7`。

Latitude bounds MUST equal the minimum and maximum quantized vertex values in the block. Longitude normally follows the same rule. If any adjacent longitude difference has magnitude greater than `1800000000`, longitude bounds MUST instead be `[-1800000000,+1800000000]`. The positive endpoint is permitted only as an index bound, not as `GEOM.lon_e7`.

索引描述存储顶点的包围范围，不规定跨投影的精确曲线边界。使用索引筛选时，应考虑经度环绕、搜索余量及选用的线段插值模型。

The index bounds stored vertices; it does not specify exact curve bounds across projections. Filtering SHOULD account for longitude wrapping, search margins, and the selected segment interpolation model.

<a id="integrity"></a>
## 9. 完整性 / Integrity

| Parameter | Value |
|---|---|
| Algorithm | CRC-32/ISO-HDLC (IEEE CRC32) |
| Width | 32 |
| Polynomial | `0x04C11DB7` |
| Reflected polynomial | `0xEDB88320` |
| Initial register | `0xFFFFFFFF` |
| Reflect input / output | true / true |
| Final XOR | `0xFFFFFFFF` |
| Check: ASCII `123456789` | `0xCBF43926` |
| Check: empty input | `0x00000000` |

CRC 覆盖按文件顺序排列的全部 `[0,file_size)` 字节，包括目录、未知数据段和填充；仅将 `[44,48)` 的四个字节在计算时视为零。结果以小端 `u32` 存于偏移 44。验证必须同时确认实际长度等于 `file_size`。不得以包含存储 CRC 的固定残值检查替代上述流程。

The CRC covers every byte in `[0,file_size)` in file order, including the directory, unknown sections, and padding, except that bytes `[44,48)` are treated as zero during calculation. Store the result as little-endian `u32` at offset 44. Validation MUST also confirm actual length equals `file_size`. A fixed-residue check including the stored CRC MUST NOT replace this procedure.

CRC 不提供认证、保密、防篡改或防回滚；它不能替代结构和语义验证，也不能证明相同 CRC 的文件字节相同。

CRC provides no authentication, confidentiality, tamper resistance, or rollback protection. It does not replace structural or semantic validation or establish byte equality between files with equal CRCs.

<a id="conformance"></a>
## 10. 符合性与扩展 / Conformance and extensions

### 10.1 符合性与验证 / Conformance and validation

生成器必须满足本规范全部编码和语义要求。完整 V1 读取器必须理解 `META`、`GEOM`、`GIDX` 及存在时的 `ELEV`，并在接受文件前完成以下检查；不能因 CRC 正确而省略其余检查。

A producer MUST satisfy all encoding and semantic requirements. A full V1 reader MUST understand `META`, `GEOM`, `GIDX`, and `ELEV` when present, and perform the following checks before accepting a file. A valid CRC does not waive any other check.

| 类别 / Category | 必须验证 / Required validation |
|---|---|
| 容器 / Container | 标识、版本、固定值、身份、长度、唯一段类型、关键标志、布局、零填充、精确 EOF、记录大小和数量。 / Magic, versions, fixed values, identity, lengths, unique types, critical flags, layout, zero padding, exact EOF, record sizes and counts. |
| 完整性 / Integrity | 第 9 节的全文件 CRC。 / Whole-file CRC as in Section 9. |
| 元数据 / Metadata | CBOR 编码配置、类型、范围、文本和 CDDL。 / CBOR profile, types, ranges, text, and CDDL. |
| 数据 / Data | 坐标范围、里程单调性与端点、高程累计等式。 / Coordinate ranges, distance ordering and endpoints, cumulative-elevation equations. |
| 关联 / Relationships | 站点排序和边界节点、阶段缓存、ELEV 与元数据存在关系、GIDX 覆盖及包围框。 / Station order and boundary nodes, stage cache, ELEV/metadata presence, GIDX coverage and bounds. |

所有输入均须视为不可信。偏移、长度、乘积、索引及高度差必须以无溢出方式检查；不得依赖主机结构体布局或未对齐访问。读取器必须对分配、数量及 CBOR 嵌套设置资源边界，可以拒绝超过其公布限额的有效文件，但必须区分资源不足、不支持的格式与非法文件；不得静默截断或部分接受。资源限额及其协商不由本规范统一规定。

All input MUST be treated as untrusted. Offsets, lengths, products, indices, and height differences MUST be checked without overflow; host struct layouts and unaligned accesses MUST NOT be assumed. Readers MUST bound allocations, counts, and CBOR nesting, and MAY reject valid files exceeding published limits. Resource limits, unsupported formats, and invalid files MUST be distinguished; silent truncation or partial acceptance is prohibited. This specification does not standardize resource budgets or their negotiation.

### 10.2 版本与扩展处理 / Version and extension handling

| 情况 / Case | 要求 / Requirement |
|---|---|
| `major_version != 1` | V1 读取器必须拒绝。 / A V1 reader MUST reject. |
| 更高 minor / Higher minor | 不应仅因 minor 更高而拒绝；仍须满足可理解的核心规则。 / SHOULD NOT reject solely for a higher minor; understood core rules still apply. |
| 未知非关键段 / Unknown noncritical section | 通用布局及 CRC 检查后可跳过。 / MAY skip after generic layout and CRC checks. |
| 未知关键段，或无法解释其版本 / Unknown critical section or unsupported critical version | 必须拒绝。 / MUST reject. |
| `META.schema_version != 1` | 必须拒绝。 / MUST reject. |
| 已定义 map 中未知键 `0..127` / Unknown low key in a defined map | 必须拒绝。 / MUST reject. |
| 扩展键 `128..65535` / Extension key | 编码和资源验证后忽略未知值。 / Ignore unknown values after encoding and resource checks. |

major 1 内，文件头大小、目录偏移、目录项大小、全局 flags 和 reserved 规则保持不变。minor 不得改变已定义的单位、字段布局或语义；本规范定义的段版本及 META schema 均为 1。未定义的 flag 位必须拒绝。非关键扩展必须可安全忽略，不得改变已定义数据的解释；新增必需语义必须使用关键扩展或显式版本变更。

Within major 1, header size, directory offset, entry size, global flags, and reserved-field rules remain unchanged. A minor increment MUST NOT alter defined units, layouts, or semantics. Section versions and the META schema defined here are all 1. Undefined flag bits MUST be rejected. Noncritical extensions MUST be safe to ignore without changing interpretation of defined data; new mandatory semantics require a critical extension or explicit version change.

<a id="cddl"></a>
## 附录 A / Appendix A — META CDDL

CDDL 定义数据形状；正文中的确定性编码、文本限制和跨段约束仍然适用。扩展值的递归深度受读取器资源限额约束。[R4]

CDDL defines data shapes; deterministic encoding, text restrictions, and cross-section constraints in the body still apply. Reader resource limits bound recursive extension values.[R4]

```cddl
; TRL-X Route V1.0 -- META section schema.

route-meta = {
  0: 1,                                      ; schema_version
  1: name-text,                              ; name
  2: positive-u32,                           ; total_s_dm
  3: 0..1,                                  ; route_kind: open / loop
  4: 1,                                     ; coordinate_ref: WGS84 E7
  ? 5: elevation-info,
  6: preprocessing-info,
  7: [2*4096 station],
  ? 8: [1*4095 stage],
  * extension-key => extension-value
}

elevation-info = {
  0: 0..4,                                  ; source
  1: 0..3,                                  ; vertical_datum
  2: 0..2,                                  ; quality
  ? 3: detail-text,                          ; source_detail
  ? 4: short-text,                           ; datum_name
  ? 5: bool,                                ; contains_filled_values
  * extension-key => extension-value
}

preprocessing-info = {
  0: short-text,                            ; tool
  1: version-text,                          ; tool_version
  2: short-text,                            ; recipe_id
  ? 3: bstr .size 32,                       ; input_sha256
  ? 4: processing-parameters,
  * extension-key => extension-value
}

processing-parameters = {
  ? 0: u32,                                ; geometry_tolerance_dm
  ? 1: positive-u32,                       ; elevation_grid_dm
  ? 2: u32,                                ; elevation_smoothing_window_dm
  * extension-key => extension-value
}

station = {
  0: positive-u32,                         ; event_id
  1: name-text,                            ; name
  2: label-text,                           ; short_label
  3: 0..4,                                ; kind
  4: bool,                                ; stage_boundary
  5: u32,                                 ; s_dm
  6: latitude-e7,                          ; actual_lat_e7
  7: longitude-e7,                         ; actual_lon_e7
  * extension-key => extension-value
}

stage = {
  0: positive-u32,                         ; from_event_id
  1: positive-u32,                         ; to_event_id
  ? 2: i32,                               ; min_h_dm
  ? 3: i32,                               ; max_h_dm
  * extension-key => extension-value
}

u32 = 0..4294967295
positive-u32 = 1..4294967295
i32 = -2147483648..2147483647
latitude-e7 = -900000000..900000000
longitude-e7 = -1800000000..1799999999
name-text = tstr .size (1..96)
label-text = tstr .size (1..16)
short-text = tstr .size (1..64)
version-text = tstr .size (1..32)
detail-text = tstr .size (1..128)
extension-key = 128..65535

; Extension data is nonessential and MUST be safe to ignore.
; Global nesting, integer and string constraints also apply to these values.
extension-value = i32 / u32 / bool / null
                / (tstr .size (0..512))
                / (bstr .size (0..1024))
                / [* extension-value]
                / {* (0..65535) => extension-value}
```

<a id="vectors"></a>
## 附录 B / Appendix B — 参考向量 / Reference vectors

以下为完整合成文件。转储左栏为十六进制偏移，不属于文件数据；依次拼接右栏字节即可重建文件。所有查询数值以 dm 表示。

These are complete synthetic files. The left column is a hexadecimal offset, not file data; concatenating the byte columns reconstructs each file. Query values below are in dm.

| Vector | 内容 / Content | Size | Stored CRC32 | Revision |
|---|---|---:|---|---:|
| A | 含高程和阶段缓存 / With elevation and stage cache | 456 | `0xEE9C88FB` | 1 |
| B | 与 A 相同的几何和站点，不含 ELEV 及 META 键 5、8。 / Same geometry and stations as A; omits ELEV and META keys 5 and 8. | 332 | `0x55BBCE5C` | 2 |

两者 `route_id` 均为 `01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10`，`S=20000`。A 的 `ELEV` 如下；B 的高程查询应报告不可用，而不是返回零。

Both use route ID `01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f 10` and `S=20000`. A's `ELEV` is shown below. B's elevation queries report unavailable, not zero.

| `s_dm` | `h_dm` | `up_dm` | `down_dm` |
|---:|---:|---:|---:|
| 0 | 1000 | 0 | 0 |
| 5000 | 1200 | 200 | 0 |
| 10000 | 900 | 200 | 300 |
| 20000 | 1400 | 700 | 300 |

| A 查询 / A query | 结果 / Result |
|---|---|
| `H(7500), U(7500), D(7500)` | `1050, 200, 150` |
| `distance(7500,10000), ascent(7500,10000), descent(7500,10000)` | `2500, 0, 150` |
| `distance(7500,20000), ascent(7500,20000), descent(7500,20000)` | `12500, 500, 150` |
| `H(20000)` | `1400` |
| `H(20001)` | 范围错误 / Range error |

### B.1 向量 A / Vector A

```text
00000000  41 52 52 54 01 00 00 00 40 00 18 00 c8 01 00 00
00000010  40 00 00 00 04 00 00 00 01 02 03 04 05 06 07 08
00000020  09 0a 0b 0c 0d 0e 0f 10 01 00 00 00 fb 88 9c ee
00000030  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00000040  4d 45 54 41 01 00 01 00 a0 00 00 00 a2 00 00 00
00000050  00 00 00 00 00 00 00 00 47 45 4f 4d 01 00 01 00
00000060  44 01 00 00 24 00 00 00 0c 00 00 00 03 00 00 00
00000070  45 4c 45 56 01 00 01 00 68 01 00 00 40 00 00 00
00000080  10 00 00 00 04 00 00 00 47 49 44 58 01 00 01 00
00000090  a8 01 00 00 20 00 00 00 20 00 00 00 01 00 00 00
000000a0  a9 00 01 01 64 54 65 73 74 02 19 4e 20 03 00 04
000000b0  01 05 a3 00 00 01 00 02 00 06 a3 00 67 66 69 78
000000c0  74 75 72 65 01 61 31 02 69 73 79 6e 74 68 65 74
000000d0  69 63 07 83 a8 00 01 01 65 53 74 61 72 74 02 61
000000e0  53 03 00 04 f5 05 00 06 00 07 00 a8 00 02 01 63
000000f0  43 50 31 02 63 43 50 31 03 02 04 f5 05 19 27 10
00000100  06 00 07 1a 00 01 5e e8 a8 00 03 01 66 46 69 6e
00000110  69 73 68 02 61 46 03 01 04 f5 05 19 4e 20 06 00
00000120  07 1a 00 02 bd cf 08 82 a4 00 01 01 02 02 19 03
00000130  84 03 19 04 b0 a4 00 02 01 03 02 19 03 84 03 19
00000140  05 78 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00000150  00 00 00 00 e8 5e 01 00 10 27 00 00 00 00 00 00
00000160  cf bd 02 00 20 4e 00 00 00 00 00 00 e8 03 00 00
00000170  00 00 00 00 00 00 00 00 88 13 00 00 b0 04 00 00
00000180  c8 00 00 00 00 00 00 00 10 27 00 00 84 03 00 00
00000190  c8 00 00 00 2c 01 00 00 20 4e 00 00 78 05 00 00
000001a0  bc 02 00 00 2c 01 00 00 00 00 00 00 03 00 00 00
000001b0  00 00 00 00 20 4e 00 00 00 00 00 00 00 00 00 00
000001c0  00 00 00 00 cf bd 02 00
```

### B.2 向量 B / Vector B

```text
00000000  41 52 52 54 01 00 00 00 40 00 18 00 4c 01 00 00
00000010  40 00 00 00 03 00 00 00 01 02 03 04 05 06 07 08
00000020  09 0a 0b 0c 0d 0e 0f 10 02 00 00 00 5c ce bb 55
00000030  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
00000040  4d 45 54 41 01 00 01 00 88 00 00 00 7e 00 00 00
00000050  00 00 00 00 00 00 00 00 47 45 4f 4d 01 00 01 00
00000060  08 01 00 00 24 00 00 00 0c 00 00 00 03 00 00 00
00000070  47 49 44 58 01 00 01 00 2c 01 00 00 20 00 00 00
00000080  20 00 00 00 01 00 00 00 a7 00 01 01 64 54 65 73
00000090  74 02 19 4e 20 03 00 04 01 06 a3 00 67 66 69 78
000000a0  74 75 72 65 01 61 31 02 69 73 79 6e 74 68 65 74
000000b0  69 63 07 83 a8 00 01 01 65 53 74 61 72 74 02 61
000000c0  53 03 00 04 f5 05 00 06 00 07 00 a8 00 02 01 63
000000d0  43 50 31 02 63 43 50 31 03 02 04 f5 05 19 27 10
000000e0  06 00 07 1a 00 01 5e e8 a8 00 03 01 66 46 69 6e
000000f0  69 73 68 02 61 46 03 01 04 f5 05 19 4e 20 06 00
00000100  07 1a 00 02 bd cf 00 00 00 00 00 00 00 00 00 00
00000110  00 00 00 00 00 00 00 00 e8 5e 01 00 10 27 00 00
00000120  00 00 00 00 cf bd 02 00 20 4e 00 00 00 00 00 00
00000130  03 00 00 00 00 00 00 00 20 4e 00 00 00 00 00 00
00000140  00 00 00 00 00 00 00 00 cf bd 02 00
```

<a id="references"></a>
## 规范性引用 / Normative references

| Ref | Document |
|---|---|
| [R1] | RFC 2119 — *Key words for use in RFCs to Indicate Requirement Levels* |
| [R2] | RFC 8174 — *Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words* |
| [R3] | RFC 8949 — *Concise Binary Object Representation (CBOR)* |
| [R4] | RFC 8610 — *Concise Data Definition Language (CDDL): A Notational Convention to Express Concise Binary Object Representation (CBOR) and JSON Data Structures* |

[R1]: https://www.rfc-editor.org/rfc/rfc2119
[R2]: https://www.rfc-editor.org/rfc/rfc8174
[R3]: https://www.rfc-editor.org/rfc/rfc8949.html
[R4]: https://www.rfc-editor.org/rfc/rfc8610.html
