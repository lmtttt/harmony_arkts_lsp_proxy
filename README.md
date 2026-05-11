# ArkTS LSP Proxy

将 DevEco Studio 内置的 ArkTS 语言服务器（ace-server）桥接出来，让 Claude Code 等支持 LSP 的工具获得 ArkTS 语言智能。

## 解决什么问题

AI 编码工具把 ArkTS 当成普通 TypeScript，导致：

- 使用不存在的 Web/Node.js API（如 `document.getElementById`）
- 不了解 ArkTS 声明式 UI 语法（`@Component`、`@State`、`build()` 等）
- 不遵守 ArkTS 静态类型约束（禁止 `any`、禁止动态属性访问等）

## 工作原理

```
Claude Code (LSP Client)
    │ stdio (JSON-RPC)
    ▼
arkts-lsp-proxy (Node.js 进程)
    │
    ├── 1. 发现 DevEco Studio（环境变量 / 自动搜索）
    ├── 2. 推导 SDK、ace-server、工具链路径
    ├── 3. 解析 build-profile.json5，构造 modules 参数
    ├── 4. 启动 ace-server，拦截 initialize 请求注入参数
    └── 5. 后台按需运行 hvigor --sync（刷新依赖映射）
         │
         ▼
    ace-server (DevEco 官方语言服务)
         ├── textDocument/diagnostics
         ├── textDocument/completion
         ├── textDocument/hover
         ├── textDocument/definition
         ├── textDocument/documentSymbol (proxy fallback)
         ├── workspace/symbol (proxy fallback)
         └── @Component/@State/@Prop 语义理解
```

代理不实现 ArkTS 语义分析，只做启动适配、消息转发、参数注入和必要的 LSP 结果归一化。比如 DevEco ace-server 会把 hover 内容包成私有 JSON 字符串，代理会转换成标准 Markdown hover，方便 Claude Code 直接消费类型信息。DevEco ace-server 未提供的 symbol 能力由 proxy 做轻量 fallback。

## 当前支持的核心能力

- `textDocument/completion`
- `textDocument/hover`，包含类型信息和文档，已转换为标准 Markdown 内容
- `textDocument/definition`
- `textDocument/references`
- `textDocument/signatureHelp`
- `textDocument/documentSymbol`，基于打开文件文本解析 ArkTS/ArkUI 文件结构
- `workspace/symbol`，基于项目根轻量扫描 `.ets/.ts/.d.ets/.d.ts`
- diagnostics，来自 ace-server 的发布诊断

## 前置条件

- **DevEco Studio** 已安装（ace-server 随 IDE 分发）
- **Node.js** >= 18

## 安装

### Claude Code 插件（推荐）

```bash
# 注册 marketplace
/plugin marketplace add HelloiOS2014/harmony_arkts_lsp_proxy

# 安装插件（首次使用时自动安装 arkts-lsp-proxy）
/plugin install arkts-lsp
```

### npm 全局安装（手动 CLI 使用）

```bash
npm install -g arkts-lsp-proxy
```

## 配置

### 环境变量

```bash
# macOS
export DEVECO_HOME=/Applications/DevEco-Studio.app

# Windows
set DEVECO_HOME=D:\Application\Huawei\DevEco Studio

# Linux
export DEVECO_HOME=/opt/DevEco-Studio
```

不设置也可以，会自动搜索各平台默认安装路径。

## 使用

插件安装后，打开 `.ets` 文件时 LSP 自动激活。代理会优先启动 LSP 并响应请求；`hvigor --sync` 只作为后台 metadata refresh，不会阻塞 LSP 初始化。

也可以手动运行（支持直接给出项目路径）：

```bash
arkts-lsp-proxy --project-root /path/to/harmonyos/project
```

当从非鸿蒙目录启动时，默认不会立即校验项目；会等到 LSP 初始化请求到来后根据 `rootUri`/`workspaceFolders` 自动定位鸿蒙项目路径。

### Hvigor metadata sync

`arkts-lsp-proxy` 不会把 `hvigor --sync` 作为 LSP 启动前置条件。这个策略和 Claude Code 的其它 LSP 插件一致：插件负责启动 language server，工程 metadata / index refresh 属于 language server 内部增强流程。

环境变量：

