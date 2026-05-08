# arkts-lsp

ArkTS language server for Claude Code — wraps DevEco Studio's ace-server with hvigor sync and LSP proxy.

## Supported Extensions
`.ets`, `.d.ets`

## Installation

The plugin auto-installs `arkts-lsp-proxy` on first use via a SessionStart hook. No manual installation needed.

## Configuration

Set `DEVECO_HOME` environment variable (optional, auto-detected if not set):

```bash
# macOS
export DEVECO_HOME=/Applications/DevEco-Studio.app

# Windows
set DEVECO_HOME=D:\Application\Huawei\DevEco Studio

# Linux
export DEVECO_HOME=/opt/DevEco-Studio
```

## Usage

The proxy must be run from a HarmonyOS project directory (containing `build-profile.json5`).

```bash
cd /path/to/harmonyos/project
arkts-lsp-proxy
```

## More Information
- [GitHub Repository](https://github.com/HelloiOS2014/harmony_arkts_lsp_proxy)
