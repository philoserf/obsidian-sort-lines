# Obsidian Sort Lines Walkthrough

*2026-04-03T18:39:39Z by Showboat 0.6.1*
<!-- showboat-id: e48df6e0-14f0-49d0-beb3-efd522fc11d3 -->

## Overview

Obsidian Sort Lines is an Obsidian plugin (v2.0.0) that sorts and permutes lines, lists, and headings within markdown notes. It provides six commands: alphabetical sort, length sort, heading sort, recursive list sort, reverse, and shuffle. The entire plugin is a single TypeScript file (`src/main.ts`, ~406 lines) built with Bun's bundler into a CommonJS module for Obsidian's plugin loader.

Key technologies: TypeScript, Bun (runtime, bundler, test runner), Biome (lint/format), Obsidian Plugin API.

## Project Structure

```bash
cat <<'HEREDOC'
.
├── build.ts            # Bun bundler script
├── src/
│   ├── main.ts         # Plugin source (single-file architecture)
│   └── main.test.ts    # Unit tests (Bun test runner)
├── main.js             # Built output (committed for Obsidian)
├── manifest.json       # Obsidian plugin manifest
├── versions.json       # Version → minAppVersion mapping
├── version-bump.ts     # Syncs version across manifests
├── package.json        # Scripts, dependencies
├── biome.json          # Lint/format config
└── tsconfig.json       # TypeScript config
HEREDOC
```

```output
.
├── build.ts            # Bun bundler script
├── src/
│   ├── main.ts         # Plugin source (single-file architecture)
│   └── main.test.ts    # Unit tests (Bun test runner)
├── main.js             # Built output (committed for Obsidian)
├── manifest.json       # Obsidian plugin manifest
├── versions.json       # Version → minAppVersion mapping
├── version-bump.ts     # Syncs version across manifests
├── package.json        # Scripts, dependencies
├── biome.json          # Lint/format config
└── tsconfig.json       # TypeScript config
```

## Build System

The build uses Bun's native bundler via `build.ts`. It compiles `src/main.ts` to CommonJS (Obsidian's required format), externalizes `obsidian` and `electron` (provided by the host), and minifies for production. The `bun run build` script runs checks first (typecheck + biome), then builds.

```bash
head -15 build.ts
```

```output
const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: ".",
  format: "cjs",
  external: ["obsidian", "electron"],
  minify: true,
});

if (!result.success) {
  console.error("Build failed");
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

export {};
```

## Core Data Types

The plugin defines four interfaces that model the data it operates on. `Line` is the fundamental unit — it carries both the original `source` text (for writing back) and a `formatted` version (with links resolved and checkboxes stripped) used for sort comparisons. `HeadingPart` and `ListPart` are recursive tree structures for heading and list sorting. `EditorContext` captures the current editor state and selection bounds.

```bash
head -31 src/main.ts
```

```output
import type { CachedMetadata, ListItemCache } from "obsidian";
import { MarkdownView, Notice, Plugin } from "obsidian";

interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
}

interface HeadingPart {
  to: number;
  title: Line;
  lines: Line[];
  headings: HeadingPart[];
}

interface ListPart {
  children: ListPart[];
  title: Line;
  lastLine: number;
}

interface EditorContext {
  view: MarkdownView;
  cache: CachedMetadata;
  start: number;
  end: number;
  endLineLength: number;
}

```

## Plugin Entry Point and Collator

`SortLinesPlugin` extends Obsidian's `Plugin` base class. On load, it creates an `Intl.Collator` for locale-aware, case-insensitive, numeric-aware sorting. This collator is used throughout for alphabetical comparisons. The plugin registers six commands, each wired to a private method.

```bash
head -82 src/main.ts | tail -49
```

```output
const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/i;

export default class SortLinesPlugin extends Plugin {
  private compare!: (x: string, y: string) => number;

  override onload() {
    const { compare } = new Intl.Collator(navigator.language, {
      usage: "sort",
      sensitivity: "base",
      numeric: true,
      ignorePunctuation: true,
    });
    this.compare = compare;

    this.addCommand({
      id: "sort-alphabetically",
      name: "Sort alphabetically",
      callback: () => this.sortAlphabetically(),
    });
    this.addCommand({
      id: "sort-length",
      name: "Sort by length of line",
      callback: () => this.sortLengthOfLine(),
    });
    this.addCommand({
      id: "sort-headings",
      name: "Sort headings",
      callback: () => this.sortHeadings(),
    });
    this.addCommand({
      id: "permute-reverse",
      name: "Reverse lines",
      callback: () => this.permuteReverse(),
    });
    this.addCommand({
      id: "permute-shuffle",
      name: "Shuffle lines",
      callback: () => this.permuteShuffle(),
    });

    this.addCommand({
      id: "sort-list-recursively",
      name: "Sort current list recursively",
      callback: () =>
        this.sortListRecursively((a, b) =>
          this.compare(a.title.formatted.trim(), b.title.formatted.trim()),
        ),
    });
  }
```

