# Project Snapshot

Generate an LLM-optimized snapshot of your project's structure and file contents — perfect for feeding multi-file context into web-based AI tools like Claude, ChatGPT, or Gemini.

## Installation

Install from the [Visual Studio Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cmdaeo.project-snapshot).

Or search **"Project Snapshot"** in the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).

## Requirements

- Visual Studio Code **1.80.0** or higher

## Features

- **LLM-Optimized Output** — Files are wrapped in `<file path="...">` XML tags with fenced markdown code blocks, giving AI models clean, unambiguous structure to parse.
- **Native File Clipboard** — On Windows and macOS the actual snapshot file is placed on the clipboard (not just text), so you can paste directly into tools that accept file drops. Falls back to copying the file path on unsupported platforms.
- **Single-Pass Scanner** — The directory tree and file collection are built in one recursive walk, halving filesystem round-trips compared to separate tree + collect passes.
- **Batched Parallel I/O** — Files are read in concurrent batches of 20, dramatically reducing total read time on large projects versus sequential reads.
- **15-Second Safety Timeout** — The entire generation is wrapped in a hard timeout so the extension can never hang VS Code indefinitely.
- **Global Ignore Engine** — Configure ignore rules in VS Code Settings instead of requiring a per-project config file. Supports glob patterns, path anchors, and negation.
- **Advanced Negation Logic** — Combine rules like `["*", "!.ts"]` (ignore everything except TypeScript files) for precise context control.
- **Multi-Select Support** — `Ctrl/Cmd + Click` multiple files or folders in the Explorer and snapshot exactly what you highlighted.
- **Extension Filter** — Optionally restrict output to specific file extensions as a secondary filter on top of your ignore rules.
- **Auto-Dismissing Status Bar** — Success feedback shows in the status bar for 10 seconds and auto-clears, keeping your notification area clean.

## Usage

1. Select one or more files or folders in the VS Code Explorer.
2. Right-click → **"Generate Project Snapshot"**.
3. Wait for the status bar message confirming how many files were captured.
4. The snapshot file is now on your clipboard — paste directly into your AI tool.
5. Optionally click **Reveal** in the info toast to open the temp file in your OS file manager.

> **Tip:** If no selection is active, the extension automatically snapshots the first workspace folder.

## Output Format

The generated `.md` file contains two sections:

```
==================== PROJECT DIRECTORY STRUCTURE ====================

my-project/
    src/
        index.ts
        utils.ts
    package.json

==================== FILE CONTENTS ====================

<file path="src/index.ts">
```ts
// file contents here
```
</file>
```

## Configuration

Open Settings (`Ctrl+,` / `Cmd+,`) and search **Project Snapshot**:

| Setting | Default | Description |
|---|---|---|
| `projectSnapshot.globalIgnores` | `[]` | Glob patterns to ignore. Supports negation (`!`) and path anchors (`/`). Can be overridden per workspace. |
| `projectSnapshot.includedExtensions` | `["*"]` | File extensions to include. `"*"` means all — your ignore rules handle filtering. Explicit list (e.g. `[".ts", ".html"]`) acts as a secondary filter. |

### Ignore Pattern Examples

```jsonc
// Settings → projectSnapshot.globalIgnores

// Ignore common noise (recommended starting point)
["node_modules/", ".git/", "dist/", "*.lock", "*.log"]

// Include ONLY TypeScript files
["*", "!.ts"]

// Ignore everything except src/
["*", "!/src"]
```

> Patterns follow `.gitignore` semantics: leading `/` anchors to the root, `**` matches any depth, `!` negates a previous rule.

## License

MIT