# 架构说明

## 1. 进程模型

```text
┌──────────────────────── Electron Main ────────────────────────┐
│ 窗口 / 菜单 / app:// 协议 / 单实例 / 生命周期                  │
│ 文件存储（storage/）                                           │
│ 密钥保险库（safeStorage）                                      │
│ Provider Gateway（图片/视频/音频/文本 Provider）               │
│ 持久化任务队列（tasks/，并发/优先级/重试/恢复）                 │
│ 系统通知 / 托盘 / 后台生成                                     │
│ 本地反向代理（127.0.0.1 随机端口 + 会话 token，兼容/调试）       │
│ 原生保存对话框 / 下载处理                                      │
│ 日志                                                           │
└──────────────────────────┬─────────────────────────────────────┘
                           │ 白名单 IPC（contextBridge）
┌──────────────────────────┴─────────────────────────────────────┐
│ Preload：window.unleashly                                      │
│ 暴露 app / windowControls / storage / secrets / native /        │
│      proxy / tasks                                             │
└──────────────────────────┬─────────────────────────────────────┘
                           │
┌──────────────────────────┴─────────────────────────────────────┐
│ Renderer：原 React 应用                                        │
│ HashRouter / 画布 / 图片工作台 / 视频工作台 / 任务中心 / 素材    │
│ platform/：桌面驱动、密钥同步、代理配置、通道同步、任务事件      │
└────────────────────────────────────────────────────────────────┘
```

渲染层仍然保留原有的业务结构。桌面相关差异通过 `src/renderer/src/platform/` 适配，避免大面积修改画布和生成逻辑。

### 1.1 窗口与标题栏

- Windows / Linux 使用 `frame: false` 无边框窗口，由渲染层自绘顶部工作区栏和窗口控制按钮。
- macOS 使用 `titleBarStyle: "hiddenInset"`，保留原生交通灯，不渲染自绘窗口按钮。
- 渲染层通过 `window:minimize`、`window:toggle-maximize`、`window:close` IPC 控制窗口，主进程在最大化/还原时推送状态事件。
- 拖拽区域使用 `.app-drag` 和 `.app-no-drag`；侧栏头部、顶部工作区栏可拖拽，按钮和交互控件自动排除。
- 应用菜单通过顶部菜单按钮弹出原生 `Menu`，保留打开数据目录、编辑、视图、开发者工具、关于和退出等操作。
- 画布编辑器使用独立的顶部拖拽条和窗口控制，进入具体画布时不渲染左侧导航和普通页面标题栏。

## 2. 启动顺序

1. 主进程注册 `app://` scheme，初始化任务队列，启动本地代理，创建窗口。
2. Preload 通过 `contextBridge` 暴露 `window.unleashly`。
3. 渲染层 `main.tsx` 先执行 `bootstrapDesktop()`：
    - 注册文件型 localforage 驱动。
    - 读取旧 IndexedDB store，迁移到文件存储。
    - 迁移成功后把 localforage 默认驱动切到文件存储。
    - 等待 config store hydration。
    - 把主进程本地代理地址写入配置。
    - 从密钥保险库恢复通道 API Key 与 WebDAV 密码。
    - 把带密钥的渠道配置同步到主进程 Provider Gateway，并订阅后续配置变化。
4. 动态导入 React 应用并挂载。
5. 移除启动占位层。

启动占位层位于 `src/renderer/index.html`，用于覆盖首次迁移和初始化期间的等待。

## 3. 文件存储

主进程 `file-storage.ts` 提供最小键值接口：

```ts
get(store, key);
set(store, key, payload);
remove(store, key);
keys(store);
clear(store);
stats();
```

存储布局：

```text
userData/storage/<store>/
├─ <sha256(key)>.txt | .json | .bin
└─ <sha256(key)>.meta.json
```

- `store` 由 localforage 实例名和 storeName 组合，例如 `infinite-canvas__app_state`。
- 支持字符串、JSON、Blob/ArrayBuffer 三类值。
- Blob 在渲染层与主进程之间以 `ArrayBuffer` 传输。
- 写入使用临时文件 + rename，失败不会破坏旧值。
- `meta.json` 保存原始 key、类型、MIME 和更新时间，便于枚举与统计。

渲染层通过自定义 localforage driver 复用现有业务代码。原有 `localforage.createInstance(...)` 不需要改写。

## 4. 密钥流程

```text
用户输入 API Key
  → useConfigStore 更新内存
  → platform/secrets.ts 监听变化
  → IPC secrets:set
  → safeStorage.encryptString
  → userData/config/secrets.json

应用启动
  → config store 从文件恢复（不含密钥）
  → IPC secrets:list
  → safeStorage.decryptString
  → 合并进内存 config
  → 页面正常使用
```

- 持久化配置通过 `partialize` 剥离 `channels[].apiKey`、`apiKey` 和 `webdav.password`。
- 配置导出默认同样剥离密钥。
- 如果某条旧配置仍带密钥，启动时会先写入保险库，再参与后续同步。

