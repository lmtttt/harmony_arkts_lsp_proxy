# ArkTS LSP Proxy 设计文档

## 背景与目标

### 问题

AI 编码工具（Claude Code、Codex 等）把 ArkTS 当成普通 TypeScript 处理，导致：
- 使用不存在的 Web/Node.js API（如 `document.getElementById`）
- 不了解 ArkTS 声明式 UI 语法（`@Component`、`@State`、`build()` 等）
- 不遵守 ArkTS 的静态类型约束（禁止 `any`、禁止动态属性访问等）

### 目标

构建一个 LSP Proxy，将 DevEco Studio 内置的官方语言服务（ace-server）桥接出来，让 Claude Code 等支持 LSP 的工具能获得 ArkTS 语言智能。

### 非目标

- 不重新实现 ArkTS 语言服务
- 不支持 DevEco Studio 以外的 ArkTS 工具链
- 不提供构建、调试、预览等 IDE 功能

---

## 架构

```
Claude Code (LSP Client)
    │ stdio (JSON-RPC)
    ▼
arkts-lsp-proxy (Node.js 进程)
    │
    ├── 环境发现：定位 DevEco Studio、SDK、项目配置
    ├── 消息拦截：改写 initialize 请求，注入 initializationOptions
    └── 双向透传：所有其它 LSP 消息原样转发
    │
    ▼
ace-server (DevEco 官方语言服务，Node.js 子进程)
    ├── 标准 LSP 能力：hover、completion、definition、references、diagnostics
    └── ArkTS 扩展：@Component/@State/@Prop 语义理解
```

代理不实现任何语言功能，只做消息转发和参数注入。

---

## 模块设计

### 模块 1：环境发现

**职责**：定位 DevEco Studio 安装路径、SDK 路径、ace-server 路径。

**逻辑**：
1. 检查 `DEVECO_HOME` 环境变量
2. 自动搜索平台默认安装路径：
   - macOS: `/Applications/DevEco-Studio.app`
   - Windows: `C:\Program Files\Huawei\DevEco Studio`、`D:\Application\Huawei\DevEco Studio`
   - Linux: `/opt/DevEco-Studio`
3. macOS 上自动处理 `.app/Contents` 层
4. 验证 `ace-server/out/index.js` 存在
5. 推导 SDK 路径：`<deveco>/sdk/default/sdk-pkg.json`

**输出**：
```typescript
interface DevEcoEnv {
  devecoHome: string       // DevEco 根目录（macOS 上含 Contents）
  sdkPath: string          // SDK 路径
  aceServerPath: string    // ace-server 入口
  nodeBin: string          // DevEco 自带 Node 路径
  hvigorPath: string       // hvigorw.js 路径（用于 hvigor sync）
}
```

### 模块 2：项目解析

**职责**：从 HarmonyOS 项目配置中推导 ace-server 所需的 modules 参数。

**输入**：项目根目录（从 `build-profile.json5` 所在位置向上查找）

**逻辑**：
1. 解析 `build-profile.json5`，提取 `modules` 和 `products` 配置
2. 对每个模块构造 ace-server 要求的完整对象：

```typescript
interface AceModule {
  moduleName: string           // 从 build-profile.json5 的 modules[].name
  modulePath: string           // 项目根 + modules[].srcPath（绝对路径）
  deviceType: string[]         // 默认 ["phone"]
  aceLoaderPath: string        // sdkPath + js/framework/{deviceType}/ace-loader
  jsComponentType: number      // 0=App（entry 模块）
  sdkJsPath: string            // sdkPath + js/api/{deviceType}/
  compatibleSdkLevel: string   // 从 products[].compatibleSdkVersion 提取数字
  apiType: string              // "Stage"（HarmonyOS NEXT 统一 Stage 模型）
}
```

**`compatibleSdkLevel` 提取规则**：从 `compatibleSdkVersion` 字符串中提取括号内的数字，例如 `"5.0.0(12)"` → `"12"`。

**`deviceType` 已知限制**：当前默认 `["phone"]`。平板、手表等设备类型需后续从 `build-profile.json5` 的 `products[].compatibleDeviceType` 字段推导。

**`jsComponentType` 已知限制**：当前默认 `0`（App）。HAR 库模块应为 `2`（Declaration），后续需根据模块类型推导。

