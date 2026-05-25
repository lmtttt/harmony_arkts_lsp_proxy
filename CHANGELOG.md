# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.8] - 2026-05-25

### Added
- `arkts-lsp-codex-install` project installer for Codex project-scoped MCP config.

### Changed
- Codex setup now targets `<project>/.codex/config.toml` instead of a global Codex marketplace plugin.
- `arkts-lsp-codex-install` installs into the requested Codex project directory without requiring `build-profile.json5`.

### Removed
- Codex marketplace plugin packaging to avoid global MCP/tool exposure in non-HarmonyOS projects.

## [0.1.7] - 2026-05-25

### Added
- Codex MCP adapter with the `arkts-lsp-mcp` binary and eight ArkTS tools.
- Codex plugin packaging with `.codex-plugin/plugin.json`, MCP config, and an ArkTS skill.
- MCP workflows for project info, symbols, hover, definition, references, signature help, and diagnostics.

### Changed
- Package metadata and Claude plugin manifests updated to 0.1.7.
- README now documents both Claude Code LSP and Codex MCP usage.

## [0.1.0] - 2026-05-08

### Added
- DevEco Studio environment discovery (macOS, Windows, Linux)
- HarmonyOS project parsing from `build-profile.json5`
- `findProjectRoot()` upward directory search
- `deviceType` derivation from `compatibleDeviceType` in project config
- hvigor sync with 24-hour cache freshness check
- ace-server child process lifecycle management with `onExit` callback
- LSP message proxy with `initialize` request interception and `initializationOptions` injection
- Claude Code plugin integration via marketplace with auto-install (SessionStart hook + CLAUDE_PLUGIN_DATA)
- Comprehensive test suite (env, project, hvigor, ace-server, proxy, index)
- ESLint with typescript-eslint
- .editorconfig

### Fixed
- `process.exit()` replaced with event-based lifecycle in ace-server
- `ProxyHandle.dispose()` now called on all cleanup paths
- Error logging added to proxy connection error handlers
- Full stack traces on `build-profile.json5` parse errors