The `CHECKBOX_REGEX` pattern (`/^(\s*)- \[[^ ]\]/i`) matches any checked checkbox (including alternative statuses like `[-]`, `[?]`, `[/]`). It intentionally does *not* match unchecked `[ ]` — the space character exclusion `[^ ]` is the key. This is used later to strip checkbox prefixes from the `formatted` field so sort comparisons use the task text, not the checkbox marker.

## Editor Context Resolution

`getEditorContext()` determines what to sort. It handles two modes:

1. **Selection mode**: If the cursor spans multiple lines, sort just those lines.
2. **Whole-document mode**: If no selection, sort from after frontmatter to end of file.

For `fromCurrentList: true` (recursive list sort), it finds the list section containing the cursor using Obsidian's `cache.sections` and expands the range to cover the entire list.

```bash
head -353 src/main.ts | tail -50
```

```output
  private getEditorContext(
    fromCurrentList: boolean,
  ): EditorContext | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;

    const cache = this.app.metadataCache.getFileCache(view.file);
    if (!cache) return;

    const editor = view.editor;
    let cursorStart = editor.getCursor("from").line;
    let cursorEnd = editor.getCursor("to").line;

    if (fromCurrentList) {
      const list = cache.sections?.find(
        (e) =>
          e.type === "list" &&
          e.position.start.line <= cursorStart &&
          e.position.end.line >= cursorEnd,
      );
      if (list) {
        cursorStart = list.position.start.line;
        cursorEnd = list.position.end.line;
      }
    }

    const cursorEndLineLength = editor.getLine(cursorEnd).length;
    const frontStart = (cache.frontmatter?.position?.end?.line ?? -1) + 1;

    const frontEnd = editor.lastLine();
    const frontEndLineLength = editor.getLine(frontEnd).length;

    if (cursorStart !== cursorEnd) {
      return {
        view,
        cache,
        start: cursorStart,
        end: cursorEnd,
        endLineLength: cursorEndLineLength,
      };
    }

    return {
      view,
      cache,
      start: frontStart,
      end: frontEnd,
      endLineLength: frontEndLineLength,
    };
  }
```

## Line Extraction and Link Resolution

`getLines()` is the preprocessing pipeline. It splits the editor content into lines, then for each line:

1. **Resolves wiki-links and embeds** — Obsidian's cache provides link positions. Links are replaced right-to-left (to preserve column offsets) with their `displayText`. This means `[[Some Page|alias]]` becomes `alias` for sorting purposes.
2. **Strips checked checkboxes** — The `CHECKBOX_REGEX` replaces checked checkbox prefixes (e.g., `- [x]`) with just the indentation, so tasks sort by their text content.
3. **Annotates heading levels** — Heading metadata from the cache is mapped onto the corresponding line objects.

The right-to-left link replacement is a clean technique: by processing from the end of the string backward, earlier column positions remain valid.

```bash
head -390 src/main.ts | tail -36
```

```output
  private getLines(ctx: EditorContext): Line[] {
    const lines = ctx.view.editor.getValue().split("\n");
    const links = [...(ctx.cache.links ?? []), ...(ctx.cache.embeds ?? [])];

    const mapped = lines.map((line, index) => {
      const result: Line = {
        source: line,
        formatted: line,
        headingLevel: undefined,
        lineNumber: index,
      };

      const lineLinks = links
        .filter((link) => link.position.start.line === index)
        .sort((a, b) => b.position.start.col - a.position.start.col);
      for (const link of lineLinks) {
        result.formatted =
          result.formatted.substring(0, link.position.start.col) +
          (link.displayText ?? "") +
          result.formatted.substring(link.position.end.col);
      }

      result.formatted = result.formatted.replace(CHECKBOX_REGEX, "$1");

      return result;
    });

    for (const heading of ctx.cache.headings ?? []) {
      mapped[heading.position.start.line].headingLevel = heading.level;
    }

    if (ctx.start !== ctx.end) {
      return mapped.slice(ctx.start, ctx.end + 1);
    }
    return mapped;
  }
```

## Sort Commands

### Alphabetical Sort

The simplest sort: get lines, sort by `formatted` text using the `Intl.Collator`, write back. All commands follow this pattern: `getEditorContext` → `getLines` → transform → `setLines`.

