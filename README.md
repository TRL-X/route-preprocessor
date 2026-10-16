# TRL-X Route Studio

通过六步引导，将 GPX/KML 转换为经过验证的 TRL-X Route `.rte` 文件。
单个 React + TypeScript + Vite 静态项目，支持中英文界面、电脑与手机完整编辑，
可直接部署到 Vercel。

## 本地运行

使用 Node.js 24（见 `.nvmrc`）和 npm：

```sh
npm ci
npm run dev
```

打开终端显示的本地地址。生成静态站点并检查构建结果：

```sh
npm run build
npm run preview
```

## 已实现

- GPX 轨迹/路线、KML LineString 与独立地标导入，多个连续段分别选择。
- 路线方向反转、显式闭合环线的起点调整、几何简化参数编辑。
- 站点添加、删除、改名、分类、阶段边界和沿线位置编辑；重复经过候选确认。
- 高程省略、源高程处理、显式高程缺口补全、距离采样和平滑；原始/处理后剖面对比。
- 地图、高程和里程游标联动；阶段距离与升降统计；处理报告下载。
- 原始模型保留、撤销、IndexedDB 本地草稿恢复，以及可取消的后台计算。
- 按路线中点与日期自动联网获取 BGS WMM2025 磁偏角；失败或离线时保持缺失，支持手动填写并写入 META 扩展键 128。
- RTE 确定性编码、完整回读校验、跨标签页的原子版本分配。

文件解析、编辑和导出在浏览器本地完成。默认磁偏角查询将路线中点坐标和日期发送给 BGS，失败时省略该字段，可切换为手动填写或不包含。底图向地图服务请求瓦片；关闭底图后
仍可使用路线与剖面。默认底图为 OpenFreeMap Liberty，可通过 `.env.example`
中的 `VITE_MAP_STYLE_URL` 替换。地图无网络或 WebGL 不可用时提供降级预览。

## 操作流程

1. 导入 GPX/KML，选择需要处理的连续路线段。
2. 在地图上确认方向和起终点，勾选路线检查确认。
3. 检查有序站点；出现多个经过位置时，选择候选并确认。
4. 选择高程策略。默认不使用不完整或基准不确定的高程；需要时明确选择缺口补全。
5. 联动预览，查看阶段统计、原始高程对比和处理提示。
6. 导出 `.rte`。文件必须通过结构、编码、CRC 和跨段语义校验后才能下载。

同一内容重复导出保持相同字节及版本；内容变化递增 revision。版本分配通过
IndexedDB 事务在标签页之间协调。本地存储不可用时，每次导出使用全新的路线标识，
并在界面提示，避免复用无法可靠追踪的身份。浏览器草稿按设备及站点保存。

## 测试

```sh
npm run typecheck
npm test
npx playwright install chromium webkit
npm run test:e2e
```

单元测试覆盖规范附录 A/B 文件向量、损坏数据、量化和跨段关系、真实样例处理、
高程与阶段统计及多标签页版本分配。Playwright 覆盖桌面 Chromium、iPhone 尺寸
Chromium 和 WebKit，包括文件导出后的解码检查；移动视口与 WebKit 测试不等同于
真实 iPhone 硬件测试。GitHub Actions 配置执行类型检查、单元测试、构建与浏览器测试。

[2026MY 样例集](tests/fixtures/routes/2026MY/README.md)包含四组路线的 GPX/KML
原文件，共 8 份，并附 SHA-256 与原始观测清单。它们位于测试目录，未加入网站静态资源。

## 部署到 Vercel

导入此 Git 仓库，使用以下设置；仓库已提供 `vercel.json`：

| 设置 | 值 |
|---|---|
| Framework Preset | Vite |
| Root Directory | 仓库根目录 |
| Node.js | 24.x |
| Install Command | `npm ci` |
| Build Command | `npm run build` |
| Output Directory | `dist` |

本项目只需要静态托管。当前应用在根路径内切换步骤，无额外页面路由重写。
地图配置为可选项，默认服务无需项目密钥；`VITE_` 配置会进入浏览器构建产物。

参考：[Vite 静态部署](https://vite.dev/guide/static-deploy.html)、
[Vite on Vercel](https://vercel.com/docs/frameworks/frontend/vite)、
[OpenFreeMap](https://openfreemap.org/quick_start/)。

## 代码与规范

```text
src/
  app/          引导状态、Worker 通信、本地草稿和版本分配
  components/   地图与高程图
  features/     按流程组织的界面组件
  i18n/         国际化配置和独立语言资源
  core/         模型、解析、预处理、CBOR/RTE 编解码与校验
  workers/      文件解析、路线处理和导出任务
tests/
  unit/         核心算法、格式与存储测试
  e2e/          完整浏览器操作流程
  fixtures/     原始样例与清单
docs/           格式规范、架构与处理策略
```

`src/core` 独立于 React、DOM 和地图 SDK。依赖和 npm 锁文件在根目录统一维护。

- [文件格式规范（中英双语）](docs/TRL-X_Route_V1_Specification_ZH_EN.md)：格式 1.0，文档修订 0.3，Draft。
- [架构说明](docs/architecture.md)
- [预处理规则与限额](docs/preprocessing.md)
- [国际化维护说明](docs/i18n.md)：新增语言、插值、复数、回退和数字格式。

格式规范变更须同步更新实现、符合性测试和参考向量，并记录兼容性影响；文档修订
与文件格式版本分别管理。预处理参数和界面选择另行记录，不改变规范的字段解释。

## 当前边界

首版处理连续路线，包含离线几何预览；不自动连接断开的源路线段，也不调用 DEM
补全高程。明确选择缺口补全后，内部缺口按里程插值，端点缺失使用最近的已知高程；
超过 100 米的缺口仅提示，不阻止导出。全程无已知高程时可改为不包含高程。基准里程采用固定球半径的水平大圆距离，算法口径见处理文档。
完整离线网页安装、云端同步、设备连接和现场导航不属于当前版本。
