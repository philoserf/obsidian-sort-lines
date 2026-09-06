# Obsidian Sort Lines Walkthrough

*2026-06-12T16:25:56Z by Showboat 0.6.1*
<!-- showboat-id: a25b7013-5638-43ad-b1ca-1f28ef7f8b07 -->

## Overview

Sort Lines is an Obsidian plugin (id `sort-lines`, forked from
Vinzent03/obsidian-sort-and-permute-lines) that sorts and permutes lines,
lists, and headings in the active markdown editor. It is written in
TypeScript, built with Bun's bundler, linted with Biome, and tested with
`bun test`.

The code splits cleanly in two:

- `src/sort.ts` — the pure algorithms. `sortHeadings`, `sortListLines`,
  `replaceLinksOnLine`, `getFrontStart`, and `CHECKBOX_REGEX`, plus the
  `Line` / `HeadingPart` / `ListPart` / `LinkRef` types. No runtime
  Obsidian dependency (`ListItemCache` is a type-only import), so tests
  exercise the real production code directly.
- `src/main.ts` — a thin orchestrator. `SortLinesPlugin` resolves editor
  state, hands `Line[]` to a sort function, and writes the result back.

Every command follows the same pipeline:
`getSelectionContext` / `getEnclosingListContext` → `getLines` → sort/permute → `setLines`.

## Architecture

Two source files plus one test file; the build emits `main.js` at the
repo root for Obsidian to load.

```bash
ls -1 src
```

```output
main.ts
sort.test.ts
sort.ts
```

The module boundary is stated at the top of `sort.ts`: pure functions in,
pure functions out, with `main.ts` owning all editor and metadata-cache
interaction.

```bash
sed -n '1,11p' src/sort.ts
```

```output
// Pure sorting algorithms — no runtime Obsidian dependency (ListItemCache
// is a type-only import). main.ts orchestrates editor state around these;
// tests import them directly.
import type { ListItemCache } from "obsidian";

export interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
}
```

`Line` is the currency of the whole plugin. Each editor line carries two
strings: `source` (what gets written back, byte-for-byte) and `formatted`
(what comparisons see — links resolved to display text, checkbox markers
stripped). `headingLevel` and `lineNumber` come from Obsidian's metadata
cache and drive the two recursive sorts.

## Plugin entry and command registration

`src/main.ts` default-exports `SortLinesPlugin`. `onload` builds one
`Intl.Collator` (locale-aware, numeric, punctuation-insensitive) and
reuses its `compare` everywhere, then registers six commands.

```bash
sed -n '42,65p' src/main.ts
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
```

The remaining three are reverse, shuffle, and the recursive list sort.
The list command is the only one that builds a `ListPart` comparator —
it compares the `formatted` text of each list item's title line.

```bash
sed -n '77,84p' src/main.ts
```

```output
    this.addCommand({
      id: "sort-list-recursively",
      name: "Sort current list recursively",
      callback: () =>
        this.sortListRecursively((a, b) =>
          this.compare(a.title.formatted.trim(), b.title.formatted.trim()),
        ),
    });
```

Every command body is the same four-step pipeline; `sortAlphabetically`
is representative. Each guard failure surfaces a `Notice` instead of
silently doing nothing.

