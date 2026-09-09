# Obsidian Sort Lines Walkthrough

*2026-09-09T21:45:05Z by Showboat 0.6.1*
<!-- showboat-id: f1603247-aca2-4918-8443-03eb23db468f -->

## Overview

Sort Lines is an [Obsidian](https://obsidian.md/) plugin (plugin id `sort-lines`) that
reorders lines, lists, and heading sections in the active markdown editor. It is a fork of
`Vinzent03/obsidian-sort-and-permute-lines` that has diverged: version 2.0.0 cut the command
set from eleven to six and changed heading sort to pure alphabetical.

The stack is TypeScript, bundled by [Bun](https://bun.sh/), linted and formatted by
[Biome](https://biomejs.dev/), tested with `bun test`.

The thing to hold in mind for the whole walkthrough: **this plugin does not parse markdown.**
Every structural fact — where headings are, how list items nest, where links and frontmatter
begin and end — is read out of Obsidian's `CachedMetadata`. The plugin's own code is a
sorting engine that consumes pre-digested structure.

## Architecture

The whole plugin is two source files plus a test file. The split between them is the single
most important structural fact in the repository.

```bash
wc -l src/*.ts build.ts version-bump.ts deploy.ts
```

```output
     260 src/main.ts
     520 src/sort.test.ts
     337 src/sort.ts
      45 build.ts
      19 version-bump.ts
      10 deploy.ts
    1191 total
```

`src/sort.ts` holds the algorithms and has **no runtime Obsidian dependency** — its only
import is a type. That is what lets the test file import the real production functions and
feed them synthetic data, with no mocking of Obsidian's API.

`src/main.ts` is the orchestrator: it talks to Obsidian, reads editor state, calls into
`sort.ts`, and writes the result back.

You can see the boundary in the imports of each file.

```bash
sed -n '1,4p' src/sort.ts
```

```output
// Pure sorting algorithms — no runtime Obsidian dependency (ListItemCache
// is a type-only import). main.ts orchestrates editor state around these;
// tests import them directly.
import type { ListItemCache } from "obsidian";
```

```bash
sed -n '1,14p' src/main.ts
```

```output
import type { CachedMetadata } from "obsidian";
import { MarkdownView, Notice, Plugin } from "obsidian";
import {
  type Comparator,
  collectLines,
  getFrontStart,
  type Line,
  type ListPart,
  type Range,
  resolveListRange,
  resolveSelectionRange,
  sortHeadings,
  sortListLines,
} from "./sort";
```

`sort.ts` imports `ListItemCache` as a **type only**, so nothing from the `obsidian` package
survives into the emitted JavaScript. `main.ts` imports three real values (`MarkdownView`,
`Notice`, `Plugin`) and is therefore the only file that cannot run outside Obsidian.

## Entry point and build

Obsidian loads a plugin from `manifest.json`, which names the bundle to execute.

```bash
cat manifest.json
```

```output
{
  "id": "sort-lines",
  "name": "Sort Lines",
  "version": "2.0.5",
  "minAppVersion": "1.0.0",
  "description": "Sort and permute lines, lists, and headings",
  "author": "Mark Ayers (originally by Vinzent)",
  "authorUrl": "https://github.com/philoserf",
  "isDesktopOnly": false
}
```

```bash
sed -n '1,30p' build.ts
```

```output
import { watch } from "node:fs";

const isWatch = process.argv.includes("--watch");

async function build() {
  const result = await Bun.build({
    entrypoints: ["src/main.ts"],
    outdir: ".",
    format: "cjs",
    external: ["obsidian", "electron"],
    minify: !isWatch,
    sourcemap: isWatch ? "linked" : "none",
  });

  if (!result.success) {
    console.error("Build failed");
    for (const message of result.logs) console.error(message);
    if (!isWatch) process.exit(1);
    return;
  }

  const [bundle] = result.outputs;
  console.log(
    bundle
      ? `Built main.js (${(bundle.size / 1024).toFixed(1)} KB)`
      : "Built main.js",
  );
}

await build();
```

`build.ts` bundles `src/main.ts` into `./main.js` as CommonJS, marking `obsidian` and
`electron` external — Obsidian provides both at runtime. Production builds are minified;
`--watch` builds are not and carry a linked sourcemap.

## The plugin class

`main.ts` exports a single default class. Before `onload` runs, one field is initialized.

```bash
sed -n '40,51p' src/main.ts
```

```output
export default class SortLinesPlugin extends Plugin {
  // Built at construction, not in onload: a definite-assignment assertion
  // here would only postpone the failure to whichever method ran first,
  // reporting it as "this.compare is not a function" with no hint that the
  // real problem was call order.
  private readonly compare: Comparator = new Intl.Collator(navigator.language, {
    usage: "sort",
    sensitivity: "base",
    numeric: true,
    ignorePunctuation: true,
  }).compare;

```

This is the comparator every alphabetical sort uses. Three details matter:

- `sensitivity: "base"` makes the sort case- and accent-insensitive.
- `numeric: true` makes `item2` sort before `item10` rather than after it.
- `ignorePunctuation: true` means leading bullets and markers do not dominate the ordering.

The comment explains why it is a field initializer rather than an assignment in `onload`:
a definite-assignment assertion would only move the failure later and report it as
"this.compare is not a function", hiding the real cause.

`onload` registers six commands, each a thin callback.

```bash
grep -n 'id: "' src/main.ts
```

```output
54:      id: "sort-alphabetically",
59:      id: "sort-length",
64:      id: "sort-headings",
69:      id: "permute-reverse",
74:      id: "permute-shuffle",
80:      id: "sort-list-recursively",
```

Five of the six follow one shape. `sortAlphabetically` is the canonical instance, and reading
it once means you have read `sortLengthOfLine`, `permuteReverse`, and `permuteShuffle` too —
they differ only in the permutation step in the middle.

```bash
sed -n '89,102p' src/main.ts
```

```output
  private sortAlphabetically() {
    const ctx = this.getSelectionContext();
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

Resolve a context, bail with a notice if there is no editor; collect the lines, bail with a
different notice if there are none; permute; write back. The sixth command, the list sort,
breaks this shape and is covered later.

## Step 1: resolving the target

`resolveTarget` is where the plugin meets Obsidian. Both lookups can fail, and both failures
mean the same thing to the caller.

```bash
sed -n '223,242p' src/main.ts
```

```output
  private resolveTarget(): SortTarget | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;

    const cache = this.app.metadataCache.getFileCache(view.file);
    if (!cache) return;

    return { view, cache };
  }

  private buildContext(target: SortTarget, range: Range): EditorContext {
    return {
      ...target,
      start: range.start,
      end: range.end,
      // Read after the range is final: an earlier read would measure a line
      // the write no longer ends on.
      endLineLength: target.view.editor.getLine(range.end).length,
    };
  }
```

`buildContext` records `endLineLength` — how many characters the last line of the range holds
— because the write-back at the end needs an exact end position. The comment flags the
ordering constraint: it is read *after* the range is final, since reading it earlier would
measure a line the write no longer ends on.

## Step 2: reading the editor into a plain record

`main.ts` never hands an Obsidian object to `sort.ts`. It flattens what the range logic needs
into an anonymous record first.

```bash
sed -n '27,38p' src/main.ts
```

```output
/** Everything the range resolvers need to read off the editor. */
function bounds({ view, cache }: SortTarget) {
  const editor = view.editor;
  const lastLine = editor.lastLine();
  return {
    from: editor.getCursor("from").line,
    to: editor.getCursor("to").line,
    frontStart: getFrontStart(cache.frontmatter),
    lastLine,
    lastLineEmpty: editor.getLine(lastLine) === "",
  };
}
```

Five plain numbers and a boolean. This is the seam that makes range resolution unit-testable:
the tests construct this record by hand and never touch Obsidian.

`getFrontStart` turns Obsidian's frontmatter record into the first sortable line number.

```bash
sed -n '64,69p' src/sort.ts
```

```output
/** First sortable line: the line after the frontmatter block, or 0. */
export function getFrontStart(
  frontmatter: { position?: { end?: { line?: number } } } | undefined,
): number {
  return (frontmatter?.position?.end?.line ?? -1) + 1;
}
```

The `?? -1` followed by `+ 1` is the whole trick: no frontmatter yields `0`, and frontmatter
ending on line 3 yields `4`.

## Step 3: deciding what to sort

`resolveSelectionRange` answers "which lines?" for every command except the list sort.

```bash
sed -n '103,116p' src/sort.ts
```

```output
/**
 * The range to sort when no list is involved: an explicit multi-line
 * selection, else the whole document below the frontmatter.
 *
 * A selection inside a single line reads as no selection — `from === to`
 * — and sorts the whole document, which is long-standing behavior.
 */
export function resolveSelectionRange(bounds: DocumentBounds): Range {
  const range =
    bounds.from !== bounds.to
      ? { start: bounds.from, end: bounds.to }
      : { start: bounds.frontStart, end: bounds.lastLine };
  return withoutTrailingEmpty(range, bounds);
}
```

Two cases. A real multi-line selection (`from !== to`) is used as-is. Anything else —
including a selection that sits inside one line — is treated as "no selection" and the range
becomes the whole document below the frontmatter.

Then `withoutTrailingEmpty` runs on the result, and it exists to fix a very visible bug.

```bash
sed -n '89,101p' src/sort.ts
```

```output
/**
 * A file that ends in a newline has an empty final line. It is a format
 * artifact, not content — but it is a line, and `""` collates before
 * everything, so leaving it in the range hoists a blank to the top of
 * every sort. Drop it, unless it is the only line in the range.
 */
function withoutTrailingEmpty(range: Range, bounds: DocumentBounds): Range {
  const droppable =
    range.end === bounds.lastLine &&
    bounds.lastLineEmpty &&
    range.end > range.start;
  return droppable ? { start: range.start, end: range.end - 1 } : range;
}
```

Any file saved with a trailing newline has an empty last line. It is a format artifact, but
it is still a line, and `""` collates before everything — so without this, every sort of a
whole document would hoist a blank line to the top. The `range.end > range.start` guard keeps
a one-line range from collapsing to nothing.

## Step 4: building the lines

`collectLines` turns the document text plus cache data into the `Line[]` the algorithms
consume. This is the heart of the read path.

```bash
sed -n '159,185p' src/sort.ts
```

```output
export function collectLines(
  text: string,
  opts: {
    links: LinkRef[];
    headings: HeadingRef[];
    start: number;
    end: number;
  },
): Line[] {
  const mapped: Line[] = text.split("\n").map((line, index) => ({
    source: line,
    formatted: replaceLinksOnLine(
      line,
      opts.links.filter((link) => link.position.start.line === index),
    ).replace(CHECKBOX_REGEX, "$1"),
    headingLevel: undefined,
    lineNumber: index,
  }));

  for (const heading of opts.headings) {
    const target = mapped[heading.position.start.line];
    if (!target) continue;
    target.headingLevel = heading.level;
  }

  return mapped.slice(opts.start, opts.end + 1);
}
```

Read it in three movements:

1. **Every line in the document** is mapped to a `Line`, carrying both its `source` (the
   untouched original) and its `formatted` (links resolved, checkbox marker stripped).
2. **Heading levels are attached by absolute line number**, before any slicing. A heading
   position past the end of the current text is skipped rather than thrown on, because
   Obsidian's cache lags the editor during fast typing.
3. **Only then is the range applied**, with `opts.end + 1` because `end` is inclusive.

Two things here are load-bearing and easy to "clean up" into bugs. The slice happens *last*,
so link and heading positions — which are absolute — still line up. And `lineNumber` keeps
its pre-slice value, which the list sort depends on absolutely.

### Link replacement

The `source`/`formatted` split exists so a wiki-link sorts by what the reader sees, not by
its syntax. `[[2024-01-15|Tuesday standup]]` should sort under T.

```bash
sed -n '71,87p' src/sort.ts
```

```output
/**
 * Replace each link on a line with its display text. Splices right to
 * left so earlier replacements don't shift later link positions.
 */
export function replaceLinksOnLine(line: string, links: LinkRef[]): string {
  const sorted = [...links].sort(
    (a, b) => b.position.start.col - a.position.start.col,
  );
  let result = line;
  for (const link of sorted) {
    result =
      result.substring(0, link.position.start.col) +
      (link.displayText ?? "") +
      result.substring(link.position.end.col);
  }
  return result;
}
```

The sort on the first line is the point of the function. Obsidian gives link positions as
column offsets into the original line; replacing a link with shorter or longer text shifts
every column to its right. Splicing **right to left** means each replacement only disturbs
text that has already been processed. There is a test named "links provided in forward order
still splice correctly" guarding exactly this.

Note also that `main.ts` feeds both links and embeds through this one path.

```bash
sed -n '244,251p' src/main.ts
```

```output
  private getLines(ctx: EditorContext): Line[] {
    return collectLines(ctx.view.editor.getValue(), {
      links: [...(ctx.cache.links ?? []), ...(ctx.cache.embeds ?? [])],
      headings: ctx.cache.headings ?? [],
      start: ctx.start,
      end: ctx.end,
    });
  }
```

### Checkbox stripping

The second normalization is a single regex, applied to every line.

```bash
sed -n '60,62p' src/sort.ts
```

```output
// Matches any non-empty checkbox: [x], [X], [-], [?], [/], [!], etc.
// Intentionally broad to support Obsidian's alternative checkbox statuses.
export const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/;
```

`(\s*)` captures the leading indentation and the replacement `"$1"` puts it back, so nesting
is preserved while the marker goes away. `[^ ]` requires the bracket to hold a non-space, so
`- [x]`, `- [-]`, and `- [?]` are all stripped, while `- [ ]` is left alone.

That asymmetry has a visible consequence: a completed task sorts by its text, mixed in with
ordinary prose, while an open task still sorts under its `- [ ]` prefix and therefore
clusters with other open tasks. Whether that is the intent or a side effect of the pattern is
not recorded anywhere.

Note also what this regex is *not*: it is not driven by the metadata cache. Unlike every other
structural decision in the plugin, checkbox recognition is pure text matching, so it fires on
any line shaped like a checkbox — including one inside a fenced code block. This is filed as
a finding below.

## Step 5a: sorting headings

Heading sort builds a tree, sorts siblings at each level, and flattens it back.

```bash
sed -n '232,252p' src/sort.ts
```

```output
/**
 * Sort headings recursively: siblings sort alphabetically at each level,
 * content lines stay under their heading.
 */
export function sortHeadings(lines: Line[], compare: Comparator): Line[] {
  const root: Line = {
    headingLevel: 0,
    formatted: "",
    source: "",
    lineNumber: -1,
  };
  const res = getSortedHeadings(lines, 0, root, compare);
  const flatten = (h: HeadingPart): Line[] => {
    const list = [h.title, ...h.lines];
    for (const sub of h.headings) {
      list.push(...flatten(sub));
    }
    return list;
  };
  return flatten(res).slice(1);
}
```

A synthetic root `Line` at level 0 seeds the recursion so that every real heading (level 1-6)
is deeper than it and becomes its child. The final `.slice(1)` drops that fake root back out
of the result.

The recursion itself does the work.

```bash
sed -n '187,230p' src/sort.ts
```

```output
function getSortedHeadings(
  lines: Line[],
  from: number,
  heading: Line,
  compare: Comparator,
): HeadingPart {
  const headings: HeadingPart[] = [];
  const contentLines: Line[] = [];
  let currentIndex = from;

  while (currentIndex < lines.length) {
    const current = lines[currentIndex];
    if (!current) break;
    // Only a heading at the same-or-higher level ends this section; body
    // lines (headingLevel undefined) are content, never terminators.
    if (
      current.headingLevel !== undefined &&
      current.headingLevel <= (heading.headingLevel ?? 0)
    )
      break;

    if (current.headingLevel) {
      headings.push(
        getSortedHeadings(lines, currentIndex + 1, current, compare),
      );
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
      compare(a.title.formatted.trim(), b.title.formatted.trim()),
    ),
    title: heading,
  };
}
```

The loop walks forward from `from` and classifies each line:

- A heading at the **same or shallower** level ends this section — return.
- A **deeper** heading is a child: recurse, and jump `currentIndex` to the end of that subtree.
- Anything else is a **content line** and is appended to `contentLines`.

The comment on the terminator check is worth noting: body lines have `headingLevel === undefined`
and are explicitly *not* terminators. Only a heading closes a section.

Sorting happens on one line — `headings.sort(...)` — and it sorts only the direct children at
this level. Because every level does the same on its way back up the recursion, the result is
a tree sorted at every depth, with each heading's content riding along in `lines`.

## Step 5b: sorting lists

The list sort is the one command that breaks the shape established earlier, and it does so
three times over: a different range resolver, an extra input guard, and a different tree
algorithm.

### A different range

Where the other commands accept the selection, the list sort finds the list enclosing the
cursor — and refuses to do anything if there isn't one.

```bash
sed -n '118,143p' src/sort.ts
```

```output
/**
 * The range to sort for the list command: the list section enclosing the
 * cursor, or `undefined` when the cursor is not in a list.
 *
 * A one-item list is a section whose start and end are the same line. That
 * is a range, not an absent one — testing `start !== end` here is what made
 * the command fall through and sort the whole document instead.
 *
 * There is deliberately no fallback. Falling back to the whole document
 * meant the list algorithm ran over prose whenever the cursor sat outside
 * a list, reordering the document and absorbing following lines into the
 * nearest list item. "No list here" is an answer, not a gap to fill.
 */
export function resolveListRange(
  bounds: DocumentBounds,
  sections: SectionRef[],
): Range | undefined {
  const list = sections.find(
    (s) =>
      s.type === "list" &&
      s.position.start.line <= bounds.from &&
      s.position.end.line >= bounds.to,
  );
  if (!list) return;
  return { start: list.position.start.line, end: list.position.end.line };
}
```

Both comments record scars. Testing `start !== end` here once made a one-item list look like
"no list", so the command fell through and sorted the entire document. And there is
deliberately **no fallback**: an earlier version ran the list algorithm over prose whenever
the cursor sat outside a list, absorbing following lines into the nearest list item. "No list
here" is treated as an answer, not a gap to fill.

`main.ts` turns that `undefined` into a distinguishable failure.

```bash
sed -n '205,221p' src/main.ts
```

```output
  /**
   * The sort range for the list sort: the list enclosing the cursor.
   *
   * Reports why it failed, because the two reasons need different notices
   * and neither is "sort the whole document instead".
   */
  private getEnclosingListContext():
    | { ctx: EditorContext }
    | { error: "no active editor" | "cursor is not inside a list" } {
    const target = this.resolveTarget();
    if (!target) return { error: "no active editor" };

    const range = resolveListRange(bounds(target), target.cache.sections ?? []);
    if (!range) return { error: "cursor is not inside a list" };

    return { ctx: this.buildContext(target, range) };
  }
```

A result union rather than `undefined`, because the two failures need different notices.

### An extra guard, and the cache map

The command body then does something no other command does: it validates its input.

```bash
sed -n '104,128p' src/main.ts
```

```output
  private sortListRecursively(compareFn: (a: ListPart, b: ListPart) => number) {
    const found = this.getEnclosingListContext();
    if ("error" in found) {
      new Notice(`Sort Lines: ${found.error}`);
      return;
    }
    const ctx = found.ctx;
    const inputLines = this.getLines(ctx);
    if (inputLines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    if (inputLines.find((line) => line.source.trim() === "")) {
      new Notice("Sort Lines: list contains blank lines");
      return;
    }

    const cacheMap = new Map(
      (ctx.cache.listItems ?? []).map((item) => [
        item.position.start.line,
        item,
      ]),
    );
    this.setLines(ctx, sortListLines(inputLines, cacheMap, compareFn));
  }
```

A blank line anywhere in the range aborts the sort, because the parent-pointer walk assumes
the list is contiguous.

The last step builds `cacheMap`: Obsidian's `listItems` array, re-keyed by the **absolute
line number** each item starts on. That key space is why `Line.lineNumber` must stay absolute
all the way through `collectLines`.

### The parent-pointer walk

`sortListLines` is the entry point. Its first job is to make array indices and absolute line
numbers agree.

```bash
sed -n '301,329p' src/sort.ts
```

```output
/**
 * Sort a list (and every nested sublist) recursively. `inputLines` is the
 * list's line range; entries are padded to their absolute line numbers so
 * the cacheMap's parent pointers (absolute line numbers) line up.
 */
export function sortListLines(
  inputLines: Line[],
  cacheMap: Map<number, ListItemCache>,
  compareFn: (a: ListPart, b: ListPart) => number,
): Line[] {
  const firstLineNumber = inputLines[0]?.lineNumber;
  if (firstLineNumber == null) return inputLines;
  // `new Array(n)` is typed `any[]`, and spreading it would widen the whole
  // literal to `any[]` — silently disabling type checking on every `lines`
  // access below. Type the padding explicitly to keep that from happening.
  const padding: (Line | undefined)[] = new Array(firstLineNumber).fill(
    undefined,
  );
  const lines: (Line | undefined)[] = [...padding, ...inputLines];
  let index = firstLineNumber;

  const children: ListPart[] = [];
  while (index < lines.length) {
    const newChild = getSortedListParts(lines, cacheMap, index, compareFn);
    if (!newChild) break;
    children.push(newChild);
    index = newChild.lastLine + 1;
  }
  children.sort(compareFn);
```

The padding is the trick: prefix the array with `firstLineNumber` empty slots so that
`lines[n]` is the line numbered `n`. Now array index and `cacheMap` key are the same thing,
and the recursion can follow parent pointers by indexing directly.

Then the recursive builder — the densest code in the repository.

```bash
sed -n '254,299p' src/sort.ts
```

```output
function getSortedListParts(
  lines: (Line | undefined)[],
  cacheMap: Map<number, ListItemCache>,
  index: number,
  compareFn: (a: ListPart, b: ListPart) => number,
): ListPart | undefined {
  // `lines` is padded to absolute line numbers, so the leading entries are
  // empty by construction. Both callers seed `index` past the padding, but
  // that is an invariant of the walk rather than of the type — a line we
  // cannot read ends it, the same way `parentAt` terminates past the end.
  const title = lines[index];
  if (!title) return;

  const children: ListPart[] = [];
  const startListCache = cacheMap.get(index);
  if (!startListCache) return { children: [], title, lastLine: index };

  // Obsidian's ListItemCache.parent is the line number of the parent item,
  // or, for top-level items, the negative of the list's first line. Lines
  // inside the list with no cache entry (continuation lines) read as -1;
  // lines past the end read as -Infinity so the walk always terminates —
  // a top-level parent like -3 (list starting at line 2) is < -1, which
  // would otherwise treat end-of-list as an endless run of children.
  const parentAt = (i: number): number =>
    i < lines.length
      ? (cacheMap.get(i)?.parent ?? -1)
      : Number.NEGATIVE_INFINITY;

  // This loop collects children: the next line is a child if:
  //   1. Its parent pointer is deeper than ours (nested under us), OR
  //   2. We're top-level (parent < 0) and the next item has any parent (is nested)
  while (
    startListCache.parent < parentAt(index + 1) ||
    (startListCache.parent < 0 && parentAt(index + 1) >= 0)
  ) {
    index++;
    const newChild = getSortedListParts(lines, cacheMap, index, compareFn);
    if (!newChild) break;
    index = newChild.lastLine;
    children.push(newChild);
  }

  const lastLine = children.at(-1)?.lastLine ?? index;
  children.sort(compareFn);
  return { children, title, lastLine };
}
```

Obsidian describes list nesting by **parentage, not depth**. `ListItemCache.parent` is the
line number of the item's parent, or a *negative* number for a top-level item. There is no
depth field, so the walk has to compare parent pointers between adjacent lines.

`parentAt` supplies two sentinels that make the comparison total:

- A line inside the list with no cache entry — a continuation line — reads as `-1`.
- A line past the end reads as `-Infinity`.

The `-Infinity` is not defensive padding; it is load-bearing. A top-level item in a list
starting at line 2 has `parent === -3`, and `-3 < -1`. Without a sentinel strictly below
every real parent value, running off the end of the list would look like an endless run of
children.

The `while` condition then collects children in two cases: the next line's parent is deeper
than ours, or we are top-level (`parent < 0`) and the next line has any parent at all.

`children.sort(compareFn)` runs at every level of the recursion, which is what makes the sort
recursive — and it happens after `lastLine` is computed, so reordering children cannot
disturb where the subtree ends.

Finally `sortListLines` flattens the sorted tree back into a line array.

```bash
sed -n '330,337p' src/sort.ts
```

```output

  const flatten = (part: ListPart): Line[] =>
    part.children.reduce<Line[]>(
      (acc, cur) => acc.concat(flatten(cur)),
      [part.title],
    );
  return children.reduce<Line[]>((acc, cur) => acc.concat(flatten(cur)), []);
}
```

Each subtree emits its title first, then its sorted children depth-first — so a parent always
lands immediately above the items that belong to it.

## Step 6: writing back

Every command ends in the same three lines.

```bash
sed -n '253,259p' src/main.ts
```

```output
  private setLines(ctx: EditorContext, lines: Line[]) {
    ctx.view.editor.replaceRange(
      lines.map((e) => e.source).join("\n"),
      { line: ctx.start, ch: 0 },
      { line: ctx.end, ch: ctx.endLineLength },
    );
  }
```

`source` is emitted, never `formatted` — the normalized text exists only to be compared. The
write is a single `replaceRange` over the exact resolved range, using the `endLineLength`
captured back in `buildContext`.

There is deliberately only one path here. An earlier version branched to `setValue` when
`start === end`, which destroyed the frontmatter of any note that had frontmatter plus one
line below it. `replaceRange` preserves everything outside the range, which is what keeps
frontmatter intact when the range starts below it.

## The shuffle, briefly

One command does its permutation in place rather than through `Array.sort`.

```bash
sed -n '185,195p' src/main.ts
```

```output
    // Fisher-Yates. Both reads are in range for the whole loop; the guard
    // is what lets the compiler see that without an assertion.
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const from = lines[i];
      const to = lines[j];
      if (!from || !to) continue;
      lines[i] = to;
      lines[j] = from;
    }
    this.setLines(ctx, lines);
```

A standard Fisher-Yates. The `if (!from || !to) continue` guard never fires — both indices
are provably in range for the whole loop — and exists so the compiler can see that without a
non-null assertion.

## Tests

All tests live in one file beside the source and import the real production symbols — no
algorithm is ever re-implemented in a test.

```bash
grep -c '  test(' src/sort.test.ts
```

```output
42
```

```bash
grep -n 'describe(' src/sort.test.ts
```

```output
36:describe("sortHeadings", () => {
83:describe("replaceLinksOnLine", () => {
160:describe("CHECKBOX_REGEX", () => {
174:describe("collectLines", () => {
290:describe("resolveSelectionRange", () => {
366:describe("resolveListRange", () => {
418:describe("getFrontStart", () => {
440:describe("sortListLines", () => {
```

The distribution is informative. `collectLines` and `resolveSelectionRange` carry the most
cases, which matches where the bugs have historically been: not in the sorting algorithms but
in deciding *which* lines to hand them. The suite runs with `bun test`.

What is **not** covered is the seam this walkthrough opened with. The tests feed the
algorithms hand-built `LinkRef`, `HeadingRef`, and `SectionRef` objects; nothing verifies
that Obsidian's cache still produces data of that shape. If `ListItemCache.parent` changed
meaning tomorrow, every test would still pass.

## Findings

Two things surfaced while tracing the code end to end.

The previous `WALKTHROUGH.md` was checked before being replaced: restored from `HEAD` and
re-verified against the current source, all of its captured snippets still matched, and its
prose claims — the data-flow summary, the "covers every exported piece" statement, and the
test counts — all held. No stale narrative was found, so none is filed.

## Index

| # | Severity | Issue | Primary location |
| --- | --- | --- | --- |
| 1 | medium | `absolute-line-number-contract-is-split-across-three-places` | `src/sort.ts`, `src/main.ts:121` |
| 2 | low | `sort-list-recursively-takes-a-comparator-no-caller-varies` | `src/main.ts:79-86` |

**Total: 2 issues (0 critical, 0 high, 1 medium, 1 low)**

Findings from the `code-theory` pass on the same source live alongside these in `.issues/`,
and `THEORY.md` covers why the system is shaped this way rather than how it runs.

