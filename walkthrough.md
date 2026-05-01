# Sort Lines Walkthrough

*2026-04-27T14:42:01Z by Showboat 0.6.1*
<!-- showboat-id: 703723fd-0995-4359-a732-5bce98fa8c7e -->

## Overview

**Sort Lines** is an Obsidian plugin that sorts and permutes lines, lists, and headings inside notes. Originally forked from Vinzent03/obsidian-sort-and-permute-lines, it is now maintained by Mark Ayers.

**Key technologies:** TypeScript, Bun (bundler + test runner), Biome (linter/formatter), Obsidian Plugin API.

**Six commands:** sort alphabetically, sort by length, sort headings (recursive by level), reverse, shuffle, and sort current list recursively.

**Entry point:** `src/main.ts` exports `SortLinesPlugin` (extends `Plugin`). Bun bundles it to `main.js` (CJS). The plugin ships `main.js` + `manifest.json`.

## Architecture

### Directory layout

```bash
echo "src/
  main.ts          — plugin source (single module)
  main.test.ts     — unit tests (bun test)
build.ts           — Bun bundler config
deploy.ts          — copies artifacts to local vault
version-bump.ts    — syncs version across package/manifest/versions
manifest.json      — Obsidian plugin manifest
package.json       — project metadata and scripts
biome.json         — linter/formatter config
tsconfig.json      — TypeScript config (noEmit, strict)
main.js            — build output (committed, CJS)"
```

```output
src/
  main.ts          — plugin source (single module)
  main.test.ts     — unit tests (bun test)
build.ts           — Bun bundler config
deploy.ts          — copies artifacts to local vault
version-bump.ts    — syncs version across package/manifest/versions
manifest.json      — Obsidian plugin manifest
package.json       — project metadata and scripts
biome.json         — linter/formatter config
tsconfig.json      — TypeScript config (noEmit, strict)
main.js            — build output (committed, CJS)
```

### Data flow

Every command follows the same pipeline:

1. **`getEditorContext(fromCurrentList)`** — resolves the active `MarkdownView`, its `CachedMetadata`, and the line range (selection, enclosing list, or whole file minus frontmatter).
2. **`getLines(ctx)`** — splits editor text into `Line[]` with `source` (original) and `formatted` (links resolved to display text, checkboxes stripped). Heading levels come from `cache.headings`.
3. **Sort/permute** on `Line[]` using `formatted` for comparison, `source` for output.
4. **`setLines(ctx, lines)`** — writes back via `replaceRange` (selection) or `setValue` (whole file).

---

## Core Walkthrough

### Plugin class and `onload`

The plugin is a single default-exported class. `onload()` constructs an `Intl.Collator` once and registers all six commands.

