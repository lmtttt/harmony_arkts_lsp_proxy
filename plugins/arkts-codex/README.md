# ArkTS LSP for Codex

This Codex plugin exposes HarmonyOS ArkTS language intelligence through MCP.
It uses the `arkts-lsp-mcp` command from the `arkts-lsp-proxy` npm package,
which wraps DevEco Studio's bundled `ace-server`.

## Requirements

- DevEco Studio installed.
- Node.js available for `npx`.
- Optional: set `DEVECO_HOME` when DevEco Studio is not in a default location.

## Install

Add this repository as a Codex marketplace:

```bash
codex plugin marketplace add HelloiOS2014/harmony_arkts_lsp_proxy
```

Then install or enable `ArkTS LSP` from the Codex plugin list.

You do not need to install the npm package globally. The plugin starts the MCP
server with:

```bash
npx -y --package arkts-lsp-proxy@latest arkts-lsp-mcp
```

## Components

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `.mcp.json`: MCP server registration for `arkts-lsp`.
- `skills/arkts/SKILL.md`: Thin ArkTS workflow guidance for Codex.

## Notes

Codex does not currently use Claude Code's `.lsp.json` activation model. This
plugin uses MCP tools instead, so Codex can ask for ArkTS project metadata,
symbols, hover/type information, definitions, references, signature help, and
diagnostics when working in HarmonyOS projects.
