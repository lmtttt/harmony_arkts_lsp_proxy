# arkts-lsp

ArkTS language server for Claude Code — wraps DevEco Studio's ace-server with an LSP proxy and background hvigor metadata sync.

## Supported Extensions
`.ets`, `.d.ets`

## Supported LSP Features

- Completion
- Hover/type information, normalized from ace-server's private payload into Markdown
- Definition
- References
- Signature help
- Diagnostics

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

### Hvigor metadata sync

The plugin starts `arkts-lsp-proxy`; it does not run `hvigor sync` as a Claude Code startup hook. The proxy handles sync internally as a fail-soft background metadata refresh.

```bash
# Default. Use existing metadata immediately; refresh in background only if stale/missing.
export ARKTS_LSP_SYNC=auto

# Fastest startup. Never run hvigor sync.
export ARKTS_LSP_SYNC=off

# Force a background refresh.
export ARKTS_LSP_SYNC=force

# Background sync timeout in milliseconds. Default: 15000.
export ARKTS_LSP_SYNC_TIMEOUT_MS=15000
```

If sync fails or times out, the LSP remains available in degraded metadata mode. Cross-module and SDK-dependent results may be less complete until metadata is refreshed.

## Usage

The proxy no longer requires you to `cd` into a HarmonyOS project first.
If the client sends `initialize` with `rootUri` / `workspaceFolders` / `rootPath`, it will use that path for project discovery.
If you do start manually from terminal, you can also pass `--project-root /path/to/project`.

```bash
arkts-lsp-proxy
```

## More Information
- [GitHub Repository](https://github.com/HelloiOS2014/harmony_arkts_lsp_proxy)
