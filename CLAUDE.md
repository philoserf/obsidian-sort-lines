# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Obsidian plugin to sort and permute lines, lists, and headings. Forked from Vinzent03/obsidian-sort-and-permute-lines.

The current next step for this repo is tracked in the workspace backlog at `../NEXT.md` (the `obsidian-sort-lines` row). Read it when starting work; update it when that step ships.

## Development Commands

```bash
bun install              # Install dependencies
bun run dev              # Watch mode (bun --watch on build.ts)
bun run build            # Production build (runs check first)
bun run check            # typecheck + biome check
bun run typecheck        # tsc --noEmit
bun run lint             # biome check
bun run lint:fix         # biome check --write
bun run format           # biome format --write
bun run version          # Run version-bump.ts to sync versions
bun test                 # Run all tests
bun test src/sort.test.ts -t "pattern"   # Run a single test by name
bun run deploy           # Copy main.js + manifest.json to local vault plugin dir
```

## Architecture

### Entry Point & Commands

`src/main.ts` exports `SortLinesPlugin` (default export). `onload()` registers six commands: sort alphabetically, sort by length, sort headings, reverse, shuffle, and sort list recursively. An `Intl.Collator` is built once in `onload` and reused as `this.compare`.

`src/sort.ts` holds the pure algorithms (`sortHeadings`, `sortListLines`, `replaceLinksOnLine`, `getFrontStart`, `CHECKBOX_REGEX`) and their types (`Line`, `HeadingPart`, `ListPart`, `LinkRef`) — no runtime Obsidian dependency, so tests import them directly. `main.ts` is the thin orchestrator: editor state in, sort.ts functions, editor write back.

### Core Flow

Every command follows the same pipeline:

1. `getEditorContext(fromCurrentList)` — resolves the active `MarkdownView`, its `CachedMetadata`, and the line range. Range is either the user selection, the enclosing list (for list sort), or the whole file excluding frontmatter.
2. `getLines(ctx)` — splits editor text, produces `Line[]` with `source` (original) and `formatted` (links resolved to display text, checkboxes stripped via `CHECKBOX_REGEX`). Heading levels come from `cache.headings`.
3. Sort/permute on `Line[]` using `formatted` for comparison, `source` for output.
4. `setLines(ctx, lines)` — writes via `replaceRange` (selection) or `setValue` (whole file).

### Recursive Structures

- **Headings** (`HeadingPart`): `sortHeadings` builds a tree from heading levels; `getSortedHeadings` recurses, collecting content lines until a same-or-higher-level heading; subheadings are sorted at each level.
- **Lists** (`ListPart`): `sortListRecursively` uses `cache.listItems` (Obsidian's `ListItemCache.parent` is the parent line number, negative for top-level). `getSortedListParts` recurses by comparing parent pointers. Blank lines inside the list abort the sort.

### Build & Release

- `build.ts` uses Bun's bundler. Entry `src/main.ts` → `./main.js` (CJS, minified in prod). Externals: `obsidian`, `electron`.
- `version-bump.ts` syncs `package.json` version → `manifest.json` + `versions.json`.
- Release: push an annotated tag (e.g., `1.0.0`) to trigger GitHub Actions. Merge PRs before tagging.

### Tests

Tests live beside source as `src/*.test.ts` and use `bun test`. They import the real symbols from `src/sort.ts` — never re-implement an algorithm in a test file; if something isn't importable, extract it into `sort.ts` first.

## Code Style

Biome is the single source of truth (2-space indent, organized imports). Run `bun run lint:fix` before committing.
