# 工程架构与维护约定

本项目是一个 **React + TypeScript + Vite 的静态单页应用**，根目录一份 `package.json`，没有 monorepo/workspace、多包构建、服务端渲染或业务后端。构建命令为 `npm run build`，静态产物在 `dist`，可作为 Vercel 的 Vite 项目部署。构建目标为 ES2022。

产品面向全球用户，提供英文/中文界面；手机和电脑共用同一套编辑数据与操作，不单独维护移动端业务逻辑。核心算法不依赖 React、地图 SDK 或浏览器 DOM。

## 目录与依赖方向

| 位置 | 职责 |
|---|---|
| `src/App.tsx` | 六步引导、编辑状态、撤销、用户确认、异步任务协调及下载。 |
| `src/app/flow.ts` | XState 管理 import / route / stations / elevation / preview / export 的当前步骤。 |
| `src/app/worker-client.ts` | 创建单次 Worker 任务、接收结果、结束或取消 Worker。 |
| `src/app/drafts.ts` | IndexedDB 草稿保存及跨标签页的导出修订号预留。 |
| `src/features/import`、`src/features/review` | 导入入口、处理提示与阶段列表，通过类型明确的属性接收数据和回调。 |
| `src/components/RouteMap.tsx` | MapLibre 地图、路线/站点显示、触控与鼠标游标交互。 |
| `src/components/ElevationChart.tsx` | 高程与进度显示、游标联动；不改写计算剖面。 |
| `src/workers/route.worker.ts` | import / reference / process / export 的任务边界。 |
| `src/core/types.ts` | 源数据、参考里程、编辑站点和 RTE 数据的共享类型；字段名称标明单位。 |
| `src/core/import.ts` | 纯 XML 导入与源文件预算检查，唯一第三方运行时算法依赖为 `fast-xml-parser`。 |
| `src/core/process.ts` | 方向、连续重复点、里程、关联、几何、高程和阶段处理。 |
| `src/core/cbor.ts`、`rte.ts` | 受限确定性 CBOR、RTE 编解码、严格验证、剖面查询。 |
| `tests/unit` | 核心算法、格式向量与异常输入、草稿/修订号逻辑。 |
| `tests/e2e` | Playwright 用户流程测试。 |
| `tests/fixtures` | 回归样例及字节身份清单，不作为网页静态资源。 |
| `docs` | 格式规范、当前实现策略及架构说明。 |

依赖方向为 UI → Worker 任务 / 核心类型；Worker → core；core → 类型及 XML 解析器。`process.ts` 复用 `import.ts` 的名称清洗函数，因此它间接依赖 XML 模块，但不会读取 DOM。`core` 不读取地图坐标、不使用 IndexedDB，也不负责文件下载或身份持久化。

界面组件使用 Radix Dialog、Lucide 图标、Tailwind/CSS；地图组件单独使用 MapLibre。添加 UI 功能时优先复用已建立的字段、按钮和面板样式，业务规则继续由 core 检查。

## 数据流与状态

```text
文件字节 ── SHA-256 / 文本解码 ── import Worker
                                     │
                              ImportedFile + 段选择
                                     │
                            buildReference + createStations
                                     │
                         Editor：参数、名称、站点、方向
                                     │
                             process Worker（防抖）
                                     │
                             ProcessingResult
                                     │
                  导出确认 → encodeRte → decodeRte → 下载
```

导入后保留解析后的源点与地标，编辑参数和结果分开表达。方向或环线起点改变时重新构建 reference 与站点关联，避免旧里程和旧候选继续生效。原始输入 SHA-256 记录在编辑模型与导出元数据中；本地草稿保存解析后的数据，不保存原始输入字节副本。

XState 当前仅管理步骤导航。业务有效性由 `processRoute`、当前任务状态及用户确认共同控制，而不是假设“进入导出页就已合法”。导出要求最新编辑版本已处理完成、没有阻塞错误、没有在途任务，并已确认路线与方向。站点的 `confirmed` 单独参与处理门控。

参数和站点修改触发 120 ms 防抖处理；旧任务终止，旧结果通过活动标记及编辑对象身份检查丢弃。每个任务拥有自己的 Worker，完成后销毁；取消直接 `terminate()`，不要求同步算法在循环中轮询取消信号。界面提供任务级忙碌状态与取消，不提供算法内部百分比进度。

编辑历史在内存中保留最近 25 个修改前状态供撤销，不保存到草稿。草稿更新以 500 ms 防抖写入 IndexedDB；恢复入口由应用显示。本地保存失败会显示状态，不能被视为已持久保存。

