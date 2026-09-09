# A Theory of obsidian-sort-lines

Written for the engineer who inherits this next month. It is not a tour of the files; it is
the set of ideas you have to be holding in mind before you change anything here safely.

## What the system is for

A note in Obsidian is a flat string, but the person editing it does not experience it as one.
They see a list whose indentation means containment, a heading whose position means ownership
of everything beneath it, a run of lines that means nothing in particular. This plugin exists
to let that person reorder those things without leaving the editor, and — this is the whole
difficulty — without the reordering destroying the relationships that were never written down
in the text.

Three domain entities, in ascending order of how much trouble they cause:

- A **line** is the atom. Reordering lines is a sort with no structure to preserve.
- A **heading tree** is recursive by depth: an `##` owns every line and every `###` beneath it
  until the next `##` or `#`. Reordering headings means moving subtrees, not lines.
- A **list** is recursive by parentage: a nested item belongs to the item above it. Reordering
  a list means moving subtrees again, but the tree is described differently, and that
  difference drives most of the code's shape.

Six commands cover this: alphabetical, by length, headings, reverse, shuffle, and recursive
list sort. That is the entire surface. Version 2.0.0 deliberately cut it down from eleven,
dropping checkbox-aware variants and flat list sort. The README says out loud that this is
one person's tool and that feature requests will be declined. Read that as a design
constraint, not modesty: **the correct response to a new use case here is usually no.**

## The load-bearing idea: a line has two texts

Everything else follows from this. A `Line` carries `source` and `formatted`.

`source` is the user's actual bytes. It is what gets written back, always, unmodified.
`formatted` is a derived reading used only for comparison, and never written anywhere.

The reason is that the text a user wants to sort by is frequently not the text on the page.
`[[2024-01-15|Tuesday standup]]` should sort under T, not under `[`. `- [x] Buy milk` should
sort under B, not under `-`. So `formatted` strips the wiki-link syntax down to display text
and strips completed-checkbox markers, and the comparators all run against `formatted.trim()`
while `setLines` emits `source`.

The invariant is one sentence: **sorting reads `formatted`, writing emits `source`, and
nothing ever writes back a `formatted` string.** If you break this, the plugin starts quietly
rewriting people's links into plain text on every sort, and no test will tell you, because
the tests assert on `source` and the corruption would be in `source`.

Two ordering details inside the derivation are not stylistic:

`replaceLinksOnLine` sorts the links by column **descending** and splices right to left.
Splicing left to right would invalidate every column index to the right of the first
replacement, because the replacement text is a different length than the link syntax. There is
a test named for exactly this ("links provided in forward order still splice correctly"),
which tells you it has bitten someone.

Links are replaced **before** checkboxes are stripped. `CHECKBOX_REGEX` is anchored at the
start of the line, so it must see a line whose leading text has not been shifted by a
link replacement. The order is not reversible.

## The system refuses to parse markdown

The second organizing decision, and the one that most shapes what is easy and what is
impossible: this plugin does no markdown parsing. Heading levels, list nesting, link spans,
embed spans, frontmatter extent — every structural fact comes from Obsidian's
`CachedMetadata`, which Obsidian maintains anyway as a side effect of rendering.

This buys enormous simplicity and costs a seam that cannot be tested. `sort.ts` does not
import Obsidian's types at runtime; it declares structural shapes of its own (`LinkRef`,
`HeadingRef`, `SectionRef`) that describe only the fields it needs. That is what lets
`src/sort.test.ts` import the real production functions and feed them synthetic data. But it
also means the tests verify that the algorithms are right _about data of that shape_ and can
never verify that Obsidian still hands over data of that shape. If Obsidian changes what
`ListItemCache.parent` means, all 42 tests still pass and the plugin is broken.

One hedge is already in place and worth understanding before you "simplify" it: `collectLines`
skips heading positions that fall outside the current text (`if (!target) continue`). The
metadata cache lags the editor during fast typing, so a stale line number is expected, not
exceptional, and must not abort the command.

## Two hierarchies, two algorithms, and why they can't share code

You will be tempted to unify `sortHeadings` and `sortListLines`. Don't, until you understand
why they differ — the difference is in the data, not the code.

**Headings** are described by _depth_: an integer 1–6 on the heading line itself. So
`getSortedHeadings` can walk the line array linearly and decide everything locally: a heading
at a level less than or equal to mine ends my section; anything else is mine. Content lines
(`headingLevel === undefined`) are never terminators — they attach to the most recent heading
and ride along with it. A synthetic root `Line` at level 0 seeds the recursion, and the final
`.slice(1)` drops it.

**Lists** are described by _parentage_: `ListItemCache.parent` is the absolute line number of
the parent item, or a negative number for a top-level item. Depth is not stored. So
`getSortedListParts` cannot decide locally; it has to compare parent pointers between adjacent
lines, which is what the dense two-clause `while` condition in `getSortedListParts` is doing.

This is the highest-risk code in the repository, and three sentinel values keep it alive:

- A line inside the list with no cache entry (a continuation line) reads as `-1`.
- A line past the end of the array reads as `-Infinity`, so the walk always terminates.
- The `-Infinity` is load-bearing, not defensive. A top-level item in a list starting at line 2
  has `parent === -3`, and `-3 < -1`. Without a sentinel strictly below every real parent
  value, end-of-list would read as an endless run of children.