```bash
head -97 src/main.ts | tail -14
```

```output
  private sortAlphabetically() {
    const ctx = this.getEditorContext(false);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const lines = this.getLines(ctx);
    if (lines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    lines.sort((a, b) => this.compare(a.formatted.trim(), b.formatted.trim()));
    this.setLines(ctx, lines);
  }
```

### Sort by Length

Sorts by the length of the `formatted` string (after link resolution and checkbox stripping). Shortest lines come first.

```bash
head -269 src/main.ts | tail -14
```

```output
  private sortLengthOfLine() {
    const ctx = this.getEditorContext(false);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const lines = this.getLines(ctx);
    if (lines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    lines.sort((a, b) => a.formatted.length - b.formatted.length);
    this.setLines(ctx, lines);
  }
```

### Heading Sort

This is the most complex sort. It builds a recursive tree of `HeadingPart` nodes where each heading owns its content lines and sub-headings. The algorithm:

1. Walk lines sequentially from `from` index
2. If a line has a heading level deeper than the current parent, recurse into it
3. Non-heading lines become content of the current heading
4. Stop when encountering a heading at the same or higher level (a sibling or parent boundary)
5. Sort sibling headings alphabetically at each level
6. Flatten the tree back to lines

The tree structure preserves the hierarchical relationship — sorting `## B` before `## A` also moves all content under each heading.

```bash
head -254 src/main.ts | tail -61
```

```output
  private sortHeadings() {
    const ctx = this.getEditorContext(false);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const lines = this.getLines(ctx);
    if (lines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    const res = this.getSortedHeadings(lines, 0, {
      headingLevel: 0,
      formatted: "",
      source: "",
      lineNumber: -1,
    });
    const flatten = (h: HeadingPart): Line[] => {
      const list = [h.title, ...h.lines];
      for (const sub of h.headings) {
        list.push(...flatten(sub));
      }
      return list;
    };
    this.setLines(ctx, flatten(res).slice(1));
  }

  private getSortedHeadings(
    lines: Line[],
    from: number,
    heading: Line,
  ): HeadingPart {
    const headings: HeadingPart[] = [];
    const contentLines: Line[] = [];
    let currentIndex = from;

    while (currentIndex < lines.length) {
      const current = lines[currentIndex];
      if ((current.headingLevel ?? 0) <= (heading.headingLevel ?? 0)) break;

      if (current.headingLevel) {
        headings.push(this.getSortedHeadings(lines, currentIndex + 1, current));
        currentIndex = headings.at(-1)?.to ?? currentIndex;
      } else {
        contentLines.push(current);
      }
      currentIndex++;
    }

    return {
      lines: contentLines,
      to:
        headings.length > 0
          ? (headings.at(-1)?.to ?? currentIndex - 1)
          : currentIndex - 1,
      headings: headings.sort((a, b) =>
        this.compare(a.title.formatted.trim(), b.title.formatted.trim()),
      ),
      title: heading,
    };
  }
```

### Recursive List Sort

Uses Obsidian's `ListItemCache` to understand list hierarchy. Each cache entry has a `parent` field (line number of parent, or negative for top-level items). The algorithm builds a `ListPart` tree by checking whether the next line's parent pointer is deeper than the current item's, then sorts children at each level. The while-loop condition at lines 173–177 is the trickiest part — it determines child membership by comparing parent pointers.

```bash
head -192 src/main.ts | tail -38
```

```output

  private getSortedListParts(
    lines: Line[],
    cacheMap: Map<number, ListItemCache>,
    index: number,
    compareFn: (a: ListPart, b: ListPart) => number,
  ): ListPart {
    const children: ListPart[] = [];
    const startListCache = cacheMap.get(index);
    if (!startListCache)
      return { children: [], title: lines[index], lastLine: index };
    const title = lines[index];

    // Obsidian's ListItemCache.parent is the line number of the parent item,
    // or a negative value for top-level items (no parent).
    // This loop collects children: the next line is a child if:
    //   1. Its parent pointer is deeper than ours (nested under us), OR
    //   2. We're top-level (parent < 0) and the next item has any parent (is nested)
    while (
      startListCache.parent < (cacheMap.get(index + 1)?.parent ?? -1) ||
      (startListCache.parent < 0 &&
        (cacheMap.get(index + 1)?.parent ?? -1) >= 0)
    ) {
      index++;
      const newChild = this.getSortedListParts(
        lines,
        cacheMap,
        index,
        compareFn,
      );
      index = newChild.lastLine ?? index;
      children.push(newChild);
    }

    const lastLine = children.at(-1)?.lastLine ?? index;
    children.sort(compareFn);
    return { children, title, lastLine };
  }
```