```bash
sed -n '87,100p' src/main.ts
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

## Editor context resolution

Two helpers decide *what range of lines* a command operates on:
`getSelectionContext` for every command but the list sort, and
`getEnclosingListContext` for that one. Both resolve the active
`MarkdownView` and its `CachedMetadata`, read the editor into a plain
`bounds` record, and hand off to a pure resolver in `sort.ts`.

The default resolver picks the user's multi-line selection if there is
one, otherwise the whole file minus YAML frontmatter.

```bash
sed -n '110,116p' src/sort.ts
```

```output
export function resolveSelectionRange(bounds: DocumentBounds): Range {
  const range =
    bounds.from !== bounds.to
      ? { start: bounds.from, end: bounds.to }
      : { start: bounds.frontStart, end: bounds.lastLine };
  return withoutTrailingEmpty(range, bounds);
}
```

The trailing-empty trim is not cosmetic. A file that ends in a newline
has an empty final line; `""` collates before everything, so leaving it
in the range hoisted a blank to the top of every whole-document sort —
injecting a blank line under the frontmatter and dropping the file's
trailing newline.

The list resolver looks for the section enclosing the cursor and falls
back to the default when there is none.

```bash
sed -n '126,140p' src/sort.ts
```

```output
export function resolveListRange(
  bounds: DocumentBounds,
  sections: SectionRef[],
): Range {
  const list = sections.find(
    (s) =>
      s.type === "list" &&
      s.position.start.line <= bounds.from &&
      s.position.end.line >= bounds.to,
  );
  if (list) {
    return { start: list.position.start.line, end: list.position.end.line };
  }
  return resolveSelectionRange(bounds);
}
```

The `if (list)` is load-bearing. A one-item list is a section whose
start and end are the same line; an earlier version tested
`start !== end` here, read that as "no list found", and fell through to
sorting the entire document.

## Line shaping: links, checkboxes, headings

`collectLines` turns raw editor text into the `Line[]` for a range. For
each line it gathers that line's links and embeds, rewrites them to
display text, strips any checkbox marker, then stamps heading levels
from the cache. Comparisons therefore see "what the reader sees", not
the markdown syntax.

Two contracts are easy to break. `end` is inclusive, matching
`EditorContext.end` rather than `Array.slice`. And `lineNumber` stays
absolute — the pre-slice index — because the list sort pads to
`inputLines[0].lineNumber` against a cacheMap keyed by absolute line.

The heading loop skips positions outside the current text: Obsidian's
metadata cache can lag the editor during rapid edits, and a stale line
number must not abort the command.

```bash
sed -n '156,182p' src/sort.ts
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

`main.ts` keeps only the editor coupling — read the buffer, assemble the
cache inputs, delegate:

```bash
sed -n '228,235p' src/main.ts
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

## Heading sort recursion

`sortHeadings` builds a tree of `HeadingPart`s from the flat line list,
sorts siblings at each level, and flattens back. A synthetic level-0
root heading anchors the recursion; `flatten(...).slice(1)` drops it on
the way out.

The walk in `getSortedHeadings` is where a nasty bug used to live. A
section ends only when the walk meets a heading at the same-or-higher
level. An earlier version coerced the *current* line's level with
`?? 0`, so body lines (`headingLevel: undefined` → 0) also satisfied
`<= parent level` and terminated the section — the sort silently
dropped content lines from the document. The fix makes the terminator
check explicit: only lines that *are* headings can end a section; body
lines always accumulate into `contentLines`.

```bash
sed -n '184,226p' src/sort.ts
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

The public wrapper plants the synthetic root, recurses once, then
flattens depth-first — each heading emits its title, its content lines,
then its (already sorted) subtrees.

```bash
sed -n '228,248p' src/sort.ts
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

## Recursive list sort

The list sort leans on Obsidian's `ListItemCache`: for every list item
the cache records `parent` — the *absolute line number* of its parent
item, or a negative number (the negative of the list's first line) for
top-level items. Nesting is encoded entirely in these parent pointers,
not in indentation.

`main.ts` does the editor-side prep: it refuses lists containing blank
lines, builds a `Map` from line number to cache entry, and delegates.

```bash
sed -n '113,126p' src/main.ts
```

```output
    if (inputLines.find((line) => line.source.trim() === "")) {
      new Notice("Sort Lines: list contains blank lines");
      return;
    }
    if (!ctx.cache.listItems) {
      new Notice("Sort Lines: cursor is not inside a list");
      return;
    }

    const cacheMap = new Map(
      ctx.cache.listItems.map((item) => [item.position.start.line, item]),
    );
    this.setLines(ctx, sortListLines(inputLines, cacheMap, compareFn));
  }
