---
name: arkts
description: Use when working in HarmonyOS, OpenHarmony, ArkTS, ArkUI, DevEco Studio, or .ets/.d.ets files; especially before editing ArkTS UI components, state, decorators, module APIs, or type-sensitive code.
---

# ArkTS Workflow

Use the `arkts-lsp` MCP tools when the task touches HarmonyOS ArkTS or `.ets` files.

## Required Checks

- Start with `arkts_project_info` when the project root, SDK metadata, or module configuration is unclear.
- Use `arkts_document_symbols` to understand the structure of a file before broad edits.
- Use `arkts_hover`, `arkts_definition`, or `arkts_references` before changing unfamiliar identifiers, decorators, imports, state fields, or component APIs.
- Run `arkts_diagnostics` after edits to `.ets`, `.d.ets`, or ArkTS-heavy `.ts` files when DevEco Studio is available.

## ArkTS Guardrails

- Do not treat ArkTS as browser TypeScript.
- Do not assume DOM, Web, or Node.js APIs such as `document`, `window`, `fs`, or `process` exist in app code.
- Avoid `any`, dynamic property access, and untyped object plumbing unless the local code already requires it.
- Preserve ArkUI declarative patterns such as `@Component`, `@Entry`, `@State`, `@Prop`, `@Builder`, and `build()`.

If the MCP tools are unavailable, state that limitation and fall back to reading project files directly.
