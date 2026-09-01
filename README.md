# Music Wall（Obsidian 音乐墙插件）

在 Obsidian 里用一面「唱片墙」收藏与播放网易云音乐专辑。每张唱片可用
黑胶 / CD / 磁带 / 纯封面 四种带纹理的样式呈现，点击呼出详情确认后唤起
网易云客户端播放。数据以 `.mw`（JSON）文件存于你的库中，可导入导出、走 Git 共享。

## 功能概览

- **文件即视图**：像新建 md 一样新建 `.mw` 文件，点开即渲染音乐墙（自定义 ItemView）。
- **四种唱片样式**：纹理清晰、悬停动效（黑胶滑出旋转、CD 衍射自转、磁带双轮转动、封面抬升高光），支持全局默认 + 单卡覆盖。
- **详情面板**：左样式预览 / 右 metadata，可就地切换样式；搜索添加与播放前确认**共用同一组件**。
- **搜索导入**：模态框搜索专辑 → 选结果 → 详情确认 → 自动抓取完整元数据。
- **右键新建 / 删除**：库文件列表右键文件夹即建「新的音乐墙.mw」并打开；卡片悬停 ✕ 或右键删除，均有确认框。
- **锁定语义**：锁定项禁编辑元数据（仍显示/可播放/可换样式/可删除）；解锁后可改。
- **筛选 / 排序 / 搜索**：按艺术家、年份、标签筛选；按名称/艺术家/年份/添加时间排序；纯前端状态不写入文件。
- **响应式**：网格宽度随屏幕 `auto-fill` 自适应。
- **导入 / 导出 / Git 导入**：导入与 Git 导入在覆盖既有文件前弹确认框；Git 拉取仅桌面端。
- **播放**：`orpheus://<Base64(JSON)>` 唤起客户端（协议格式经 2026 开源实现核对）。
  配置 **网易云 Cookie** 后：播放时自动创建/复用私密中转歌单「Music Wall 临时播放」（不占用已有歌单），
  把整张专辑写入该歌单并切歌单连播；也可在设置中手动指定/「从账号选择」目标歌单。
  未配置 Cookie 时降级为播放第一首，最终兜底打开网页链接。

## 开发

```bash
npm install
npm run dev          # esbuild watch（JS + CSS）
npm run typecheck    # tsc --noEmit
npm run build        # 生产构建：main.js + styles.css
```

产物 `main.js`、`styles.css`、`manifest.json` 即插件运行所需；开发时把整个目录
软链/拷贝到 `<vault>/.obsidian/plugins/music-wall/` 后在设置里启用。

### 自检脚本（无需启动 Obsidian）

```bash
# 加密/接口连通性（联网）
node .\node_modules\esbuild\bin\esbuild tools\netcheck.ts --bundle --platform=node --format=cjs --outfile=tools\netcheck.cjs && node tools\netcheck.cjs
# store 往返/迁移/合并
node .\node_modules\esbuild\bin\esbuild tools\storecheck.ts --bundle --platform=node --format=cjs --outfile=tools\storecheck.cjs && node tools\storecheck.cjs
# 真实 main.js 加载冒烟（mock obsidian + DOM）
node tools\bundlesmoke.cjs
```

## 架构

```
src/
  main.ts                 插件入口：注册扩展名/视图/命令/设置，导入导出与 Git 服务
  types.ts                数据契约（.mw schema、设置）
  settings.ts             设置页
  core/
    crypto.ts             网易云 linux-forward(AES-ECB) + weapi(AES-CBC+RSA NoPadding)
    metadata.ts           搜索/专辑详情/链接解析/封面尺寸（可注入 Requester）
    store.ts              .mw 读写、schema 迁移、合并去重
    playback.ts           orpheus:// 播放（歌单连播/单曲/H5 三级降级）
    playlist.ts           歌单读写（需 Cookie）：账户/选单/整专替换
    git.ts                系统 git clone/pull + .mw 扫描（仅桌面端）
  ui/
    disc.ts               唱片 DOM 构建器（网格/详情共用）
    AlbumPanelModal.ts    共享详情面板 + 播放/添加两模式模态框
    SearchAlbumModal.ts   搜索→列表→确认→添加主链路
    ConfirmModal.ts       删除/覆盖通用确认框
    EditMetaModal.ts      解锁后元数据编辑
    InputModal.ts         单行输入（新建/命名/链接）
    smallModals.ts        ChoiceModal / PickerModal
    MusicWallView.ts      音乐墙 ItemView（工具栏/网格/筛选排序/右键/自动刷新）
  styles/                 base + vinyl + cd + cassette + cover + modals（构建合并为 styles.css）
```

## 已知限制与风险

- **orpheus:// 协议**需在你机器上真机验证一次；若客户端版本协议不同，只需改
  `src/core/playback.ts` 的 `buildCandidates` 候选链。最终会降级到打开专辑网页链接。
- **iOS** 只能尽力唤起 App，可能无法精确切列表；**Git 导入**仅桌面端。
- 网易云接口若触发风控/字段变更，`metadata.ts` 已把解析字段映射集中，易修；元数据快照
  存于 `.mw`，断网仍可展示。

## 双端手工验收清单

桌面端（Win/mac/Linux）：
- [ ] 新建 `.mw` 文件 → 点开渲染为音乐墙
- [ ] 搜索导入：搜「范特西」→ 列表 → 选一张 → 详情面板 → 确认添加 → 出现唱片且已锁定
- [ ] 手动添加：粘贴专辑链接 → 添加 → 未锁定；右键上锁后元数据只读
- [ ] 四种样式切换（工具栏全局 + 右键单卡），纹理与悬停动效正常
- [ ] 点击唱片 → 播放确认面板 → 播放：成功唤起网易云并播放该专辑（未装则 H5 降级）
- [ ] 筛选/排序/搜索按 metadata 生效
- [ ] 导出分享副本；导入外部 `.mw`（覆盖弹确认）
- [ ] Git 导入：仓库含 `.mw` → 拉取 → 选择 → 写入（同名覆盖弹确认）
- [ ] 删除唱片弹确认框

移动端（Android/iOS）：
- [ ] 打开既有 `.mw` 正常渲染；播放走唤起/H5 降级
- [ ] 搜索/手动添加可用；Git 导入入口给出「仅桌面端」提示
- [ ] 网格随窄屏自动减列；详情面板转纵向布局

## 许可

MIT