```bash
# 默认：只有 metadata 缺失或过期时，后台运行 hvigor sync
export ARKTS_LSP_SYNC=auto

# 完全跳过 hvigor sync，启动最快
export ARKTS_LSP_SYNC=off

# 强制后台运行 hvigor sync，即使 metadata 看起来是新鲜的
export ARKTS_LSP_SYNC=force

# 后台 sync 超时，默认 15000
export ARKTS_LSP_SYNC_TIMEOUT_MS=15000
```

如果 sync 失败或超时，LSP 仍会继续运行。当前文件的 completion、hover、definition、references、diagnostics 应继续可用；跨模块、SDK、依赖相关结果可能降级，直到 metadata 刷新成功。

### Metadata debug

排查 SDK / ArkUI / oh_modules 索引问题时，可以打开 metadata debug。默认关闭，避免在普通日志里暴露本地路径。

```bash
export ARKTS_LSP_METADATA_DEBUG=1
```

开启后，代理会在 stderr 输出注入给 ace-server 的关键工程信息，包括项目根、`oh_modules`、`oh-package*.json5`、hvigor `dependencyMap`、SDK 路径、SDK 关键子目录、module 配置、`aceLoaderPath`、`sdkJsPath` 和这些路径是否存在。

### LSP trace

排查 Claude Code 插件真实链路时，可以打开协议路由 trace：

```bash
export ARKTS_LSP_TRACE=1
```

开启后，代理会输出客户端请求/通知的方法名，以及每个请求走的是 `proxy-fallback`、`ace-notification` 还是 `ace-request-forward`。启动时也会输出 `arkts-lsp-proxy` 实际运行版本，便于确认 Claude Code 会话是否已经升级到最新版本。对 `workspace/symbol`，trace 会额外输出 query 来源字段、query 长度和返回结果数。

## 平台支持

| 平台 | 默认搜索路径 |
|------|-------------|
| macOS | `/Applications/DevEco-Studio.app`、`~/Applications/DevEco-Studio.app` |
| Windows | `D:\Application\Huawei\DevEco Studio`、`C:\Program Files\Huawei\DevEco Studio` |
| Linux | `/opt/DevEco-Studio`、`~/DevEco-Studio` |

macOS 自动处理 `.app/Contents` 层，用户只需设置 `.app` 路径。

## 错误处理

| 场景 | 行为 |
|------|------|
| DevEco Studio 未安装 | stderr 输出安装指引，exit(1) |
| 初始化请求未携带可定位路径或未检测到 `build-profile.json5` | 代理返回 LSP 初始化错误，需调整 `rootUri`/`workspaceFolders` |
| hvigor sync 失败或超时 | stderr 输出警告，LSP 继续以现有 metadata / degraded 模式运行 |
| ace-server 启动失败 | 输出错误信息，exit(1) |
| ace-server 运行时崩溃 | 代理将中断当前会话并回传错误 |

## 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 测试
npm test

# 本地链接
npm link
```

## 项目结构

```
src/
├── env.ts          DevEco Studio 环境发现
├── project.ts      HarmonyOS 项目解析 + findProjectRoot 向上搜索
├── hvigor.ts       hvigor metadata 状态、sync 策略与后台执行
├── ace-server.ts   ace-server 子进程生命周期管理（onExit 回调）
├── proxy.ts        LSP 消息代理，拦截 initialize 注入参数
└── index.ts        入口，串联所有模块
.claude-plugin/
└── marketplace.json    marketplace 清单 + lspServers 配置
plugins/
└── arkts-lsp/
    ├── .claude-plugin/
    │   └── plugin.json     插件清单
    ├── hooks/
    │   └── hooks.json      SessionStart 自动安装 hook
    ├── package.json        npm 依赖声明（供 hook 自动安装）
    ├── .lsp.json           LSP 服务器配置
    └── README.md           插件文档
test/
├── env.test.ts
├── project.test.ts
├── hvigor.test.ts
├── ace-server.test.ts
├── proxy.test.ts
├── index.test.ts
└── fixtures/
```

## 技术栈

- TypeScript
- `vscode-jsonrpc` — LSP 消息解析与传输
- `json5` — 解析 `build-profile.json5`
- Vitest — 测试

## License

MIT