The other consequence of absolute parent pointers is the padding trick in `sortListLines`:
the input lines are prefixed with `firstLineNumber` undefined slots so that array index equals
absolute line number, because that is the key space `cacheMap` lives in.

## The invariant that is easiest to break by accident

**`Line.lineNumber` is the absolute line index in the document, never an index into the sorted
range.** `collectLines` assigns it before slicing, precisely so slicing does not disturb it.

This looks like a detail you could tidy up — renumbering a sliced array from zero is the
obvious thing to do — and it would silently break list sorting only, and only for lists that
do not begin at line 0. Both the code comment and `CLAUDE.md` warn about it, which is the
right level of protection available, because nothing enforces it. The test "handles a list
that does not start at line 0" is the tripwire; if you ever find yourself deleting it, stop.

## The seams

**Editor to algorithm.** `main.ts` reads live editor state into a plain `bounds` record —
cursor from/to, `lastLine()`, whether the last line is empty, frontmatter end — and hands that
record to pure resolvers. The _decision_ about what to sort is therefore testable; the _reading_
is not. This is the thinnest ice in the codebase and it has cracked repeatedly: the changelog
attributes several range bugs to this seam, and in every case the algorithm was correct and the
range handed to it was wrong.

**Range resolution.** Three rules, in order. A list sort uses the list section enclosing the
cursor, and if there is none it reports "cursor is not inside a list" and stops. A multi-line
selection (`from !== to`) is the range. Otherwise the range is frontmatter-end to last line.

Two of these deserve explicit attention because both are scar tissue:

`resolveListRange` returns `undefined` rather than falling back to the whole document. The
comment says why, and it is worth preserving: falling back meant the list algorithm ran over
prose whenever the cursor sat outside a list, absorbing following lines into the nearest list
item. "No list here" is a legitimate answer.

`withoutTrailingEmpty` drops a final empty line from the range unless it is the only line.
A file ending in a newline has one, and `""` collates before everything, so leaving it in
hoists a blank line to the top of every single sort.

**Write-back.** `setLines` always calls `replaceRange` over the exact resolved range. There is
no second path. An earlier version branched to `setValue` when `start === end`, and that branch
destroyed frontmatter on a note with frontmatter plus one line. The single path is not laziness;
it is the fix.

`endLineLength` is read in `buildContext` _after_ the range is final. Reading it earlier
measures a line the write no longer ends on.

## What this is shaped for, and what it isn't

**Easy:** a new comparator. Every non-list command is the same five steps — resolve context,
collect lines, guard emptiness, permute, write back — and adding a sixth ordering means copying
that shape and changing one line. The duplication across those five methods is real and is the
price of that shape being obvious.

**Moderate:** a new structural sort. You would write a new recursive builder alongside
`getSortedHeadings` and `getSortedListParts` and decide how range resolution expands for it.
There is a pattern to follow but no framework to plug into, and that is a deliberate choice at
this size.

**Hard, and where an unaware maintainer does damage:** anything touching what `formatted`
means, and anything touching the parent-pointer walk. For the first, the failure mode is silent
corruption of user text. For the second, it is subtly wrong nesting that looks plausible.

**Effectively out of reach:** decoupling from `CachedMetadata`. That would mean parsing
markdown, which is the thing this design exists to avoid.

## Uncertainties

These are inferences from code, and I could be wrong.

**The checkbox asymmetry is unexplained.** `CHECKBOX_REGEX` is `/^(\s*)- \[[^ ]\]/`. The
`[^ ]` requires a non-space, so `- [x]`, `- [-]`, `- [?]` are stripped from `formatted` and
`- [ ]` is not. I cannot tell from the code whether this is a sorting decision (completed items
should intermix with prose; open tasks should cluster under `- [ ]`) or a side effect of a regex
written to match "interesting" statuses. The comment says "intentionally broad," which addresses
the breadth but not the asymmetry. The consequence is untested and undocumented.

**Whether `main.ts`'s per-command duplication is considered a cost.** Five methods repeat the
same two guards and the same notice strings. That may be a deliberate preference for flat,
obvious code, or accumulated copy-paste. Nothing in the history says which.

**Why `sortListRecursively` is parameterized.** It takes a `compareFn` argument and has exactly
one caller, which passes the only comparator that exists. This is either a vestige of the
removed flat-list sort or a hook for a future one.

**Whether shuffle is meant to be unbiased.** The Fisher-Yates loop is correct, but the
`if (!from || !to) continue` guard could in principle skip a swap. In practice both indices are
always in range, so it never fires; the comment says it exists to satisfy the compiler without
an assertion. That reads as true, but it means a real out-of-range condition would silently
degrade the shuffle rather than fail.

## Index

| #   | Severity | Issue                                             | Primary location     |
| --- | -------- | ------------------------------------------------- | -------------------- |
| 1   | medium   | `checkbox-stripping-bypasses-the-cache-only-rule` | `src/sort.ts:62,173` |

**Total: 1 issue (0 critical, 0 high, 1 medium, 0 low)**

Three further findings were raised against the previous draft and resolved when this document
replaced it: the two that tracked `docs/theory.md` (wrong location, stale line numbers) and the
one naming release skills that do not exist (`CLAUDE.md`).