**降级**：任一字段推导失败则跳过该模块，stderr 输出警告。

### 模块 3：hvigor sync

**职责**：运行 hvigor sync 生成依赖映射，使 ace-server 能正确解析 oh_modules 中的第三方包类型。

**为什么需要**：ace-server 的语言服务在初始化时需要知道项目的完整依赖关系。没有 hvigor sync，`oh_modules` 里的第三方包（如 `@ohos/axios`）将没有类型信息，补全和诊断会缺失。

**逻辑**：
1. 检查 `<projectRoot>/.hvigor/dependencyMap/dependencyMap.json5` 是否已存在且新鲜
2. 如不存在或过期，运行：
   ```
   <nodeBin> <hvigorPath> --sync -p product=default --analyze=normal --parallel --incremental -p enforce-ohpm=true --daemonjs
   ```
3. 工作目录设为项目根，环境变量 `DEVECO_SDK_HOME` 设为 SDK 路径
4. 超时 10 分钟

**时序**：hvigor sync 在 ace-server 启动之前同步执行。首次运行可能较慢，但后续有缓存会很快。

### 模块 4：LSP 消息代理

**职责**：拦截 Claude Code → ace-server 的 `initialize` 请求，注入 `initializationOptions`；其余消息双向透传。

**消息格式**：LSP 使用 JSON-RPC over stdio，消息格式为 `Content-Length: N\r\n\r\n{json}`。

**拦截逻辑**：
- 读取 Claude Code 发来的每条消息
- 如果是 `initialize` 请求：
  - 解析 JSON body
  - 注入 `initializationOptions`：`rootUri`、`lspServerWorkspacePath`、`modules`
  - 重新序列化后发给 ace-server
- 其它消息：原样转发
- ace-server → Claude Code 的消息：全部原样转发（Claude Code 会忽略不认识的通知）

### 模块 5：ace-server 生命周期管理

**职责**：启动和管理 ace-server 子进程。

**启动参数**：
```
<deveco>/tools/node/bin/node <deveco>/plugins/openharmony/ace-server/out/index.js
```

ace-server 使用标准 LSP stdio 模式（`createConnection(ProposedFeatures.all)`），不需要特殊 CLI 参数。

**生命周期**：
- Claude Code 启动 LSP 时 spawn ace-server
- Claude Code 关闭时 kill ace-server
- ace-server 崩溃时向 stderr 输出错误信息，代理进程退出

---

## Claude Code 集成

通过 Claude Code 插件系统注册 LSP 服务器。

**插件配置**（`.lsp.json` 或 `plugin.json`）：
```json
{
  "arkts": {
    "command": "arkts-lsp-proxy",
    "extensionToLanguage": {
      ".ets": "arkts",
      ".d.ets": "arkts"
    }
  }
}
```

代理需要安装为全局 npm 包或在 PATH 中可访问。

---

## 错误处理

| 场景 | 行为 |
|---|---|
| DevEco Studio 未安装 | stderr 输出安装指引，exit(1) |
| SDK 路径不存在 | stderr 输出警告，尝试继续 |
| 项目目录无 `build-profile.json5` | stderr 输出提示，exit(1) |
| modules 推导失败 | 跳过失败模块，stderr 输出警告 |
| ace-server 启动失败 | 输出错误信息，exit(1) |
| ace-server 运行时崩溃 | 代理进程同步退出 |

---

## 技术栈

- **语言**：TypeScript
- **运行时**：Node.js >= 18
- **依赖**：
  - `vscode-jsonrpc` — LSP 消息解析和传输（底层库，`vscode-languageserver` 也基于它）
  - `json5` — 解析 `build-profile.json5`（json5 格式支持注释和尾逗号）
- **开发依赖**：TypeScript、Vitest（测试）

选择 `vscode-jsonrpc` 而非自己写 JSON-RPC 解析：这是 LSP 生态的标准库，经过大量生产验证，处理了所有边界情况（分块消息、编码、错误处理等）。

---

## 测试策略

1. **单元测试**：环境发现、项目解析、modules 构造逻辑
2. **集成测试**：启动代理 → 发送模拟 LSP initialize 消息 → 验证注入正确
3. **端到端测试**：在真实 HarmonyOS 项目上启动代理 → 连接 Claude Code → 验证 diagnostics、hover、completion