## 5. 本地代理

原 Web 版依赖 `@basketikun/canvas-proxy` 解决浏览器 CORS。桌面端把等价能力内置到主进程：

- 只监听 `127.0.0.1`。
- 启动时生成随机端口与 16 字节 token。
- 代理地址形如 `http://127.0.0.1:<port>/<token>`。
- 渲染层通过 `proxyUrl` 配置继续使用原有 `withLocalProxy()` 逻辑。
- 支持流式响应（SSE）。
- 日志对 `key`、`api_key`、`token` 等查询参数做脱敏。

当前标准协议请求已经由主进程 Provider Gateway 直接发起，本地代理主要作为插件脚本、用户模型脚本、WebDAV 等渲染层请求的兼容/调试能力保留。

## 6. Provider Gateway 与任务系统

### 6.1 请求路径

```text
renderer services/api/*
  → services/api/gateway.ts（规范化请求并等待任务）
  → IPC tasks:enqueue
  → TaskQueue（持久化、并发、重试、取消）
  → providers/{image,video,audio,text}.ts
  → OpenAI 兼容 / Gemini HTTP
  → tasks/outputs/<taskId>/
  → IPC tasks:result
  → renderer Blob / Data URL
```

- 标准协议在渲染层不再直接发 HTTP；Web 运行时或模型脚本仍然走原有直连实现。
- 用户模型脚本（`resolveModelScript`）继续在渲染层执行，因为脚本依赖浏览器 Worker/Blob 等能力。
- 图片、视频、音频、文本都有独立 Provider 适配器；3D 在共享契约中预留了 `model3d`，当前返回 `unsupported`。
- 所有请求统一经过 `gateway/http.ts`：超时、有限重试、指数退避、SSE 读取和错误体解析。
- `gateway/errors.ts` 把失败归类为 `auth`、`rate_limit`、`timeout`、`network`、`server`、`content_policy`、`invalid_request` 等稳定错误码，并决定是否可重试。

### 6.2 凭据与持久化

- 渲染层在密钥保险库恢复后，通过 `tasks:sync-channels` 把渠道配置同步到主进程内存。
- `tasks.json` 只保存 `channelId`、`channelName`、`apiFormat`、`model` 等引用，不保存 API Key。
- 参考图/视频/音频从请求 Data URL 拆成 `tasks/payloads/<taskId>/inputs/` 下的二进制文件。
- 请求参数摘要保存在 `tasks.json`，完整请求保存在 `tasks/payloads/<taskId>/request.json`。
- 所有写入都使用临时文件 + rename，避免半写状态。

### 6.3 队列与恢复

- 状态：`queued`、`running`、`succeeded`、`failed`、`canceled`。
- 默认并发：全局 3，图片 2、视频 3、音频 1、文本 2；任务中心可调整全局并发。
- 优先级：`high` > `normal` > `low`，同优先级按入队时间排序。
- 取消：主进程持有每个任务的 `AbortController`，取消时中止 HTTP、SSE 读取或视频轮询睡眠。
- 自动重试：仅对 `rate_limit`、`timeout`、`network`、`server` 错误生效；图片默认 1 次尝试，其他能力默认 2 次，避免重复计费。
- 优雅退出：正在运行的视频任务会保留 Provider 侧任务 ID，重启后从 `queued` 恢复轮询；图片/音频/文本任务会标记为 `interrupted`。
- 完成后保留最近 300 个终态任务，超出后清理记录和结果文件。

### 6.4 事件、统计与界面

- 主进程通过 `tasks:changed`、`tasks:delta`、`tasks:open` 推送状态、文本流和通知跳转。
- `tasks:stats` 从持久化记录计算成功率、平均耗时、Token/图片/视频时长用量。
- 任务中心 `/tasks` 提供筛选、实时进度、取消、重试、删除、清理和结果预览。
- 系统通知只在窗口不在前台时发送；通知点击会打开对应任务详情。

### 6.5 后台生成与托盘

- 有排队/运行任务时关闭窗口会隐藏到托盘，而不是退出应用。
- 托盘菜单显示运行/排队数量，可打开任务中心、显示主窗口或退出。
- 显式退出会先让任务队列落盘，并把可恢复的视频任务保留为下次启动的轮询任务。

## 7. 原生文件保存

`platform/files.ts` 统一封装：

- 桌面：`native.saveFile` → 原生保存对话框 → 主进程写文件。
- 浏览器：回退到 `file-saver`。
- 远程 URL：交给下载处理；主进程 `will-download` 同样弹出保存对话框。

## 8. 安全边界

已实施：

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- 仅暴露白名单 IPC
- IPC 发送方 URL 校验
- 阻止任意导航，外部链接交给系统浏览器
- 禁止 `<webview>`
- 权限申请默认拒绝，仅允许剪贴板与通知
- `app://` 响应注入 CSP

