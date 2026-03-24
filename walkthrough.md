# Sort Lines Plugin Walkthrough

*2026-03-24T19:38:21Z by Showboat 0.6.1*
<!-- showboat-id: c327a160-846c-4ab6-8267-d9d76601b0b0 -->

## Overview

**Sort Lines** is an Obsidian plugin that sorts and permutes lines, lists, and headings
in the active editor. It registers 11 commands via the Obsidian command palette and
operates entirely on the editor buffer — no file I/O, no settings, no persistence.

Key technologies: TypeScript, Bun (runtime, bundler, test runner), Biome (lint/format),
Obsidian Plugin API.

**Entry point:** `src/main.ts` — a single-file plugin that exports a `Plugin` subclass.

**Build output:** `main.js` (CJS, minified ~7 KB) consumed by Obsidian at runtime.

## Architecture

The project is a single-module plugin with supporting build tooling.

```bash
cat <<'HEREDOC'
.
├── src/
│   ├── main.ts            # Plugin class — all logic lives here
│   └── main.test.ts       # Unit tests (Bun test runner)
├── scripts/
│   └── validate-plugin.ts # Pre-release validation script
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
│   ├── main.ts            # Plugin class — all logic lives here
│   └── main.test.ts       # Unit tests (Bun test runner)
├── scripts/
│   └── validate-plugin.ts # Pre-release validation script
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

## Core Data Structures

The plugin defines four interfaces that model the editor content. These are local
to `main.ts` — nothing is exported except the plugin class itself.

```bash
sed -n '4,31p' src/main.ts
```

```output
interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
  checked: boolean;
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

- **Line** — Wraps a single editor line. `source` is the raw text; `formatted` has
  wiki-links and checkboxes stripped for sort comparison. `headingLevel` is set only
  for heading lines.
- **HeadingPart** — Recursive tree node for heading sort. Each heading owns content
  lines and child headings.
- **ListPart** — Recursive tree node for list sort. Each list item owns its children.
- **EditorContext** — Captures the active view, metadata cache, and the line range
  to operate on (either the selection or the full document minus frontmatter).

## Checkbox Regex

The plugin recognizes Obsidian's alternative checkbox statuses beyond just `[x]`.

```bash
sed -n '33,35p' src/main.ts
```

```output
// Matches any non-empty checkbox: [x], [X], [-], [?], [/], [!], etc.
// Intentionally broad to support Obsidian's alternative checkbox statuses.
const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/i;
```

The regex matches `- [x]`, `- [-]`, `- [?]`, `- [/]`, etc. but rejects `- [ ]`
(unchecked). The capture group `(\s*)` preserves leading indentation for the
`formatted` field after checkbox stripping.

## Plugin Initialization

`onload()` configures the locale-aware collator and registers all 11 commands.

```bash
sed -n '37,48p' src/main.ts
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
comparison.

The 11 registered commands and their dispatch targets:

```bash
grep -n 'id:' src/main.ts | sed 's/^/  /'
```

```output
  50:      id: "sort-alphabetically-with-checkboxes",
  55:      id: "sort-list-alphabetically-with-checkboxes",
  60:      id: "sort-alphabetically",
  65:      id: "sort-list-alphabetically",
  70:      id: "sort-checkboxes",
  80:      id: "sort-length",
  85:      id: "sort-headings",
  90:      id: "permute-reverse",
  95:      id: "permute-shuffle",
  107:      id: "sort-list-recursively",
  112:      id: "sort-list-recursively-with-checkboxes",
```

## Editor Context Resolution

Every command starts by calling `getEditorContext()`, which determines the line
range to operate on. This is the routing logic that decides whether to sort the
selection, the current list, or the full document.

```bash
sed -n '360,409p' src/main.ts
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
   using Obsidian's cached section metadata (filtered to `type === "list"`).
3. If a multi-line selection exists (`cursorStart !== cursorEnd`), operate on the selection.
4. Otherwise, operate on the entire document from after frontmatter to the last line.

The frontmatter boundary is `(cache.frontmatter.position.end.line ?? -1) + 1`,
which evaluates to 0 when there is no frontmatter.

## Line Extraction and Link Replacement

`getLines()` converts the editor buffer into `Line[]`, stripping wiki-links and
checkboxes from the `formatted` field so sorts compare visible text only.

```bash
sed -n '411,447p' src/main.ts
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
        checked: CHECKBOX_REGEX.test(line),
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

Key details of link replacement:

- Links are sorted **right-to-left** by column position (`b.position.start.col - a.position.start.col`)
  so that splicing one link doesn't shift the column offsets of links to its left.
- Each `[[wiki-link|display]]` is replaced by its `displayText` (or empty string if none).
- After link replacement, checkboxes are stripped: `- [x] task` becomes `task` with
  only the leading whitespace preserved.
- Heading levels are applied from the metadata cache after all lines are mapped.

## Alphabetical Sort

The simplest sort operation. With `ignoreCheckboxes: true`, it sorts purely by
formatted text. With `false`, checked items sink to the bottom.

```bash
sed -n '118,142p' src/main.ts
```

```output
  private sortAlphabetically(fromCurrentList = false, ignoreCheckboxes = true) {
    const ctx = this.getEditorContext(fromCurrentList);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const lines = this.getLines(ctx);
    if (lines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }

    if (ignoreCheckboxes) {
      lines.sort((a, b) =>
        this.compare(a.formatted.trim(), b.formatted.trim()),
      );
    } else {
      lines.sort((a, b) => {
        if (a.checked !== b.checked) return a.checked ? 1 : -1;
        return this.compare(a.formatted.trim(), b.formatted.trim());
      });
    }

    this.setLines(ctx, lines);
  }
