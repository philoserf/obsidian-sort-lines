# Sort Lines Plugin — Code Walkthrough

*2026-03-09T04:20:28Z by Showboat 0.6.1*
<!-- showboat-id: f68d128b-b40e-4fca-96a1-d0ae9da69843 -->

## Overview

**Sort Lines** is an Obsidian plugin that provides 11 commands for sorting and permuting
text within markdown notes. The entire implementation lives in a single file (`src/main.ts`,
412 lines) with unit tests alongside it in `src/main.test.ts`.

The plugin follows a consistent 4-phase pipeline for every operation:

1. **Context** — Determine scope (selection, current list, or full document)
2. **Parse** — Extract lines with metadata (headings, checkboxes, links)
3. **Transform** — Sort or permute the lines
4. **Write** — Replace editor content with the result

Let's trace this pipeline from initialization through each algorithm.

## Project Structure

```bash
find . -not -path "./.git/*" -not -path "./node_modules/*" -not -path "./.bun/*" -not -path "./.claude/*" -not -path "./planning/*" | sort
```

```output
.
./.git
./.github
./.github/dependabot.yml
./.github/settings.yml
./.github/workflows
./.github/workflows/main.yml
./.github/workflows/release.yml
./.gitignore
./assets
./assets/example.gif
./biome.json
./build.ts
./bun.lock
./CHANGELOG.md
./CLAUDE.md
./LICENSE
./main.js
./manifest.json
./node_modules
./package.json
./README.md
./scripts
./scripts/validate-plugin.ts
./src
./src/main.test.ts
./src/main.ts
./tsconfig.json
./version-bump.ts
./versions.json
./walkthrough.md
```

Key files:

- `src/main.ts` — Complete plugin implementation (412 lines)
- `src/main.test.ts` — Unit tests (232 lines)
- `build.ts` — Bun bundler config → outputs `main.js` (CommonJS, minified)
- `manifest.json` — Obsidian plugin metadata
- `scripts/validate-plugin.ts` — Pre-release validation checks

The build externalizes `obsidian` and `electron` (provided by Obsidian at runtime) and
produces a single `main.js` in CommonJS format — Obsidian's required module format.

## Data Types

The plugin defines four interfaces that model its domain. Let's look at each.

### Line

The fundamental unit. Every line in the editor becomes a `Line` object with both its
original text (`source`, preserved for writing back) and a normalized form (`formatted`,
used for comparison). This separation is the key insight — sort on the clean form, write
back the original.

```bash
sed -n '4,10p' src/main.ts
```

```output
interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
  checked: boolean;
}
```

### HeadingPart

A recursive tree for heading hierarchy. Each heading owns its content lines and child
headings. The `to` field tracks the last line index so the parent knows where this
section ends.

```bash
sed -n '12,17p' src/main.ts
```

```output
interface HeadingPart {
  to: number;
  title: Line;
  lines: Line[];
  headings: HeadingPart[];
}
```

### ListPart

Similar recursive tree for list items. Each item has children (nested sub-items) and
tracks `lastLine` so the iteration knows where to resume after processing a subtree.

```bash
sed -n '19,23p' src/main.ts
```

```output
interface ListPart {
  children: ListPart[];
  title: Line;
  lastLine: number;
}
```

### EditorContext

Encapsulates everything needed for one operation: the active view, Obsidian's metadata
cache, and the line range to operate on.

```bash
sed -n '25,31p' src/main.ts
```

```output
interface EditorContext {
  view: MarkdownView;
  cache: CachedMetadata;
  start: number;
  end: number;
  endLineLength: number;
}
```

### Checkbox Detection

A single regex handles checkbox detection throughout the plugin. It matches any
`- [x]` pattern where `x` is any non-space character — so `[x]`, `[X]`, `[/]`, `[-]`
all count as "checked."

```bash
sed -n '33p' src/main.ts
```