已知取舍：

- 用户模型脚本通过 `new Function` 执行，需要 `unsafe-eval`。
- 运行时插件通过 Blob URL 动态 import，需要 `blob:`。
- 两者都运行在渲染进程，尚未形成真正的安全沙箱。
- 下一阶段计划：
    - 模型脚本迁到独立 Worker / utility process。
    - 插件宿主改为 iframe + postMessage 能力桥。
    - 引入插件签名、权限声明和来源信任级别。

## 9. 日志、崩溃与诊断

### 9.1 日志

- 主进程日志写入 `userData/logs/main.log`，按 5MB 轮转为 `main-<timestamp>.log`，最多保留 10 个轮转文件。
- 日志级别支持 `debug / info / warn / error`，默认 `info`，可用 `UNLEASHLY_LOG_LEVEL` 调整。
- 日志元数据统一经过 `log-redaction.ts`：递归隐藏 `apiKey`、`token`、`password`、`Authorization` 等字段，并清理 URL 查询参数中的凭据。
- 渲染层 `console` 消息由主进程 `webContents` 的 `console-message` 事件转发到同一日志流；设置 `UNLEASHLY_LOG_RENDERER_CONSOLE=0` 可关闭。
- 内存中保留最近 800 条日志，诊断页面和诊断包即使日志文件轮转也能看到近期上下文。

### 9.2 崩溃报告

```text
主进程未捕获异常 / 未处理 Promise
渲染进程崩溃 / 无响应
GPU / Utility 子进程退出
渲染层 window error / unhandledrejection
React 错误边界
        ↓
crash-reports/<timestamp>-<id>.json
        ↓
配置 → 诊断与日志 / 诊断包
```

- 结构化报告包含崩溃类型、进程类型、原因、退出码、消息、堆栈、来源和 app/Electron/Node 版本。
- `crashReporter.start({ uploadToServer: false })` 收集本地 crashpad dump，不上传服务器。
- 渲染进程崩溃会记录报告，并在非退出状态下提示用户重新加载界面。
- 渲染层未捕获错误通过 `diagnostics:report-crash` IPC 写入主进程；React 根节点由 `RenderErrorBoundary` 兜底。
- 报告最多保留 50 份，超出后按时间清理。

### 9.3 诊断包

- `diagnostics.json`：应用/系统/显卡/内存/显示环境、日志统计、任务统计、崩溃摘要和脱敏后的渲染层配置。
- `logs/`：主日志与轮转日志，以及最近日志环形缓冲。
- `crash-reports/`：结构化崩溃报告。
- `crash-dumps/`：本地 crashpad dump（总大小限制 50MB）。
- `tasks/summary.json`：任务队列统计，不包含提示词或凭据。
- ZIP 由内置 stored-method 写入器生成，不依赖原生压缩库。
- 诊断包不包含 API Key、令牌、密码、Authorization 头、模型脚本或生成媒体。

## 10. 面向视频 / 3D 的约束

- 画布是 DOM 节点 + CSS transform，不是 Canvas/WebGL 渲染器；适合图片、视频、iframe 和 React 插件节点。
- 3D 节点应只在视口内或选中时挂载 WebGL，其余状态使用缩略图，避免上下文数量上限。
- 视频长任务、3D 生成任务应进入主进程持久化 Job Queue，而不是页面内状态。
- 当前视频任务已进入队列并支持跨重启恢复；3D 生成能力仍待接入 Provider。
- 大画布需要逐步补视口虚拟化、历史记录压缩和媒体缓存策略。

## 11. 上游同步策略

- `src/renderer/src` 尽量保持与上游一致的目录和命名，便于 cherry-pick。
- 桌面差异集中在：
    - `src/main`
    - `src/preload`
    - `src/shared`
    - `src/renderer/src/platform`
- 大规模业务重构（例如拆分 `pages/canvas/project.tsx`）建议在上游同步节奏稳定后单独进行。

## 12. 自动更新

- 主进程通过 `electron-updater` 读取安装包内的 `resources/app-update.yml`，从 GitHub Releases 获取 `latest.yml`。
- `electron-builder.yml` 的 `publish` 配置指向 `wantoo123/unleashly`；仓库公开后更新检查不需要 token。
- 更新流程：启动后 10 秒静默检查 → 每 6 小时检查 → 用户下载 → 下载进度 → 重启安装。
- 下载和安装由用户确认，不自动下载；安装前会先关闭任务队列并保存状态，再调用 `quitAndInstall`。
- 主进程通过 `updates:*` IPC 和 `updates:changed` 事件把状态同步给渲染层；版本弹窗展示版本、进度、错误和操作按钮。
- `v0.2.2` 是第一个内置自动更新配置的版本；`v0.2.1` 及更早版本需要手动安装一次 `v0.2.2`。
