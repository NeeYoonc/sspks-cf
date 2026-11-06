# sspks-cf — 群晖 DSM 7 套件源（Cloudflare Workers + R2 静态索引版）

把 [tbc0309/sspks-imnks](https://github.com/tbc0309/sspks-imnks)（PHP 版 SPK 套件源）的
「DSM 7 套件中心协议」搬到 Cloudflare：**索引在本地/CI 离线生成，套件与图片放 R2，
Worker 只做过滤、拼 JSON 和转发下载**。没有 PHP、没有数据库、没有常驻服务器。

```
packages/*.spk
      │  python tools/index.py
      ▼
dist/index.json + dist/icons/*.png
      │  --upload（AWS SigV4，或 rclone）
      ▼
┌──────────────────────────────┐
│ R2 bucket                    │
│   spk/index.json             │
│   spk/icons/*.png            │
│   spk/packages/*.spk         │
└──────────────┬───────────────┘
               │ R2 binding
┌──────────────▼───────────────┐
│ Worker (src/worker.js)       │
│  GET /?unique=synology_...   │ ← DSM 7 套件中心
│  GET /packages/*.spk         │ ← DSM 下载 / 浏览器
│  GET /icons/*.png            │
│  GET /                       │ ← 极简套件列表页
└──────────────────────────────┘
```

## 与 PHP 版的差异

| 能力 | PHP 版 sspks-imnks | 本方案 |
| --- | --- | --- |
| 运行环境 | PHP 8.4-FPM + Nginx + SQLite/MySQL | Cloudflare Worker + R2 |
| 索引 | 网页里点「更新索引」，增量 + 断点恢复 | 离线生成 `index.json`，`--upload` 上传 |
| 管理界面 | 有（密码 + 隐藏入口） | **没有**，改动靠本地脚本 |
| 网页 UI | 21 语言、Material、广告轮播、机型筛选页 | 极简列表页（只用于自检） |
| 官方加密 SPK（keytype 3） | 支持（libsodium） | **不支持**，索引时跳过并告警 |
| 下载量统计 | 占位值 | 占位值 |
| 费用 | VPS | 免费额度内 0 元（见「费用」） |

DSM 7 套件中心的响应格式、字段、过滤语义（机型/架构/DSM 版本/渠道、同包多版本去重、
`synology_<arch>_<model>` 的 model 匹配）全部照抄 PHP 版实现，测试里保留了它的回归向量。

## 前置条件

- Cloudflare 账号，已开通 R2（免费额度即可）
- Node.js 18+（部署用 Wrangler）
- Python 3.9+（生成索引，只用标准库）
- 要发布的 `.spk` 文件（DSM 7、`os_min_ver >= 7.0-40000`）

## 快速开始

### 1. 安装依赖并创建 bucket

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create sspks
```

### 2. 放入套件并生成索引

```bash
# 把 xxx.spk 放进 packages/
python tools/index.py --pretty
```

输出：

- `dist/index.json`：所有套件元数据（Worker 的输入）
- `dist/index.report.json`：每个文件的结果（成功/跳过及原因）
- `dist/icons/`：从 SPK 提取的图标与截图（没有图标时用内置默认图）

可选：复制 `sspks.config.json.example` 为 `sspks.config.json`，设置
`defaults.maintainer`、`defaults.distributor` 等兜底字段（INFO 里没有时使用）。

### 3. 上传到 R2

三种方式任选一种。

**方式 A：复用 `wrangler login`（不用另外创建 R2 API Token）**

Wrangler 的 OAuth 登录本身就能写 R2，索引器可以直接调它：

```bash
npx wrangler login

python tools/index.py --upload \
  --upload-backend wrangler --bucket sspks \
  --wrangler-cmd "npx wrangler"
```

每个对象执行一次 `wrangler r2 object put ... --remote`，对象多时较慢（约 1–2 秒/个），
适合几十个包；该后端不支持 `--skip-existing`。可先加 `--dry-run` 看要执行的命令。

**方式 B：R2 S3 API（批量、支持跳过未变化对象）**

在 Cloudflare 控制台 **R2 → Manage R2 API Tokens** 创建 *Object Read & Write* 令牌，
拿到 Account ID、Access Key ID、Secret Access Key：

```bash
export R2_ACCOUNT_ID=xxxxxxxx
export R2_ACCESS_KEY_ID=xxxxxxxx
export R2_SECRET_ACCESS_KEY=xxxxxxxx
export R2_BUCKET=sspks

python tools/index.py --upload --dry-run   # 先看上传计划
python tools/index.py --upload             # 索引 + 图标 + 所有 spk
```

PowerShell：

```powershell
$env:R2_ACCOUNT_ID="xxxxxxxx"
$env:R2_ACCESS_KEY_ID="xxxxxxxx"
$env:R2_SECRET_ACCESS_KEY="xxxxxxxx"
$env:R2_BUCKET="sspks"
python tools/index.py --upload
```

`--skip-existing` 会先 HEAD 查询，大小一致的对象不再重复上传（适合几百 MB 的 SPK）。

**方式 C：rclone**

```bash
rclone copyto dist/index.json r2:sspks/spk/index.json
rclone copy dist/icons r2:sspks/spk/icons/
rclone copy packages r2:sspks/spk/packages/ --include "*.spk"
```

### 4. 部署 Worker

编辑 `wrangler.toml` 里的 `bucket_name`（默认 `sspks`），然后：

```bash
npx wrangler deploy
```



Wrangler 会打印 `https://sspks-cf.<你的子域>.workers.dev`。想用自定义域名（需要域名托管在
Cloudflare，例如 `packages.example.com`）就在 `wrangler.toml` 里声明，并同时把
`BASE_URL` 固定成它，这样不管从哪个域名访问，返回给 DSM 的链接都一样：

```toml
routes = [
  { pattern = "packages.example.com", custom_domain = true }
]

[vars]
BASE_URL = "https://packages.example.com/"
```

> 本仓库部署的实例就是 `https://ssp.dnof.net/`（`workers.dev` 保留作调试入口）。

### 5. 验证

```bash
# 模拟 DSM 7 套件中心的请求，应返回 {"packages":[...]}
curl "https://ssp.dnof.net/?unique=synology_apollolake_ds918%2B&arch=apollolake&major=7&minor=2&build=69057&package_update_channel=stable&language=chs"

# 浏览器打开根路径可以看到极简套件列表（顶部有搜索框，可按名称/描述/版本过滤）
```

### 6. 在 DSM 里添加套件源

套件中心 → **设置 → 套件来源 → 新增**：名称任意，位置填 `https://ssp.dnof.net/`
（必须带末尾 `/`，必须是 HTTPS）。

> DSM 会提示「此套件来源不是由 Synology 提供」，确认即可。

### 7. 日常更新

```bash
# 1) 把新 .spk 放进 packages/
python tools/index.py --upload
```

索引在 Worker 里有 1 分钟内存缓存；同步后最多 1 分钟生效。

## 服务端自动同步（多 Release 仓库）

Worker 可以同时跟随多个 GitHub 仓库的 Release：只要 Release 里有 `.spk` 资产，Cron 就会
把它们合并同步进 R2（仓库有 `sspks-index.json` 时优先用 bundle，没有就自动解析 SPK）。

当前源（两个仓库都**没有** `.sspks/`，也不需要任何发布 workflow）：

| 仓库 | 套件 | 同步方式 |
| --- | --- | --- |
| [NeeYoonc/dsh-nas](https://github.com/NeeYoonc/dsh-nas) | DeepSeek Harness NAS | Worker 自动解析 Release 的 SPK |
| [NeeYoonc/bili-sync-up](https://github.com/NeeYoonc/bili-sync-up) | Bili Sync Up | Worker 自动解析 Release 的 SPK |

另外通过 `SPK_HOSTS` 直接镜像一个**非 GitHub 的套件源**：Lucky 的官方源
（下载走镜像 `https://lucky666.cn/spk`，主站 `https://release.66666.host/spk` 内容
完全一致；原因见下面「非 GitHub 源」）。

```
DSM 7 ──套件中心查询──► Worker ──读──► R2  spk/index.json（多源合并后的索引）
DSM 7 ──下载 spk──────► Worker ──流式──► R2  spk/packages/*.spk
                        ▲
                        │ Cron Trigger（每 5 分钟）
                        │
   dsh-nas / bili-sync-up Release：*.spk（无需索引文件）
```

**仓库侧零改动**：Worker 直接解析 SPK —— 用 GitHub HTML 页面发现资产（不调 REST API）、
R2 Range 读 tar 头拿 `INFO` 与图标、R2 ETag 取 md5（详见下面「没有 bundle 也能同步」）。

Worker 侧 `src/sync.js` 的 Cron 每 5 分钟：

- 依次处理每个源：先试 `https://github.com/<repo>/releases/latest/download/sspks-index.json`，
  没有就自动解析该 Release 的 SPK
- 所有源 tag（自动模式还含资产列表）+ extra 签名与 `spk/.synced-release` 相同 → 直接退出
- **合并规则**：按套件名合并，先配置的源优先；同一套件出现在多个源时取第一个
- 某个源暂时不可用（发版窗口 / 资产还没上传）→ 跳过该源，并**沿用旧索引里属于它的记录**，
  不会误删已同步的包；所有源都不可用才报错，不发布空索引
- 有新内容时把 SPK 从 GitHub 资产 CDN **流式**写入 R2（HEAD 比大小，已在且大小相同则跳过），
  写图标 + `spk/index.json`，清理旧版本对象，最后写标记
- 全程**不调用 GitHub REST API**：Workers 的共享出口 IP 匿名调用 API 会撞 60 次/小时限流
  （实测 403），`releases/latest/download/` 是普通 CDN 链接，没有这个问题

`/health` 返回 `release`（第一个源）、`sources`（每个源的 tag / 状态）与 `last_sync`；
`/sync` 可手动触发。

### 没有 bundle 也能同步（自动解析，默认）

`sspks-index.json` **不是必需的**（现在两个源都没用它）：Worker 默认走「自动解析」模式，
直接从 GitHub Release 的 SPK 里读元数据，仓库侧零改动。若某个仓库仍然发布 bundle，
Worker 会优先用 bundle（更快、更稳）。

自动模式做的事（全部在 Worker 内完成）：

1. **发现 Release**：不用 REST API —— `releases/latest` 的 302 拿 tag，
   `releases/expanded_assets/<tag>` 的 HTML 里找 `*.spk` 资产（避开 Workers 共享 IP 的 API 限流）
2. **流式入库**：SPK 从 GitHub CDN 直接写进 R2
3. **回读解析**：用 R2 Range 读 tar —— `INFO`（包名/版本/描述/arch/os_min_ver/…）、
   `PACKAGE_ICON.PNG` / `PACKAGE_ICON_256.PNG`（72/120 图标）、`conf/privilege`（run-as root）、
   `screen_*.png`、`WIZARD_UIFILES`（决定 qinst/qstart/qupgrade 默认值）
4. **md5**：R2 对单段上传的对象把 MD5 放在 ETag 里，直接取用（Web Crypto 没有 MD5，
   171 MB 也不该在 Worker 里哈希）

两种模式对比：

| | bundle 模式（可选，有 `sspks-index.json`） | 自动解析模式（默认，没有 bundle） |
| --- | --- | --- |
| 仓库侧改动 | 需要 `.sspks/` + 一个 workflow | **零改动** |
| 每次同步开销 | 拉一个 ~70 KB 的 bundle | 解析 2 个 SPK 的 tar 头 + 图标（几十次 Range 读） |
| 健壮性 | 高（元数据由 CI 生成） | 中（依赖 GitHub HTML 页面结构 + ETag=MD5） |
| md5 来源 | CI 计算的精确值 | R2 ETag（单段上传） |

实测：把 bili-sync-up `v3.1.6` 的 `sspks-index.json` 资产删掉后强制同步，Worker 自动解析出
两条记录，md5 与 bundle 版本完全一致（`f84789089719c4c4…` / `6f0166f24dc3…`），
DSM 端链接、下载、计数全部正常。

> 现在线上两个源都走自动解析（仓库里没有 `.sspks/`、没有额外 workflow，Release 里也没有
> `sspks-index.json`）。以后想加 bundle 也随时可以，Worker 会自动优先使用。

### 配置与运维

| 项 | 说明 |
| --- | --- |
| `DSH_REPOS` | `wrangler.toml` 的 `[vars]`，逗号分隔的仓库列表（默认 `NeeYoonc/dsh-nas`） |
| `DSH_REPO` | 单仓库旧变量，仍兼容 |
| `SPK_HOSTS` | 非 GitHub 源：逗号分隔的标准 Package Center 地址（见下节），如 `https://lucky666.cn/spk` |
| 仓库需**公开** | Worker 读 Release 资产不带 token。若私有：`wrangler secret put GH_TOKEN` |
| `SYNC_TOKEN` | 手动同步用：`wrangler secret put SYNC_TOKEN`，然后 `curl -H "x-sync-token: …" https://<worker>/sync` |
| 强制重跑 | `/sync?force=1` |
| 下载兜底 | 同步还没写完时，DSM 下载会回源该记录所属的 GitHub Release 资产，不会 404 |
| `sspks-index.json` | **可选**：有就用（快、稳）；没有则 Worker 自动解析 SPK（见上） |

**接入新的源**（仓库不用改任何东西）：

1. 确认 Release 里有 `.spk` 资产（文件名以 `.spk` 结尾）
2. `wrangler.toml` 的 `DSH_REPOS` 追加仓库名，`npx wrangler deploy`
3. 等一次 cron（≤5 分钟）或 `curl -H "x-sync-token: …" https://<worker>/sync`

> 仓库如果愿意额外发布 `sspks-index.json`（bundle 模式），Worker 会优先用它；
> 不发布就自动解析，两种都能用。

### 非 GitHub 源（厂商自己的套件源）

有些套件不在 GitHub 发版，而是厂商自己维护一个 DSM 套件源。典型例子是 Lucky：
主站 `https://release.66666.host/spk` 和镜像 `https://lucky666.cn/spk` 都提供标准
Package Center 接口（同一批文件、md5 一致）。把地址填进 `wrangler.toml` 的 `SPK_HOSTS`
（逗号分隔）即可，Worker 会在每轮 cron 里把它当成一个普通源来镜像：

```toml
[vars]
SPK_HOSTS = "https://lucky666.cn/spk,https://packages.synocommunity.com/"
```

当前配置了两个源：

| 源 | 包数量 | 体积 | 说明 |
| --- | --- | --- | --- |
| Lucky（`lucky666.cn/spk`） | 14（7 变体 × 2 架构） | ~290 MB | 主站 `release.66666.host` 内容一致但 Cloudflare 访问只有 ~0.7 MB/s，镜像 ~3.5 MB/s |
| SynoCommunity（`packages.synocommunity.com`） | 296（x86_64 + armv8 去重） | **~7.1 GB** | DSM7 全量社区包；全量镜像后整个 R2 约 7.9 GB（免费额度 10 GB） |

> 主站 `release.66666.host` 可以同时直接加进 DSM 作为第二套件源。

工作方式（`src/sync.js` 的 `loadHostSource` / `syncHostSource`）：

1. **发现**：对每个架构家族（目前 `x86_64`、`armv8`）发一次标准 Package Center 查询
   （`?unique=synology_<arch>_<model>&arch=…&major=7&…`，响应只有 ~9 KB），
   拿到该源当前最新的包列表（`package` / `version` / `link` / `md5` / `size`）。
2. **镜像**：把列出的 SPK 下载进 R2。大文件用 **6 MiB Range 分块**顺序拉取并**流式**
   写入 R2（不把整个包读进内存——SynoCommunity 最大的包 147 MB，超过 Worker 128 MB 内存上限）；
   有的 CDN 对整包 GET 限速，但对短 Range 响应给满速。
3. **索引**：用与 GitHub 自动模式相同的解析器读回 R2 里的 SPK（`INFO`、图标、md5），
   合并进 `spk/index.json`；与 GitHub 源按套件名去重，先配置的源优先。
4. **容错**：源暂时不可用（查询失败/返回空）时沿用上一版属于它的记录，不会误删；
   下次 cron 自动重试。marker 里带每个包的 `文件名:md5`，同版本重推也能发现。
5. **串行**：一次同步可能下载几百 MB、耗时超过 5 分钟的 cron 间隔。Worker 用
   `spk/.sync-lock`（20 分钟 TTL，每个包处理完续期）保证同一时间只有一个同步在跑；
   重叠的 cron 会直接返回 `busy`，不会重复下载。`/health` 的 `last_sync.status` 可见。
6. **分批**：包多/体积大的源（如 SynoCommunity 298 个包）每个 cron 只镜像
   `HOST_BATCH_FILES`（默认 60）个，进度写在 `spk/.host-sync-state.json`，没跑完前索引
   保持上一版（`/health` 显示 `status: partial` 和 `progress: {done,total,pending}`）；
   跑完后一次性发布索引。版本更新时 md5 未变的包会复用旧记录，不重复下载。
7. **容错**：解析失败的包重试 3 次后记入 `failed`（不影响其它包和整体发布）；
   tar 头/INFO/图标在流式下载过程中顺带解析，不需要二次读 R2。

注意：

- 只覆盖本项目模型表支持的架构家族（`x86_64`、`armv8`）；其他架构的包不会被查询到。
- 官方加密 SPK（keytype 3）仍然不支持（解析时会跳过）。
- 每轮 cron 只多花 2 个 ~9 KB 的查询；只有版本/md5 变化时才会真正下载 SPK。
- **R2 容量**：全部源全量镜像后约 7.9 GB（314 个 SPK），免费额度 10 GB，注意留余量。

### 备选：本地脚本

`scripts/sync-latest-release.sh` / `.ps1` 做同样的事：读最新 Release → 下载 SPK → 重建索引 →
上传 R2（`wrangler` 后端或 S3 后端）。适合手动补一次或 Worker 出问题时兜底：

```bash
scripts/sync-latest-release.sh --dry-run   # 看会做什么
scripts/sync-latest-release.sh             # 立即同步一次
```

也可以注册成 Windows 计划任务（入口 `scripts/sync-task.cmd`，日志在 `logs/sync.log`）。

### 下载缓存：干净 `.spk` URL + Worker 边缘缓存

SPK 链接保持 `https://ssp.dnof.net/packages/<文件>.spk?v=<md5前12位>`（干净的 `.spk` 后缀），
Worker 用 **Cache API** 在边缘缓存完整下载：

- 首次 `GET`（无 Range）：回源 R2 并后台写入边缘缓存，响应头 `x-cache: MISS`
- 再次 `GET` 同一 URL（含 `?v=`）：直接命中缓存，`x-cache: HIT`，不再读 R2
- **Range 请求不进缓存**（续传/分段仍按原路径走 R2，保证 206 正确）
- 缓存 TTL 30 天（`Cache-Control: public, max-age=2592000, immutable`），
  `?v=<md5>` 属于缓存键：同名包重建后 md5 变、URL 变，不会命中旧缓存
- 不需要 Cache Rule / 控制台操作；旧链接 `<文件>.spk.bin` 仍然兼容（自动映射）

实测：

```text
第 1 次完整 GET  → 200 / x-cache: MISS / 15.7s / md5 = cafc3b9a…（与索引一致）
第 2 次完整 GET  → 200 / x-cache: HIT  / 13.1s
Range 0-1023     → 206（不走缓存，无 x-cache 头）
旧 .spk.bin 链接 → 200 / MISS（兼容）
```

> 想验证缓存：`curl -sI "https://ssp.dnof.net/packages/<文件>.spk?v=<md5>" | grep -i x-cache`。
> 每个 PoP 各自首次 MISS；缓存对象上限 512 MB，171 MB 的 SPK 没问题。

**可选：R2 直连 + CDN 缓存（需要 Cache Rule）**
`dl.dnof.net` 仍然绑定在 R2 bucket 上，可直接访问 `https://dl.dnof.net/spk/packages/<文件>.spk`。
如果以后想要「直连 R2 + Cloudflare CDN 长缓存」，在控制台给 `dl.dnof.net` 加一条
Cache Rule（Cache Everything / 30 天），再把 `SPK_BASE_URL` 指回去即可；当前默认走 Worker 缓存，
不需要这一步。

> 注意：SPK 实测基本不可压缩（gzip 后 99.6%），缓存只优化「重复下载」与回源，不会改变
> 首次下载时长（瓶颈在 CF 边缘到客户端的带宽）。

### 下载计数（D1）

Package Center 里的「下载计数」现在是真实数据（不再是 0）：

- **存储**：Cloudflare D1 数据库 `sspks-stats`（`wrangler.toml` 的 `[[d1_databases]]` binding `DB`），
  schema 见 [`migrations/0001_downloads.sql`](migrations/0001_downloads.sql)：
  按「套件名 + UTC 日期」一行，`count` 累加
- **计数规则**：`GET /packages/<文件>.spk` 返回 200 时 +1（包括命中边缘缓存；HEAD、Range 续传不计），
  按**套件名**统计，所以发新版换文件名后计数继续累计
- **读取**：Worker 把 `download_count`（累计）和 `recent_download_count`（最近 30 天）
  注入 Package Center JSON，同时显示在落地页卡片上；读取结果在 isolate 内缓存 60 秒
- **降级**：没有 `DB` binding 或查询失败时回落到 `defaults.download_count`（默认 0），不影响下载

运维命令：

```bash
# 看排行
npx wrangler d1 execute sspks-stats --remote   --command "SELECT package, SUM(count) AS total FROM downloads GROUP BY package ORDER BY total DESC"

# 清零
npx wrangler d1 execute sspks-stats --remote --command "DELETE FROM downloads"
```

新环境部署时：

```bash
npx wrangler d1 create sspks-stats            # 把 database_id 填进 wrangler.toml
npx wrangler d1 execute sspks-stats --remote --file migrations/0001_downloads.sql
```

> D1 免费额度（5 GB 存储 / 每天 10 万行写入）对个人套件源远远够用。
> 计数在 `ctx.waitUntil` 里异步写入，不会拖慢下载。

### 本地套件 / 尚未发 Release 的套件（extra packages）

套件仓库还没发布 `sspks-index.json` 时（例如打包仓库还没接入上面的 bundle 工作流），
用 `tools/add-extra.py` 先把本地包传上去：

```bash
python tools/add-extra.py --packages "D:/AI/bili-sync-up-pkg/dist" --bucket sspks --dry-run
python tools/add-extra.py --packages "D:/AI/bili-sync-up-pkg/dist" --bucket sspks
```

它会上传三样东西：

- `spk/index.extra.json`：extra 套件的元数据 + 内嵌图标（和 Release bundle 同格式）
- `spk/packages/<文件>.spk`：SPK 本体
- `spk/icons/*`：图标

随后 Worker 的 cron 同步会把 extra 套件和 GitHub Release 的套件**合并**进同一个索引：

- 同一套件名冲突时，**Release 优先**（以后仓库发版后自动接管）
- 旧版本 extra 包/图标在下次同步时自动清理
- marker 里带 extra bundle 的签名（`generated_at:数量`），所以**上传新 extra 包会触发重新同步**
- 清理全部 extra：`python tools/add-extra.py --clear --bucket sspks`

> `bili-sync-up` 已经接入自动同步（Release `v3.1.6` 起），extra 只是给「还没接 bundle
> 工作流的仓库」用的兜底；接入后跑一次 `--clear` 即可，Release 记录会自动接管同名套件。

## 配置

### Worker 变量（`wrangler.toml` 的 `[vars]`）

| 变量 | 说明 |
| --- | --- |
| `BASE_URL` | 固定响应里图标/元数据的 URL 前缀。不填则用请求的 origin；生产环境建议固定成自定义域名 |
| `SPK_BASE_URL` | 可选：把 SPK 下载指向 R2 自定义域名（如 `https://dl.dnof.net/spk/`）。不填则走 Worker 边缘缓存（推荐，URL 是干净的 `.spk`） |
| `routes` | 自定义域名绑定（`custom_domain = true`），写在顶层而不是 `[vars]` 里 |
| `[[d1_databases]]` | 下载计数库 `sspks-stats`（binding `DB`）；不配也能跑，计数为 0 |
| `workers_dev` | 是否保留 `*.workers.dev` 入口，调试用 |
| `SITE_NAME` | 列表页标题，默认 `SPK 套件源` |

### 索引器 CLI

```bash
python tools/index.py [--packages DIR] [--out DIR] [--config FILE] [--clean]
                      [--base-url URL] [--file-mask '*.spk'] [--pretty]
                      [--upload] [--dry-run] [--skip-existing]
                      [--bucket NAME] [--prefix spk]
```

| 参数 | 说明 |
| --- | --- |
| `--packages` | SPK 目录，默认 `packages/` |
| `--out` | 输出目录，默认 `dist/` |
| `--upload` | 生成后上传到 R2（见「上传到 R2」的三种方式） |
| `--upload-backend` | `s3`（默认，R2 API Token）或 `wrangler`（复用 `wrangler login`，无需 Token） |
| `--wrangler-cmd` | wrangler 命令，默认 `npx wrangler` |
| `--dry-run` | 只打印上传计划 / 将要执行的 wrangler 命令 |
| `--skip-existing` | R2 中已存在且大小一致的对象跳过（仅 s3 后端） |
| `--prefix` | R2 key 前缀，默认 `spk`（改这里要同步改 `src/worker.js` 的常量） |
| `--base-url` | 仅记录进 `index.json`，方便排查 |

### R2 对象布局

```
spk/index.json                     # Worker 唯一读取的索引入口
spk/icons/<spk文件名>_thumb_72.png
spk/icons/<spk文件名>_thumb_120.png
spk/icons/<spk文件名>_screen_1.png ...
spk/packages/<spk文件名>.spk
```

## 测试

```bash
npm test
```

覆盖 4 层：

1. **索引器**（`tests/test_index.py`）：INFO 解析（引号/转义/多行/CRLF/BOM/注释）、
   版本校验、架构与 model 列表、图标提取与 base64 兜底、wizard 对 `qinst` 的影响、
   损坏包与加密包跳过、MD5/大小、defaults、报告文件。
2. **过滤语义**（`tests/filter.test.mjs`）：直接移植 PHP 版回归用例（DSM 版本比较、
   `os_min_ver`/`os_max_ver` 窗口、同包多版本选择、beta 渠道、family/noarch 架构、
   `synology_<arch>_<model>` 的 model 包含/排除）。
3. **Worker 契约**（`tests/worker.test.mjs`）：用真实索引器产物 + 内存 R2 mock，
   断言 DSM 响应字段集合与取值、缺失 `beta` 字段、400/503 边界、下载头、
   `HEAD`、`Range`（206/416）、`ETag`（304）、图标缓存、列表页、`/health`。
4. **R2 上传**（`tests/test_r2.py`、`tests/test_upload.py`）：本地 mock S3 服务
   **独立重建规范请求并验签**，验证 SigV4 签名、UTF-8 key 编码、上传对象布局、
   `--dry-run`、`--skip-existing`。

## 本地开发

```bash
npx wrangler dev                      # 本地 Worker + 本地 R2 模拟
python tools/index.py
npx wrangler r2 object put sspks/spk/index.json --file dist/index.json --local
# 本地 R2 里的图标和 spk 同理，或用 --upload 直传线上 bucket
```

## 限制与注意事项

- **官方加密 SPK（keytype 3）不支持**。索引器会识别并跳过，报告里写原因。需要这类包的
  场景继续用 PHP 版索引，或只把非加密包放进来。
- **没有在线管理后台**。增删包 = 改 `packages/` + 重跑索引 + 上传。管理密码、实时进度、
  广告位、21 语言 UI 都不在本方案范围内。
- **自动同步的延迟**：Cron 每 5 分钟检查一次，新 Release 最晚约 5 分钟出现在套件中心；
  想立即生效用 `/sync` 手动触发。Cron 只跟随「最新正式 Release」（alpha/beta 预发布不进入）。
- **dsh-nas 仓库需公开**（Worker 匿名读 Release 资产）。改回私有会给 Worker 加 `GH_TOKEN`。
- **bundle 缺失/不完整时不会写标记**：Worker 下一轮会重试，直到 Release 里 SPK 齐全；
  期间下载请求回源 GitHub 兜底。
- **下载计数是真实值**（D1）：GET 200 计一次，HEAD/Range 不计；统计粒度是套件名 + 天，不做去重。
- **下载缓存由 Worker 的 Cache API 负责**：首次 MISS、之后 HIT；Range 请求不进缓存。R2 直连（`dl.dnof.net`）默认不缓存，需要 Cache Rule 才会走 CDN 缓存。
- **同名文件替换**：下载响应带 `Cache-Control: max-age=86400`，DSM 与 CF 边缘都可能缓存。
  发新版时请改文件名（带版本号），不要原地覆盖。
- **索引规模**：每次请求都要解析整个 `index.json`。几百个包没问题（实测几十 KB）；
  上千个包建议按 arch 拆分索引（`src/filter.js` 的接口可以不破坏地扩展）。
- **必须 HTTPS**：DSM 7 的套件来源拒绝 http。`*.workers.dev` 自带证书；自定义域名需在
  Cloudflare 托管 DNS（`ssp.dnof.net` 走 CF 通用证书，DSM 无需导入证书）。
- `model` / `exclude_model` 必须写成群晖的完整标识 `synology_<arch>_<model>`（如
  `synology_apollolake_ds918+`），与套件中心请求的 `unique` 一致。写成 `DS918+` 不会匹配。
- 索引器不做增量解析：每次都重新解包全部 SPK。几百 MB 级别建议在 CI 或本地夜跑。
- 第三方 SPK 的许可证、来源合法性由你自己负责。

## 费用

R2 与 Workers 免费额度通常够个人用：

- R2：10 GB 存储 / 每月 100 万 Class A（写）+ 1000 万 Class B（读），出站流量免费
- Workers 免费版：10 万请求/天，单请求 CPU 10 ms（本 Worker 只做 JSON 过滤，够用）

超出后大约：R2 存储 $0.015/GB·月，Class B $0.36/百万次；Workers 付费版 $5/月。
一个 SPK 下载 = 1 次 Worker 请求 + 1 次 R2 Class B 读。

## 故障排查

| 现象 | 原因 |
| --- | --- |
| DSM 添加源报错 / 列表为空 | `curl` 模拟请求看是否 200；确认 URL 是 HTTPS 且带末尾 `/` |
| 返回 `400 {"error":"Invalid Package Center request"}` | 参数缺失或非法（DSM 版本 < 7、语言非三位、arch 未知等） |
| 返回 `503 {"packages":[]}` | R2 里没有 `spk/index.json`，先跑 `--upload` |
| 套件不出现 | 不是 DSM 7 包（`os_min_ver`）、arch 不匹配机型、`beta` 包但请求 stable |
| `--upload` 报 403 | R2 token 无写权限、bucket 名错、或系统时间偏差过大 |
| 更新了索引但没变化 | Worker 索引缓存 5 分钟；`npx wrangler deploy` 可立即生效 |
| 图标 404 | `dist/icons/` 没上传；重跑 `--upload` 或 `rclone copy dist/icons ...` |

## 许可

GPL-3.0（与上游 [jdel/sspks](https://github.com/jdel/sspks) /
[tbc0309/sspks-imnks](https://github.com/tbc0309/sspks-imnks) 一致）。
`data/synology_models.yaml`、默认图标与协议实现来自 sspks-imnks。第三方 SPK 遵循各自许可证。