## 文件身份与修订号

首次导入为编辑项目生成随机 16 字节 `routeId`。身份规则仍是规范要求：同一 `(route_id, revision)` 必须对应完全相同字节。

导出先以固定 `revision: 1` 编码并严格回读，计算规范化字节的 SHA-256，再使用 IndexedDB 的 `exports` store 预留实际修订号。`readwrite` 事务对同一源站的多标签页串行化：若内容哈希与最近导出相同则复用修订号，否则递增。旧内容在其他内容之后重新导出可以得到新的修订号。预留成功后编码/下载失败可以留下一段未使用的修订号，不回退复用。

达到 `0xffffffff` 时抛出 `RevisionExhaustedError`，要求重新导入成新路线。若持久存储不可用，应用为该次下载另生成新的路线身份并使用 revision 1，界面明确提示；不会冒用无法可靠预留修订号的旧身份。该策略不提供跨浏览器、跨设备或清除站点数据后的身份协调。

## 错误边界与实现预算

导入及不合法的参考路线操作抛出普通 `Error`，消息描述 XML、资源预算或操作前置条件。常规预处理问题返回 `ProcessingIssue`：

- `code` 是稳定的机器可读分类。
- `severity: 'warning'` 提醒核对或解释处理结果；`'error'` 阻止生成 `RouteData`。
- `message` 为英文；已本地化的处理问题另有 `messageZh`。
- 可选 `s` 为参考里程，供界面定位。

RTE/CBOR 使用 `RteError`，分类如下：

| `code` | 含义 |
|---|---|
| `invalid` | 文件布局、数据取值、CRC 或跨段语义不合法。 |
| `unsupported` | 当前实现不能解释的主版本、schema、段版本或关键段。 |
| `resource` | 超过当前读取器/编码器资源预算，不代表格式本身不允许。 |
| `unavailable` | 请求高程查询时没有完整 `ELEV`。 |
| `range` | 剖面查询里程超出范围。 |

Worker 对抛出的异常返回 `{ ok: false, error: message }`，当前不跨 Worker 传递 `RteError.code`；`ProcessingResult` 中的结构化 issues 则完整返回。取消由客户端使用 `AbortError` 表示。

RTE 当前预算为单文件 64 MiB、目录 256 项、GEOM/ELEV/GIDX 各 1,000,000 条记录；CBOR 为 8 MiB、深度 16、总 item 200,000、单容器 100,000 项。它们与导入/预处理预算分开维护，并与规范允许的最大范围区分。实际应用的 GEOM/ELEV 生成预算更小，见 [预处理策略](preprocessing.md)。

## 外部资源与显示边界

路线解析、计算和 RTE 生成在浏览器内完成。应用没有上传路线文件的业务 API。默认底图样式为 OpenFreeMap Liberty，可通过构建环境变量 `VITE_MAP_STYLE_URL` 替换；启用底图时浏览器仍会请求第三方地图样式、瓦片或字体等资源。底图关闭后使用空白样式显示本地路线；这不等同于完整离线应用，项目没有预缓存网页资源的 Service Worker。

MapLibre 的显示世界副本、日期变更线展开和 Mercator 纬度限制只影响显示。原始/参考坐标和 RTE WGS84 E7 值不因此改变。剖面显示依赖计算结果，不能用显示抽稀数据重算累计升降。

## 规范、样例与维护

`docs/TRL-X_Route_V1_Specification_ZH_EN.md` 是用户提供的草案规范副本，目前为格式 1.0 / 文档修订 0.2。格式变更、处理策略变更和 UI 变更分别记录，不能仅因实现方便改变规范字段含义。

8 份 `2026MY` GPX/KML 来自用户提供目录；[样例说明](../tests/fixtures/routes/2026MY/README.md)和 [manifest](../tests/fixtures/routes/2026MY/manifest.json)保存来源、大小、SHA-256 与原始观测。文件中的 `creator` 指向 ovitalmap，KML `author` 为空；在当前样例与规范文档中未发现明确许可证声明，这些元数据不作为许可授权的替代。应用运行时不引用这些文件，也不将它们复制到 `public` 或 `dist`。

格式测试使用规范参考向量与损坏输入；处理测试验证真实样例和有明确预期的合成路线；存储测试验证草稿与修订号预留。运行 `npm test` 和 `npm run typecheck` 验证核心改动，运行 `npm run build` 验证静态产物。涉及交互的修改再运行对应 Playwright 测试。这里描述的是职责和测试范围，不替代具体浏览器或设备上的验收记录。
