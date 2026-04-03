# Sort Lines Plugin Walkthrough

*2026-03-24T20:36:51Z by Showboat 0.6.1*
<!-- showboat-id: 791a93ab-7e89-4455-a168-6b8dc640a690 -->

## Overview

**Sort Lines** is an Obsidian plugin that sorts and permutes lines, lists, and headings
in the active editor. It registers 6 commands via the Obsidian command palette and
operates entirely on the editor buffer — no file I/O, no settings, no persistence.

Key technologies: TypeScript, Bun (runtime, bundler, test runner), Biome (lint/format),
Obsidian Plugin API.

**Entry point:** `src/main.ts` — a single-file plugin that exports a `Plugin` subclass.

**Build output:** `main.js` (CJS, minified ~6 KB) consumed by Obsidian at runtime.

## Architecture

```bash
cat <<'HEREDOC'
.
├── src/
│   ├── main.ts            # Plugin class — all logic lives here (406 lines)
│   └── main.test.ts       # Unit tests (252 lines, 15 tests)
├── build.ts               # Bun bundler config
├── version-bump.ts        # Syncs version to manifest + versions.json
├── biome.json             # Formatter/linter config
├── tsconfig.json          # TypeScript config (strict, noEmit)
├── manifest.json          # Obsidian plugin manifest
├── versions.json          # Obsidian version compatibility map
├── package.json           # Dependencies and scripts
└── .github/workflows/
    ├── main.yml           # CI: audit, check, test on push/PR
    └── release.yml        # Release: validate, build, publish on tag
HEREDOC
```

```output
.
├── src/
│   ├── main.ts            # Plugin class — all logic lives here (406 lines)
│   └── main.test.ts       # Unit tests (252 lines, 15 tests)
├── build.ts               # Bun bundler config
├── version-bump.ts        # Syncs version to manifest + versions.json
├── biome.json             # Formatter/linter config
├── tsconfig.json          # TypeScript config (strict, noEmit)
├── manifest.json          # Obsidian plugin manifest
├── versions.json          # Obsidian version compatibility map
├── package.json           # Dependencies and scripts
└── .github/workflows/
    ├── main.yml           # CI: audit, check, test on push/PR
    └── release.yml        # Release: validate, build, publish on tag
```

## Data Structures

Four interfaces model editor content. All are local to `main.ts`.

```bash
sed -n '4,30p' src/main.ts
```

```output
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

- **Line** — Wraps a single editor line. `source` is raw text; `formatted` has
  wiki-links and checkboxes stripped for sort comparison. `headingLevel` is set
  only for heading lines.
- **HeadingPart** — Recursive tree node for heading sort. Each heading owns
  content lines and child headings.
- **ListPart** — Recursive tree node for list sort. Each list item owns children.
- **EditorContext** — The active view, metadata cache, and line range to operate on.

## Checkbox Regex

Strips checkbox markup from `formatted` so `- [x] apple` sorts as `apple`.

```bash
sed -n '32,34p' src/main.ts
```

```output
// Matches any non-empty checkbox: [x], [X], [-], [?], [/], [!], etc.
// Intentionally broad to support Obsidian's alternative checkbox statuses.
const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/i;
```

## Plugin Initialization

`onload()` configures a locale-aware collator and registers all 6 commands.

```bash
sed -n '36,46p' src/main.ts
```

```output
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
```

The collator uses `navigator.language` for locale-aware sorting, with `numeric: true`
so "item 2" sorts before "item 10", and `sensitivity: "base"` for case-insensitive
comparison. The 6 commands:

```bash
grep -n 'id:' src/main.ts | sed 's/^/  /'
```

```output
  49:      id: "sort-alphabetically",
  54:      id: "sort-length",
  59:      id: "sort-headings",
  64:      id: "permute-reverse",
  69:      id: "permute-shuffle",
  75:      id: "sort-list-recursively",
```

## Editor Context Resolution

Every command starts by calling `getEditorContext()`, which determines the line
range to operate on.

```bash
sed -n '304,353p' src/main.ts
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

Resolution logic:

1. Get the active markdown view and its metadata cache.
2. If `fromCurrentList` is true, find the list section containing the cursor
   (filtered to `type === "list"`).
3. If a multi-line selection exists, operate on the selection.
4. Otherwise, operate on the entire document from after frontmatter to the last line.