### Permutations: Reverse and Shuffle

Reverse is trivial (`Array.reverse()`). Shuffle uses the Fisher-Yates algorithm — the standard unbiased in-place shuffle that iterates backward, swapping each element with a random earlier element.

```bash
head -302 src/main.ts | tail -17
```

```output
  private permuteShuffle() {
    const ctx = this.getEditorContext(false);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const lines = this.getLines(ctx);
    if (lines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    this.setLines(ctx, lines);
  }
```

## Writing Back: setLines

`setLines()` converts the sorted `Line[]` back to text using `source` (preserving original formatting). In selection mode, it uses `editor.replaceRange()` to replace just the selected lines. In whole-document mode, it uses `editor.setValue()`.

```bash
head -405 src/main.ts | tail -14
```

```output
  private setLines(ctx: EditorContext, lines: Line[]) {
    const editor = ctx.view.editor;
    const text = lines.map((e) => e.source).join("\n");

    if (ctx.start !== ctx.end) {
      editor.replaceRange(
        text,
        { line: ctx.start, ch: 0 },
        { line: ctx.end, ch: ctx.endLineLength },
      );
    } else {
      editor.setValue(text);
    }
  }
```

## Version Management

`version-bump.ts` syncs the version from `package.json` into `manifest.json` and `versions.json`. It reads the version from `npm_package_version` (set by `bun run version`), updates the manifest's version field, and adds a new entry to `versions.json` mapping the version to its minimum Obsidian app version.

```bash
head -19 version-bump.ts
```

```output
import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  throw new Error("No version found in package.json");
}

// Update manifest.json
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

// Update versions.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, 2)}\n`);

console.log(`Updated to version ${targetVersion}`);
```

```bash
rg -c 'test\(' src/main.test.ts
```

```output
18
```

Four test suites cover: heading sort (2 tests), link replacement by positional splicing (5 tests), checkbox regex (3 tests), and frontmatter boundary calculation (5 tests). Three tests have been removed from the count (the `describe` blocks themselves match the pattern).

```bash
rg 'describe\(' src/main.test.ts
```

```output
describe("heading sort", () => {
describe("link replacement by positional splicing", () => {
describe("checkbox regex", () => {
describe("frontmatter boundary calculation", () => {
```

## Concerns

### Code Quality

1. **Duplicated logic between source and tests** — The test file re-implements `getSortedHeadings`, `replaceLinks`, and the checkbox regex instead of importing from `src/main.ts`. This means the tested code and production code can diverge. The production methods are private instance methods on the plugin class, making direct import impractical, but extracting them as standalone exported functions would improve testability and reduce duplication.

2. **`getLines()` processes ALL lines, then slices** — Line 356 calls `getValue().split("\n")` on the entire document, processes every line (link resolution, checkbox stripping, heading annotation), then at line 388 slices to just the selected range. For large documents with a small selection, this does unnecessary work. Not a practical concern for typical Obsidian notes, but architecturally wasteful.

3. **No `onunload()` implementation** — The plugin doesn't override `onunload()`. Obsidian's `Plugin` base class handles command cleanup automatically, so this is technically fine, but community plugin guidelines recommend implementing it for clarity.

### Community Standards

4. **Tests excluded from `tsconfig.json`** — Line 13 of `tsconfig.json` excludes `src/**/*.test.ts`. This means test files don't get type-checked by `bun run typecheck`. Bun's test runner handles this at runtime, but IDE type-checking and the CI check script won't catch type errors in tests.

5. **Built output committed to repo** — `main.js` is committed to the repository. This is standard for Obsidian plugins (required for manual installation via git clone), but creates merge conflicts and noisy diffs. The release workflow should handle distributing the built artifact.

6. **`deploy` script uses hardcoded path** — The `deploy` script in `package.json` copies to a hardcoded path (`~/source/philoserf/notes/.obsidian/plugins/sort-lines/`). This is fine for the author's workflow but won't work for contributors.

### Robustness

7. **No sort stability guarantee** — `Array.sort()` is stable in all modern engines (V8, JSC, SpiderMonkey), but the code doesn't document this assumption. Heading and list sorts rely on stability to preserve the relative order of equal elements.

8. **`fromCurrentList` falls back silently** — If `fromCurrentList` is true but the cursor isn't in a list, `getEditorContext` doesn't expand the range but still returns a context. The `sortListRecursively` method then checks `cache.listItems` separately. This split validation makes the error path harder to follow.

