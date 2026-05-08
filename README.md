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
    ├── 4. 运行 hvigor --sync（生成依赖映射）
    └── 5. 启动 ace-server，拦截 initialize 请求注入参数
         │
         ▼
    ace-server (DevEco 官方语言服务)
         ├── textDocument/diagnostics
         ├── textDocument/completion
         ├── textDocument/hover
         ├── textDocument/definition
         └── @Component/@State/@Prop 语义理解
```

代理不实现任何语言功能，只做消息转发和参数注入。

## 前置条件

- **DevEco Studio** 已安装（ace-server 随 IDE 分发）
- **Node.js** >= 18

## 安装

```bash
npm install -g arkts-lsp-proxy
```

## 配置

### Claude Code

在 Claude Code 中注册 marketplace 并安装插件：

```bash
# 注册 marketplace
claude marketplace add HelloiOS2014/harmony_arkts_lsp_proxy

# 安装插件
/plugin install arkts-lsp
```

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

```bash
# 在鸿蒙项目目录下直接运行
cd /path/to/harmonyos/project
arkts-lsp-proxy
```

首次启动会执行 `hvigor --sync` 初始化依赖映射（可能需要几分钟），后续有缓存会很快。

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
| 项目目录无 `build-profile.json5` | stderr 输出提示，exit(1) |
| hvigor sync 失败 | stderr 输出警告，继续启动 ace-server |
| ace-server 启动失败 | 输出错误信息，exit(1) |
| ace-server 运行时崩溃 | 代理进程同步退出 |

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
├── project.ts      HarmonyOS 项目解析，构造 ace-server modules 参数
├── hvigor.ts       hvigor sync 缓存检查与执行
├── ace-server.ts   ace-server 子进程生命周期管理
├── proxy.ts        LSP 消息代理，拦截 initialize 注入参数
└── index.ts        入口，串联所有模块
.claude-plugin/
└── marketplace.json    marketplace 清单 + lspServers 配置
plugins/
└── arkts-lsp/
    └── README.md       插件文档
test/
├── env.test.ts
├── project.test.ts
├── proxy.test.ts
└── fixtures/
```

## 技术栈

- TypeScript
- `vscode-jsonrpc` — LSP 消息解析与传输
- `json5` — 解析 `build-profile.json5`
- Vitest — 测试

## License

MIT