## Line Extraction and Link Replacement

`getLines()` converts the editor buffer into `Line[]`, stripping wiki-links and
checkboxes from `formatted` so sorts compare visible text only.

```bash
sed -n '355,390p' src/main.ts
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

Links are sorted right-to-left by column so splicing one doesn't shift offsets of
links to its left. Each `[[wiki-link|display]]` is replaced by its `displayText`.
Checkbox markup is stripped so `- [x] apple` sorts as `apple`.

## Alphabetical Sort

The simplest command — sorts by `formatted` text using the locale collator.

```bash
sed -n '84,97p' src/main.ts
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

All sort commands follow the same pattern: get context, get lines, guard empty,
sort, set lines. `setLines` writes back using `source` (original text), preserving
links and formatting that were stripped only for comparison.

## Recursive List Sort

Preserves parent-child nesting. Builds a tree from Obsidian's `ListItemCache`
metadata, sorts siblings at each level, then flattens back to lines.

```bash
sed -n '156,192p' src/main.ts
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

The recursive tree-building uses Obsidian's `ListItemCache.parent` field — a line
number pointing to the parent item, or a negative value for top-level items. After
collecting all children, siblings are sorted and the tree is flattened via a local
`flatten` function in `sortListRecursively`.

## Heading Sort

Builds a tree where each heading owns its content lines and sub-headings, then
sorts siblings alphabetically.

```bash
sed -n '221,254p' src/main.ts
```

```output
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

Walks lines linearly. When it encounters a deeper heading, it recurses. When it
hits an equal or shallower heading, it returns. Content lines under a heading are
preserved in order. Siblings are sorted purely alphabetically. The result is
flattened via a local `flatten` function in `sortHeadings`.

## Permutations: Reverse and Shuffle

Reverse is `lines.reverse()`. Shuffle uses Fisher-Yates.

```bash
sed -n '286,302p' src/main.ts
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

```bash
sed -n '392,405p' src/main.ts
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

Uses `replaceRange` for selections and `setValue` for whole-document operations.
Always writes `source` (original text), preserving formatting stripped for comparison.

## Build System

```bash
cat build.ts
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

Bun's native bundler. Externals (`obsidian`, `electron`) are provided by Obsidian
at runtime.

## CI and Release Workflows

**CI** runs on push to main and PRs: audit, check (typecheck + biome), test.
**Release** triggers on semver tags, builds the plugin, creates a GitHub release.

```bash
cat .github/workflows/main.yml
```

```output
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest
      - run: bun install
      - run: bun audit --audit-level=critical
      - run: bun run check
      - run: bun test
```

```bash
cat .github/workflows/release.yml
```

```output
name: Release

on:
  push:
    tags:
      - "[0-9]*.[0-9]*.[0-9]*"

permissions:
  contents: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: |
          bun install
          bun run build

      - name: Create release
        uses: softprops/action-gh-release@v2
        with:
          files: |
            main.js
            manifest.json
          fail_on_unmatched_files: true
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## Tests

The test suite uses Bun's test runner. Tests duplicate core algorithms as standalone
functions since the plugin class depends on Obsidian's runtime APIs.

```bash
grep -n '^describe' src/main.test.ts
```

```output
28:describe("heading sort", () => {
111:describe("link replacement by positional splicing", () => {
210:describe("checkbox regex", () => {
226:describe("frontmatter boundary calculation", () => {
```

```bash
bun test 2>&1 | grep -E '^\s+[0-9]+ (pass|fail|expect)|^Ran' | sed 's/ \[.*$//'
```

```output
 15 pass
 0 fail
 15 expect() calls
Ran 15 tests across 1 file.
```

## Concerns

### Code Duplication Between Plugin and Tests

The test file duplicates core algorithms (heading sort, link replacement, checkbox
regex, frontmatter boundary) as standalone functions. Algorithm changes must be
mirrored in two places. Extracting pure logic into a separate module would allow
direct imports in tests.

### `deploy` Script Hardcodes a Path

The `package.json` `deploy` script copies to a specific local vault path. Fine for
personal use but would trip up other contributors.

### No `styles.css` in Release Assets

The plugin has no custom styles, so this is correct. If styles are added later,
the release workflow needs updating.