```

`sortListLines` has to reconcile two coordinate systems: the cache's
parent pointers are absolute line numbers, but the input is only the
list's slice of the file. It pads the front of the array with
`undefined` entries so index N really is line N, walks the top-level
items, sorts, and flattens.

```bash
sed -n '291,320p' src/sort.ts
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
  const lines = [...new Array(firstLineNumber).fill(undefined), ...inputLines];
  let index = firstLineNumber;

  const children: ListPart[] = [];
  while (index < lines.length) {
    const newChild = getSortedListParts(lines, cacheMap, index, compareFn);
    children.push(newChild);
    index = newChild.lastLine + 1;
  }
  children.sort(compareFn);

  const flatten = (part: ListPart): Line[] =>
    part.children.reduce<Line[]>(
      (acc, cur) => acc.concat(flatten(cur)),
      [part.title],
    );
  return children.reduce<Line[]>((acc, cur) => acc.concat(flatten(cur)), []);
}
```

`getSortedListParts` is the parent-pointer walk, and `parentAt` is its
termination guard — the site of the second recent bug. The child-
collection loop asks "is the next line nested under me?" by comparing
parent pointers, and treats any missing cache entry as parent `-1`.

That was fine for lists starting at line 0, where top-level parents are
`-1`. But a list starting at line 2 gives its top-level items parent
`-3`, and once the walk ran past the end of the array, every
out-of-range lookup also read as `-1` — and `-3 < -1` is true, so
end-of-list looked like an endless run of children and the loop never
terminated. The fix: lines *inside* the list with no cache entry
(continuation lines) still read as `-1`, but lines *past the end* now
read as `-Infinity`, which no real parent pointer can be greater than.

```bash
sed -n '262,289p' src/sort.ts
```

```output
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
    index = newChild.lastLine ?? index;
    children.push(newChild);
  }

  const lastLine = children.at(-1)?.lastLine ?? index;
  children.sort(compareFn);
  return { children, title, lastLine };
}
```

## Writing back

`setLines` closes the loop: it joins the sorted `source` strings and
splices them over the range with `replaceRange`. Because only `source`
is ever written, link syntax and checkbox markers survive sorting
untouched.

This is unconditional. An earlier version branched here, calling
`setValue` to rewrite the whole document when `start === end`. That was
inherited from upstream, where "no selection" really did mean the whole
file — but once frontmatter handling made the no-selection range a
*sub*-range, the branch corrupted frontmatter on any note with a single
line below it. Deleting it left one path for every document.

```bash
sed -n '237,244p' src/main.ts
```

```output
  private setLines(ctx: EditorContext, lines: Line[]) {
    ctx.view.editor.replaceRange(
      lines.map((e) => e.source).join("\n"),
      { line: ctx.start, ch: 0 },
      { line: ctx.end, ch: ctx.endLineLength },
    );
  }
}
```

## Testing approach

Because `sort.ts` has no runtime Obsidian dependency, `src/sort.test.ts`
imports the real production symbols — the repo's rule is to never
re-implement an algorithm in a test; if something isn't importable,
extract it into `sort.ts` first.

```bash
sed -n '1,16p' src/sort.test.ts
```

```output
import { describe, expect, test } from "bun:test";
import type { ListItemCache } from "obsidian";
import {
  CHECKBOX_REGEX,
  collectLines,
  getFrontStart,
  type HeadingRef,
  type Line,
  type LinkRef,
  replaceLinksOnLine,
  resolveListRange,
  resolveSelectionRange,
  type SectionRef,
  sortHeadings,
  sortListLines,
} from "./sort";
```

Both regression bugs are pinned by tests. "content lines stay under
their heading" guards the heading-sort fix, and this one guards the
list-sort termination fix — parent `-3` is exactly the shape that used
to hang:

```bash
sed -n '493,503p' src/sort.test.ts
```

```output
  test("handles a list that does not start at line 0", () => {
    const lines = [
      makeLine("- z", { lineNumber: 2 }),
      makeLine("- a", { lineNumber: 3 }),
    ];
    const cacheMap = new Map([cacheItem(2, -3), cacheItem(3, -3)]);

    const output = sortListLines(lines, cacheMap, compareParts);

    expect(output.map((l) => l.source)).toEqual(["- a", "- z"]);
  });
```

The suite covers all five exported pieces (run it with `bun test`;
counts shown here instead of the timing-laden test output):

```bash
echo "describe blocks: $(grep -c '^describe(' src/sort.test.ts)"; echo "tests: $(grep -c '^  test(' src/sort.test.ts)"
```

```output
describe blocks: 5
tests: 21
```

Five `describe` blocks — `sortHeadings`, `replaceLinksOnLine`,
`CHECKBOX_REGEX`, `getFrontStart`, `sortListLines` — one per exported
piece. What the tests don't cover is `main.ts` itself: the orchestrator
is deliberately thin enough that everything worth testing lives behind
the pure boundary.