```

All sort commands follow the same pattern: get context → get lines → guard empty →
sort → set lines. The `setLines` method writes back using `source` (the original
text), preserving links and formatting that were stripped only for comparison.

## Recursive List Sort

List-aware sorting preserves parent-child nesting. It builds a tree from Obsidian's
`ListItemCache` metadata, sorts siblings at each level, then flattens back to lines.

```bash
sed -n '196,239p' src/main.ts
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

  private listPartToList(list: ListPart): Line[] {
    return list.children.reduce<Line[]>(
      (acc, cur) => acc.concat(this.listPartToList(cur)),
      [list.title],
    );
  }
```

The recursive tree-building uses Obsidian's `ListItemCache.parent` field — a line
number pointing to the parent item, or a negative value for top-level items. The
while-loop advances through consecutive lines, recursing into children when the
parent pointer indicates deeper nesting. After collecting all children, siblings
are sorted and the tree is flattened back to lines via `listPartToList`.

## Heading Sort

Heading sort builds a tree where each heading owns its content lines and sub-headings,
then sorts siblings alphabetically within the same heading level.

```bash
sed -n '270,310p' src/main.ts
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
      headings: headings.sort((a, b) => {
        const res = (a.title.headingLevel ?? 0) - (b.title.headingLevel ?? 0);
        if (res === 0) {
          return this.compare(
            a.title.formatted.trim(),
            b.title.formatted.trim(),
          );
        }
        return res;
      }),
      title: heading,
    };
  }
```

The heading sort walks lines linearly. When it encounters a heading of deeper level,
it recurses. When it hits a heading of equal or shallower level, it returns — that
heading belongs to a sibling or ancestor. Content lines (non-headings) under a heading
are preserved in order. Siblings are sorted first by heading level, then alphabetically.

## Permutations: Reverse and Shuffle

Reverse is trivial (`lines.reverse()`). Shuffle uses a Fisher-Yates algorithm,
replacing the original dependency on Obsidian's `Array.prototype.shuffle()` patch.

```bash
sed -n '342,358p' src/main.ts
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

After sorting, `setLines` writes the `source` text (preserving original formatting)
back to the editor using either `replaceRange` (selection) or `setValue` (whole document).

```bash
sed -n '449,462p' src/main.ts
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

## Build System

`build.ts` uses Bun's native bundler. Externals (`obsidian`, `electron`) are not
bundled — Obsidian provides them at runtime.

```bash
cat build.ts
```

```output
const watch = process.argv.includes("--watch");

const result = await Bun.build({
  entrypoints: ["src/main.ts"],
  outdir: ".",
  format: "cjs",
  external: ["obsidian", "electron"],
  minify: !watch,
});

if (!result.success) {
  console.error("Build failed");
  for (const message of result.logs) console.error(message);
  process.exit(1);
}

if (watch) console.log("Watching for changes...");

export {};
```

## CI and Release Workflows

**CI** (`main.yml`) runs on push to main and pull requests: audit, check (typecheck + biome), test.

**Release** (`release.yml`) triggers on semver tags matching `[0-9]*.[0-9]*.[0-9]*`.
It runs the full validation pipeline, then creates a GitHub release with `main.js`
and `manifest.json` as downloadable assets.

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
          bun run validate

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

The test suite (`src/main.test.ts`) uses Bun's test runner. Tests duplicate the
core algorithms from the plugin class as standalone functions — necessary because
the plugin class depends on Obsidian's runtime APIs which aren't available in a
test environment.

```bash
grep -n '^describe' src/main.test.ts
```

```output
30:describe("alphabetical sort", () => {
50:describe("alphabetical sort with checkboxes", () => {
89:describe("sort by length", () => {
109:describe("reverse", () => {
123:describe("fisher-yates shuffle", () => {
148:describe("heading sort", () => {
235:describe("link replacement by positional splicing", () => {
334:describe("checkbox regex", () => {
370:describe("frontmatter boundary calculation", () => {
```

```bash
bun test 2>&1 | sed 's/\[.*\]/[...]/' | grep -E '(pass|fail|expect|Ran)'
```

```output
 32 pass
 0 fail
 32 expect() calls
Ran 32 tests across 1 file. [...]
```

## Concerns

### Code Duplication Between Plugin and Tests

The test file duplicates core algorithms (heading sort, link replacement, checkbox
regex, frontmatter boundary calculation) as standalone functions rather than importing
from the plugin. This is a practical tradeoff — the plugin class depends on Obsidian's
runtime — but it means algorithm changes must be mirrored in two places. Extracting
pure logic into a separate module would allow direct imports in tests.

### Single-File Architecture

All plugin logic lives in one 463-line file. While still manageable, it's approaching
the size where extracting modules would improve navigability:
- Sorting algorithms (alphabetical, heading, list) into their own files
- Editor context and line extraction as a separate module
- Data type definitions into a types file

### `Math.random()` for Shuffle

The Fisher-Yates shuffle uses `Math.random()`, which is fine for a UI shuffle but
is not cryptographically secure. This is acceptable for the use case.

### No `styles.css` in Release Assets

The release workflow publishes `main.js` and `manifest.json` but not `styles.css`.
This is correct — the plugin has no custom styles — but Obsidian's community plugin
submission checklist expects it. If styles are added later, the workflow needs updating.

### `deploy` Script Hardcodes a Path

The `package.json` `deploy` script copies to a specific local vault path. This is
fine for personal use but would trip up other contributors.