```bash
sed -n "36,46p" src/main.ts
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

The collator uses `navigator.language` for locale-aware sorting with `numeric: true` (so "item2" < "item10") and `ignorePunctuation: true`. The `compare` function is stored on the instance and reused by all sort methods.

### Command registration

Six commands are registered in `onload`. Each delegates to a private method:

```bash
grep -n "this.addCommand" src/main.ts
```

```output
48:    this.addCommand({
53:    this.addCommand({
58:    this.addCommand({
63:    this.addCommand({
68:    this.addCommand({
74:    this.addCommand({
```

```bash
grep -A1 "id:" src/main.ts | grep -E "(id|name):"
```

```output
      id: "sort-alphabetically",
      name: "Sort alphabetically",
      id: "sort-length",
      name: "Sort by length of line",
      id: "sort-headings",
      name: "Sort headings",
      id: "permute-reverse",
      name: "Reverse lines",
      id: "permute-shuffle",
      name: "Shuffle lines",
      id: "sort-list-recursively",
      name: "Sort current list recursively",
```

### Data types

Four interfaces model the domain. `Line` carries both the original source and a display-normalized `formatted` string for comparisons:

```bash
sed -n "4,31p" src/main.ts
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

`HeadingPart` and `ListPart` are recursive tree structures. `HeadingPart` captures a heading with its content lines and child headings. `ListPart` captures a list item with its children. `EditorContext` bundles the view, metadata cache, and the line range to operate on.

### `getEditorContext` — resolving what to sort

This method determines the scope of the operation. If `fromCurrentList` is true, it finds the enclosing list section from the cache. Otherwise, if there is a selection it uses that range; if not, it uses the whole file after frontmatter.

```bash
sed -n "304,353p" src/main.ts
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

Key detail: frontmatter is skipped by computing `(cache.frontmatter?.position?.end?.line ?? -1) + 1`. If no frontmatter exists, this evaluates to `0` (first line). This is tested independently in the test suite.

### `getLines` — building the `Line[]` array

This method produces the normalized `Line[]` from the editor content. Two transformations are applied to each line for the `formatted` field:

```bash
sed -n "355,390p" src/main.ts
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

**Link replacement:** Obsidian wiki-links like `[[target|display]]` are replaced with just their display text using positional splicing. Links are processed right-to-left (sorted by descending column) so earlier splice positions remain valid.

**Checkbox stripping:** The `CHECKBOX_REGEX` removes checked checkboxes from the formatted text so that `- [x] Task` sorts by "Task" rather than "[x] Task":

```bash
sed -n "32,34p" src/main.ts
```

```output
// Matches any non-empty checkbox: [x], [X], [-], [?], [/], [!], etc.
// Intentionally broad to support Obsidian's alternative checkbox statuses.
const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/i;
```

The regex captures leading whitespace (`$1`) so the replacement preserves indentation. It intentionally does not match unchecked `[ ]` boxes — only non-space characters inside the brackets.

### `sortAlphabetically` — the simplest command

Demonstrates the standard pipeline: get context, get lines, sort, set lines.

```bash
sed -n "84,97p" src/main.ts
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

All sort methods follow this same pattern. `sortLengthOfLine` compares `a.formatted.length - b.formatted.length`. `permuteReverse` calls `.reverse()`. `permuteShuffle` uses the Fisher-Yates algorithm:

```bash
sed -n "297,301p" src/main.ts
```

```output
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    this.setLines(ctx, lines);
```

### `sortHeadings` — recursive heading sort

Heading sort builds a tree of `HeadingPart` nodes, then sorts siblings at each level. The recursion anchor is a synthetic root heading at level 0:

```bash
sed -n "194,219p" src/main.ts
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
```

The `getSortedHeadings` function recurses: it walks lines sequentially, collecting content lines until it hits a heading. When a heading is found, it recurses to collect that headings children. The loop breaks when a same-or-higher-level heading is encountered:

```bash
sed -n "221,254p" src/main.ts
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

### `sortListRecursively` — recursive list sort

List sorting leverages Obsidian's `ListItemCache` which provides parent pointers (line numbers). Negative parent values indicate top-level items. The method builds a `Map` from line number to cache entry, then recursively builds `ListPart` trees:

```bash
sed -n "99,154p" src/main.ts
```

```output
  private sortListRecursively(compareFn: (a: ListPart, b: ListPart) => number) {
    const ctx = this.getEditorContext(true);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const inputLines = this.getLines(ctx);
    if (inputLines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    if (inputLines.find((line) => line.source.trim() === "")) {
      new Notice("Sort Lines: list contains blank lines");
      return;
    }

    const firstLineNumber = inputLines[0]?.lineNumber;
    if (firstLineNumber == null) return;
    const lines = [
      ...new Array(firstLineNumber).fill(undefined),
      ...inputLines,
    ];
    let index = firstLineNumber;

    if (!ctx.cache.listItems) {
      new Notice("Sort Lines: cursor is not inside a list");
      return;
    }
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

    const flatten = (part: ListPart): Line[] =>
      part.children.reduce<Line[]>(
        (acc, cur) => acc.concat(flatten(cur)),
        [part.title],
      );
    const res = children.reduce<Line[]>(
      (acc, cur) => acc.concat(flatten(cur)),
      [],
    );
    this.setLines(ctx, res);
  }
```

Key details:
- Blank lines inside a list abort the sort with a notice (Obsidian's cache can be unreliable with blank lines in lists).
- The `lines` array is padded with `undefined` entries to align array indices with line numbers, since the list may not start at line 0.
- `getSortedListParts` recurses using parent pointers to determine nesting:

```bash
sed -n "156,192p" src/main.ts
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

### `setLines` — writing results back

The output method is simple: join sorted `source` strings and either replace the selection range or set the entire editor value:

```bash
sed -n "392,405p" src/main.ts
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

### Build system

`build.ts` uses Bun's native bundler. A single entry point produces CJS output (required by Obsidian). `obsidian` and `electron` are externalized since Obsidian provides them at runtime:

```bash
sed -n "5,13p" build.ts
```

```output
async function build() {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: ".",
    format: "cjs",
    external: ["obsidian", "electron"],
    minify: !isWatch,
    sourcemap: isWatch ? "linked" : "none",
  });
```

In watch mode, minification is disabled and source maps are generated. The watcher debounces rebuilds with a 100ms timeout and ignores test files.

### Test suite

Tests use `bun test` and duplicate the core algorithms locally (heading sort, link replacement, checkbox regex, frontmatter boundary) to test them in isolation without the Obsidian runtime:

```bash
grep -c "test(" src/main.test.ts
```

```output
18
```

```bash
grep "describe\|test(" src/main.test.ts | head -12
```

```output
import { describe, expect, test } from "bun:test";
describe("heading sort", () => {
  test("sorts sibling headings alphabetically", () => {
  test("nested headings sort within parent", () => {
describe("link replacement by positional splicing", () => {
  test("single link replaced by display text", () => {
  test("duplicate links replaced at correct positions", () => {
  test("multiple different links replaced positionally", () => {
  test("link with no display text replaced with empty string", () => {
  test("links provided in forward order still splice correctly", () => {
describe("checkbox regex", () => {
  test("matches checked checkbox", () => {
```

---

## Concerns

1. **Test duplication:** Core algorithms (`getSortedHeadings`, link replacement) are copy-pasted into the test file since they are private methods on the plugin class. Extracting them as pure functions would eliminate duplication and improve testability.

2. **No `onunload` implementation:** The plugin class has no `onunload()` method. While Obsidian's `Plugin` base class handles command cleanup, any future resources (event listeners, intervals) would need explicit teardown.

3. **`Line[]` array padding in list sort:** `sortListRecursively` creates an array padded with `undefined` entries to align indices with line numbers. This works but is fragile — accessing a padding slot would produce a runtime error with no type-level protection.

4. **Single-file architecture:** The entire plugin is one 406-line file. This is fine at current size, but extracting the recursive sort algorithms into a separate module would improve testability (no need to duplicate in tests) and readability.

5. **Shuffle is non-deterministic:** `permuteShuffle` uses `Math.random()` directly. This makes it untestable without mocking. A seeded RNG or injectable random source would improve test coverage.