```output
const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/i;
```

> **Concern (issue #17):** The `[^ ]` character class is deliberately broad — it treats
> alternative checkbox statuses (`[-]`, `[?]`, `[/]`) as "checked." This works for
> Obsidian's extended checkbox ecosystem but may surprise users who expect only `[x]`/`[X]`
> to count. The behavior is undocumented.

## Plugin Initialization

`onload()` does two things: creates a locale-aware string comparator and registers all
11 commands. The comparator is the foundation of every sort operation.

```bash
sed -n '38,46p' src/main.ts
```

```output
  override onload() {
    const { compare } = new Intl.Collator(navigator.language, {
      usage: "sort",
      sensitivity: "base",
      numeric: true,
      ignorePunctuation: true,
    });
    this.compare = compare;

```

The `Intl.Collator` settings mean:

- **`sensitivity: "base"`** — case-insensitive, accent-insensitive ("a" = "A" = "á")
- **`numeric: true`** — "item 2" sorts before "item 10" (not lexicographic)
- **`ignorePunctuation: true`** — leading dashes, bullets, etc. don't affect order
- **`navigator.language`** — uses the user's locale, so sort order adapts internationally

### Command Registration

The plugin registers 11 commands, each a thin wrapper around one of five core methods.
Here's the full command table:

```bash
grep -n 'id:' src/main.ts
```

```output
48:      id: "sort-alphabetically-with-checkboxes",
53:      id: "sort-list-alphabetically-with-checkboxes",
58:      id: "sort-alphabetically",
63:      id: "sort-list-alphabetically",
68:      id: "sort-checkboxes",
78:      id: "sort-length",
83:      id: "sort-headings",
88:      id: "permute-reverse",
93:      id: "permute-shuffle",
105:      id: "sort-list-recursively",
110:      id: "sort-list-recursively-with-checkboxes",
```

The commands map to five core methods:

| Method | Commands | Scope |
|---|---|---|
| `sortAlphabetically()` | 4 commands | selection/doc or current list, ± checkboxes |
| `sortListRecursively()` | 3 commands | current list (checkbox, alphabetical, both) |
| `sortHeadings()` | 1 command | full document |
| `sortLengthOfLine()` | 1 command | selection/document |
| `permuteReverse()` / `permuteShuffle()` | 2 commands | selection/document |

Two helper comparators are defined inline for the recursive list commands:

```bash
sed -n '98,103p' src/main.ts
```

```output
    const alphabetical = (a: ListPart, b: ListPart) =>
      this.compare(a.title.formatted.trim(), b.title.formatted.trim());
    const alphabeticalWithCheckboxes = (a: ListPart, b: ListPart) => {
      if (a.title.checked !== b.title.checked) return a.title.checked ? 1 : -1;
      return this.compare(a.title.formatted.trim(), b.title.formatted.trim());
    };
```

## Phase 1: Editor Context Resolution

Every command starts by calling `getEditorContext()` to determine *what text to operate on*.
This is the most complex piece of the pipeline because it handles three different scopes.

```bash
sed -n '311,360p' src/main.ts
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
          e.position.start.line <= cursorStart &&
          e.position.end.line >= cursorEnd,
      );
      if (list) {
        cursorStart = list.position.start.line;
        cursorEnd = list.position.end.line;
      }
    }

    const cursorEndLineLength = editor.getLine(cursorEnd).length;
    let frontStart = (cache.frontmatter?.position?.end?.line ?? -1) + 1;
    if (Number.isNaN(frontStart)) frontStart = 0;

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

### How scope resolution works

1. **Get the active markdown view** — early return if none (silent, no user notice)
2. **Get Obsidian's metadata cache** — parsed headings, links, sections, etc.
3. **Read cursor/selection range** — `getCursor("from")` and `getCursor("to")`
4. **If `fromCurrentList`** — find the `cache.sections` entry containing the cursor
5. **Calculate frontmatter boundary** — everything after `---` closing fence
6. **Decision:**
   - If `cursorStart !== cursorEnd` (there's a selection or list range) → use that range
   - Otherwise → use the full document (after frontmatter)

> **Concern (issue #7):** The `fromCurrentList` path at line 325 searches `cache.sections`
> for *any* section containing the cursor — not just sections with `type === "list"`. A
> heading section, paragraph, or code block would also match. This means "Sort current list"
> commands can operate on non-list content.

> **Concern (issue #15):** All error paths are silent early returns. If there's no active
> editor or no cache, the user gets zero feedback — the command just does nothing.

## Phase 2: Line Parsing

`getLines()` transforms raw editor text into `Line[]` objects enriched with metadata from
Obsidian's cache.

```bash
sed -n '362,396p' src/main.ts
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

      for (const link of links) {
        if (link.position.start.line !== index) continue;
        result.formatted = result.formatted.replace(
          line.substring(link.position.start.col, link.position.end.col),
          link.displayText ?? "",
        );
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

### What `getLines()` does

1. **Splits the full document** on `\n` — gets all lines, not just the selected range
2. **Merges links and embeds** from cache into one array
3. **For each line:**
   - Sets `source` (original) and `formatted` (mutable copy)
   - Tests checkbox regex → sets `checked` boolean
   - **Replaces link/embed syntax** with display text in `formatted`. For example,
     `[[My Long Note|short]]` becomes `short` for sorting purposes
   - **Strips checkbox markers** from `formatted` using the capture group `$1` (preserving
     indentation)
4. **Maps heading levels** from cache onto the corresponding lines
5. **Slices to the requested range** if a selection/list scope exists

> **Concern (issue #5):** The link replacement at line 377 uses `String.replace()` with
> the link's raw text as the search string. `.replace()` matches the *first occurrence*
> of that substring, not the positional column. If a line contains the same link text
> twice, the wrong occurrence could be replaced. A column-based `substring` splice would
> be correct.

## Phase 3: Sorting Algorithms

### Alphabetical Sort

The simplest sort — flat comparison of `formatted` text with the locale-aware collator.
The `ignoreCheckboxes` flag toggles whether unchecked items float to the top.

```bash
sed -n '116,134p' src/main.ts
```

```output
  private sortAlphabetically(fromCurrentList = false, ignoreCheckboxes = true) {
    const ctx = this.getEditorContext(fromCurrentList);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;

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

When `ignoreCheckboxes` is false, the comparator implements a two-tier sort:
1. **Checkbox state** — unchecked (`checked: false`) sorts before checked (`checked: true`)
2. **Alphabetical** — within the same state, locale-aware comparison

This is the 4-phase pipeline in its purest form: context → parse → sort → write.

### Recursive List Sort

This is the most complex algorithm. It preserves parent-child relationships in nested
lists while sorting siblings at each level.

```bash
sed -n '136,177p' src/main.ts
```

```output
  private sortListRecursively(compareFn: (a: ListPart, b: ListPart) => number) {
    const ctx = this.getEditorContext(true);
    if (!ctx) return;
    const inputLines = this.getLines(ctx);
    if (
      inputLines.length === 0 ||
      inputLines.find((line) => line.source.trim() === "")
    )
      return;

    const firstLineNumber = inputLines.first()?.lineNumber;
    if (firstLineNumber == null) return;
    const lines = [
      ...new Array(firstLineNumber).fill(undefined),
      ...inputLines,
    ];
    let index = firstLineNumber;

    if (!ctx.cache.listItems) return;
    const cacheMap = new Map(
      ctx.cache.listItems.map((item) => [item.position.start.line, item]),
    );

    const children: ListPart[] = [];
    while (index < lines.length) {
      const newChild = this.getSortedListParts(
        lines,
        cacheMap,
        index,
        compareFn,
      );
      children.push(newChild);
      index = newChild.lastLine + 1;
    }
    children.sort(compareFn);

    const res = children.reduce<Line[]>(
      (acc, cur) => acc.concat(this.listPartToList(cur)),
      [],
    );
    this.setLines(ctx, res);
  }
```

### How recursive list sort works

1. **Guard:** Aborts silently if blank lines exist (indicates inconsistent metadata)
2. **Padding:** Creates a sparse array with `undefined` entries for lines before the list
   start, so that array indices match line numbers (Obsidian's cache uses absolute line
   numbers)
3. **Cache map:** Builds a `Map<lineNumber, ListItemCache>` for O(1) lookup of each
   line's parent pointer and depth
4. **Top-level iteration:** Walks through lines, calling `getSortedListParts()` for each
   top-level item to build its subtree
5. **Sort top-level children** with the provided comparator
6. **Flatten** the tree back to a linear array via `listPartToList()`

The recursive descent happens in `getSortedListParts()`:

```bash
sed -n '179,210p' src/main.ts
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

    const lastLine = children.last()?.lastLine ?? index;
    children.sort(compareFn);
    return { children, title, lastLine };
  }
```

The while-loop condition at lines 191-194 is the trickiest part of the codebase. It
determines whether the *next* line is a child of the *current* item using Obsidian's
`ListItemCache.parent` field:

- `parent < 0` → top-level list item (no parent)
- `parent >= 0` → child item (parent is the line number of its parent)

The condition checks: "is the next line's parent deeper than mine?" — meaning the next
line is a child (or grandchild) of the current item. It continues consuming lines until
it hits a sibling or the end.

> **Concern (issue #18):** This logic has no comments and is non-obvious to reason about.
> A future contributor modifying this would need to understand Obsidian's internal parent
> pointer semantics.

> **Concern (issue #14):** This algorithm has zero test coverage despite being the most
> complex code in the plugin.

The flattening step is simple — depth-first traversal:

```bash
sed -n '212,217p' src/main.ts
```

```output
  private listPartToList(list: ListPart): Line[] {
    return list.children.reduce<Line[]>(
      (acc, cur) => acc.concat(this.listPartToList(cur)),
      [list.title],
    );
  }
```

### Heading Sort

Headings sort recursively by level first, then alphabetically within the same level.
Each heading "owns" the content lines below it until the next heading of equal or
higher rank.

```bash
sed -n '219,282p' src/main.ts
```

```output
  private sortHeadings() {
    const ctx = this.getEditorContext(false);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;
    const res = this.getSortedHeadings(lines, 0, {
      headingLevel: 0,
      formatted: "",
      source: "",
      lineNumber: -1,
      checked: false,
    });
    this.setLines(ctx, this.headingsToString(res).slice(1));
  }

  private headingsToString(heading: HeadingPart): Line[] {
    const list = [heading.title, ...heading.lines];
    for (const h of heading.headings) {
      list.push(...this.headingsToString(h));
    }
    return list;
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
        currentIndex = headings.last()?.to ?? currentIndex;
      } else {
        contentLines.push(current);
      }
      currentIndex++;
    }

    return {
      lines: contentLines,
      to:
        headings.length > 0
          ? (headings.last()?.to ?? currentIndex - 1)
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

### How heading sort works

`getSortedHeadings()` performs a recursive descent:

1. **Walk lines** from `from` index forward
2. **Break** when a heading of equal or higher rank is found (it belongs to the parent)
3. **If heading found** → recurse into it, then skip past its `to` boundary
4. **If plain line** → add to this heading's content lines
5. **Sort child headings:** first by level (lower level = higher rank), then alphabetically

The entry point creates a synthetic level-0 "root" heading to anchor the recursion.
`headingsToString()` flattens the tree depth-first, and `.slice(1)` removes the
synthetic root from the output.

Note the sort comparator at line 270: headings of *different* levels sort by level number.
This means if you have `## Alpha` and `### Beta` as siblings under the same parent, `##`
sorts first regardless of name. Within the same level, it's alphabetical.

### Length Sort and Permutations

These are the simplest operations — no tree structures, just flat array methods.

```bash
sed -n '284,309p' src/main.ts
```

```output
  private sortLengthOfLine() {
    const ctx = this.getEditorContext(false);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;
    lines.sort((a, b) => a.formatted.length - b.formatted.length);
    this.setLines(ctx, lines);
  }

  private permuteReverse() {
    const ctx = this.getEditorContext(false);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;
    lines.reverse();
    this.setLines(ctx, lines);
  }

  private permuteShuffle() {
    const ctx = this.getEditorContext(false);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;
    lines.shuffle();
    this.setLines(ctx, lines);
  }
```

Length sort uses `formatted.length` — the character count *after* link/checkbox stripping.
This means `[[very long link name|short]]` counts as 5 characters ("short"), not the
full wiki-link syntax.

> **Concern (issue #16):** `lines.shuffle()` at line 307 is not a standard JavaScript
> method. Obsidian patches `Array.prototype` to add it. This works at runtime but isn't
> type-safe and breaks in test environments without the Obsidian runtime.

## Phase 4: Writing Results Back

`setLines()` maps the sorted `Line[]` back to text using each line's original `source`
(preserving all formatting, links, and syntax), then writes it to the editor.

```bash
sed -n '398,412p' src/main.ts
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
}
```

Two write modes:

- **Selection/range** → `editor.replaceRange()` with precise start/end positions
- **Full document** → `editor.setValue()` (cheaper, replaces everything)

The `endLineLength` ensures the replacement covers the full last line without overflowing
into the next.

## Test Suite

The tests live alongside the source in `src/main.test.ts`. They use Bun's native test
runner and re-implement the sorting logic in isolation (not importing from `main.ts`
directly, since the plugin class requires Obsidian's runtime).

```bash
grep -c 'test(' src/main.test.ts
```

```output
22
```

```bash
grep -n 'describe\|  test(' src/main.test.ts
```

```output
1:import { describe, expect, test } from "bun:test";
30:describe("alphabetical sort", () => {
31:  test("sorts lines alphabetically", () => {
37:  test("case-insensitive sorting", () => {
43:  test("numeric sorting", () => {
50:describe("alphabetical sort with checkboxes", () => {
51:  test("unchecked items before checked items", () => {
67:  test("alphabetical within same checkbox state", () => {
89:describe("sort by length", () => {
90:  test("sorts by formatted text length", () => {
102:  test("equal length lines maintain relative order", () => {
109:describe("reverse", () => {
110:  test("reverses line order", () => {
116:  test("single line stays the same", () => {
123:describe("heading sort", () => {
178:  test("sorts sibling headings alphabetically", () => {
191:  test("nested headings sort within parent", () => {
210:describe("checkbox regex", () => {
213:  test("matches checked checkbox", () => {
217:  test("matches uppercase checked checkbox", () => {
221:  test("does not match unchecked checkbox", () => {
225:  test("matches indented checkbox", () => {
229:  test("does not match plain text", () => {
```

22 test cases across 6 describe blocks. Coverage is focused on core algorithms:

| Suite | Tests | Coverage |
|---|---|---|
| Alphabetical sort | 3 | Case-insensitive, numeric-aware |
| Checkbox-aware sort | 2 | Priority ordering, within-group ordering |
| Length sort | 2 | Basic + stability |
| Reverse | 2 | Multi-line + single-line edge case |
| Heading sort | 2 | Sibling + nested hierarchy |
| Checkbox regex | 5 | Match/non-match validation |

### Test Coverage Gaps

The following have **no test coverage**:

- **Recursive list sort** (`sortListRecursively`, `getSortedListParts`) — the most complex
  algorithm
- **Link/embed replacement** in `getLines()`
- **Editor context resolution** (`getEditorContext`)
- **Frontmatter boundary handling**
- **`setLines()`** write-back logic
- **Shuffle permutation**

> **Concern (issue #13):** Tests are not run in CI. The workflow at
> `.github/workflows/main.yml` only runs `bun run check` (typecheck + lint), not
> `bun test`.

## Build & CI

### Build Configuration

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

Bun's native bundler compiles `src/main.ts` into a single `main.js`:
- **CommonJS** format (required by Obsidian's plugin loader)
- **Minified** in production, unminified in watch mode
- **Externals:** `obsidian` and `electron` are not bundled — Obsidian provides them

### CI Workflow

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

### Release Workflow

```bash
cat .github/workflows/release.yml
```

```output
name: Release

on:
  push:
    tags:
      - "*"

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

> **Concern (issue #6):** The release workflow triggers on `tags: ["*"]` — any tag,
> not just semver version tags. A tag like `experiment-v1` would trigger a release build.
> Should filter to `tags: ["[0-9]+.[0-9]+.[0-9]+"]` or similar.

> **Concern (issue #19):** Both workflows use `bun-version: latest` without pinning.
> A breaking Bun update could fail builds unexpectedly.

> **Concern (issue #20):** The release workflow doesn't run `bun run validate` before
> publishing, which would catch version mismatches between `package.json` and
> `manifest.json`.

## Community Standards Adherence

### Obsidian Plugin Guidelines

| Guideline | Status | Notes |
|---|---|---|
| Single `main.js` entry point | ✅ | Bundled to root |
| `manifest.json` with required fields | ✅ | id, name, version, minAppVersion |
| No bundled `obsidian` dependency | ✅ | Externalized |
| `versions.json` mapping | ✅ | Present and maintained |
| No `node_modules` in build | ✅ | .gitignore'd |
| Desktop + mobile support | ✅ | `isDesktopOnly: false` |
| MIT license | ✅ | Standard for community plugins |

### Code Quality

| Practice | Status | Notes |
|---|---|---|
| TypeScript strict mode | ✅ | `strict: true` in tsconfig |
| Biome linting | ✅ | Configured with organized imports |
| Automated CI | ⚠️ | Runs checks but not tests |
| Dependabot | ✅ | Weekly updates for npm + GitHub Actions |
| Version sync tooling | ✅ | `version-bump.ts` keeps manifests aligned |

### Missing Community Norms

- **No `styles.css`** — appropriate since this plugin has no UI elements
- **No settings tab** — the plugin has no user-configurable options
- **No `onunload()`** — not needed; Obsidian cleans up commands automatically
- **No mobile testing flag** — `isDesktopOnly: false` is set but mobile behavior is untested

## Summary of Open Concerns

All concerns identified in this walkthrough have corresponding GitHub issues:

| Issue | Severity | Summary |
|---|---|---|
| #5 | HIGH | Link replacement uses string match, not positional |
| #7 | HIGH | "Current list" matches any section type |
| #13 | HIGH | Tests not run in CI |
| #6 | HIGH | Release triggers on any tag |
| #14 | MEDIUM | No test coverage for recursive list sort |
| #15 | MEDIUM | Silent failures, no user feedback |
| #16 | MEDIUM | Shuffle relies on Obsidian prototype patch |
| #17 | MEDIUM | Checkbox regex matches any non-space character |
| #18 | MEDIUM | Complex parent-pointer logic uncommented |
| #19 | LOW | Bun version not pinned in CI |
| #20 | LOW | Release workflow skips validation |
| #21 | LOW | No tests for frontmatter boundary handling |

The plugin is well-structured and focused. The 4-phase pipeline is clean, the
`source`/`formatted` separation is a good design choice, and the locale-aware collator
handles international content correctly. The high-severity items are correctness bugs;
the medium items are maintainability and robustness improvements.
