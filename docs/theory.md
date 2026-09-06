# A Theory of obsidian-sort-lines

## What the system is for

This plugin solves a specific problem for people who think in structured text: when you have a list, a set of headings, or a block of lines in an Obsidian note, and you want to reorder them without leaving the editor. The world it models is a markdown document understood not as a flat string but as a hierarchy of sortable regions — lines, lists with nesting, and heading trees — where reordering must preserve structural relationships that the user considers load-bearing but that live outside the text itself (a child list item must follow its parent; a section under a heading must move with that heading).

The core entities are **lines**, **lists**, and **heading trees**. A line is the atomic unit. A list is a tree of lines whose parent-child relationships are defined by indentation. A heading tree is a recursive structure where each heading owns the content and sub-headings beneath it until the next heading of equal or lesser depth. The plugin offers six operations: alphabetical sort, length sort, heading sort, list sort, reverse, and shuffle. That's the full surface area. It used to be eleven commands with checkbox-aware variants and flat list sorts; the 2.0.0 release deliberately cut five of them, choosing a smaller, cleaner conceptual footprint over configurability.

## The load-bearing abstraction: dual-identity lines

The single most important design idea in this codebase is that every line carries two representations: `source` and `formatted`. The `source` is the original text — what gets written back to the document, untouched. The `formatted` is a derived version with Obsidian wiki-links replaced by their display text and checked checkboxes stripped. Sorting always compares `formatted`; writing always emits `source`. This separation is what allows the plugin to sort `[[2024-01-15|Tuesday meeting]]` by the text "Tuesday meeting" rather than by the link syntax, and to sort `- [x] Buy groceries` by "Buy groceries" rather than by the checkbox marker — without ever modifying the user's actual text.

The normalization pipeline in `getLines` builds this dual representation in a specific order: first, links and embeds are replaced by positional splicing (right-to-left, to avoid invalidating column indices); then checked checkboxes are stripped via regex, preserving leading whitespace. The right-to-left link splicing is a small but critical detail — if you splice left-to-right, replacing a `[[long link|short]]` shifts all subsequent column positions. The tests for this are the most thorough in the suite, and they're testing exactly this invariant.

A subtlety worth noting: unchecked checkboxes (`- [ ] task`) are _not_ stripped. Only non-empty checkboxes (`- [x]`, `- [-]`, `- [?]`, etc.) are removed from the formatted representation. This means an unchecked task sorts with its `- [ ]` prefix intact, while a checked task sorts purely by its text content. Whether this is a deliberate sorting-semantics choice (checked items intermix freely with non-task lines; unchecked items cluster together) or an artifact of the regex design, I cannot determine from the code alone.

## The system doesn't parse markdown

This is perhaps the most consequential design decision: the plugin does not parse the document. It delegates all structural understanding to Obsidian's `CachedMetadata`. Heading levels, list nesting (via `ListItemCache.parent`), link positions, embed positions, frontmatter boundaries — all come from the cache that Obsidian maintains as a side effect of rendering the document. The plugin is a pure consumer of this metadata.

This has real consequences. The plugin cannot function outside Obsidian. It cannot be meaningfully tested against real documents without mocking Obsidian's entire metadata layer, which is why the pure algorithms live in `sort.ts` behind structural types (`LinkRef`, `HeadingRef`, `SectionRef`) that describe the shape the plugin needs rather than importing Obsidian's own. `src/sort.test.ts` imports those production symbols directly. The tests verify the algorithms work on pre-digested data; they do not and cannot verify that Obsidian's cache produces the data the algorithms expect. This is a deliberate trade-off: the plugin trusts the host environment completely and gains simplicity by not reimplementing markdown parsing, at the cost of an untestable seam at the cache boundary.

## Two kinds of hierarchy, two different strategies

Heading sort and list sort both process recursive structures, but they work differently because the underlying data differs.

**Heading sort** works from a flat array of `Line` objects, some of which have a `headingLevel`. `getSortedHeadings` walks this array linearly, building a tree as it goes: when it encounters a heading deeper than the current one, it recurses; when it encounters one at the same level or shallower, it returns. Content lines (non-headings) between headings are attached to the most recent heading. Sibling headings at each level are sorted independently. The tree is then flattened back to a line array. This is a clean, self-contained algorithm — it only needs the heading levels, which are simple integers.

**List sort** is more complex because list nesting in Obsidian is represented not by indentation depth but by parent pointers: each `ListItemCache` entry has a `parent` field that is either the line number of its parent item or a negative number for top-level items. The `getSortedListParts` function walks forward through the line array, using these parent pointers to determine which subsequent items are children of the current one. The while-loop condition at `src/sort.ts:282-285` is the trickiest code in the codebase: it continues collecting children as long as the next line's parent pointer is deeper than the current item's parent, or (for top-level items) as long as the next line has any parent at all. This works, but the logic is dense enough that a wrong reading of what Obsidian means by "parent" values would produce subtly incorrect nesting. The list sort also has a guard that no other command has: it rejects input containing blank lines, because blank lines would break the assumption that the list is contiguous and that parent pointers form a connected tree.

There is also a structural difference in how context is obtained. List sort calls `getEnclosingListContext`, which expands the cursor position to the entire list section (found via `cache.sections`); every other command calls `getSelectionContext`. All other commands use the selection as-is, or fall back to the full document minus frontmatter. This is because a list is a coherent unit that shouldn't be partially sorted — if your cursor is anywhere inside a list, you almost certainly mean the whole list.

## The seam between selection and document

The range resolvers are the boundary negotiation layer. They answer: what region of the document should this operation affect? The rules are:

1. If the command is list-sort and a list section encloses the cursor, use that section — including a one-item list, whose start and end are the same line.
2. Otherwise, if the user has a multi-line selection, use those lines.
3. Otherwise, use the entire document from after the frontmatter to the end.

In every case, an empty final line is dropped from the range unless it is the only line in it. A file ending in a newline has one, and `""` collates before everything, so leaving it in hoisted a blank to the top of every sort.

The decision itself is pure and lives in `sort.ts`; `main.ts` only reads the editor into a `bounds` record and applies the answer, computing `endLineLength` from the *final* range. `setLines` splices that range with `replaceRange`, unconditionally — one path for every document. `replaceRange` preserves content outside the range, which is what keeps frontmatter intact when the sort range starts below it.

A subtle consequence: when sorting the whole document, frontmatter is excluded from the sort range but the `getLines` method reads the _entire_ document and then slices. This means every line gets processed through the link-replacement and checkbox-stripping pipeline, including lines that will be discarded. This is wasteful but harmless, and avoiding it would complicate the code for no user-visible benefit.

## What the code is shaped to accommodate

**Adding a new sort order** is trivial. Copy `sortAlphabetically`, change the comparator, register a new command. The pattern is fully established and every sort command follows the same shape: get context, get lines, sort, set lines.

**Adding a new structural sort** (something beyond flat lines, headings, and lists) would be moderate work. You'd need a new recursive builder analogous to `getSortedHeadings` or `getSortedListParts`, and you'd need to decide how the range resolvers (`resolveSelectionRange`, `resolveListRange`) should handle expansion for the new structure. The pattern exists but isn't abstracted — you'd be writing a new instance, not plugging into a framework.

**Changing what "formatted" means** — the normalization pipeline — is where a maintainer who doesn't understand the theory would cause damage. Adding a new normalization step requires understanding the order dependency (links before checkboxes), the right-to-left splicing requirement, and the principle that `source` must never be modified. Someone who tried to "simplify" by normalizing in place, or who added a transformation that altered `source`, would break the fundamental invariant.

**Changing how the plugin interacts with Obsidian's cache** would be the hardest kind of change. The parent-pointer logic for lists, the section-finding for list context expansion, and the heading-level association all depend on specific properties of `CachedMetadata`. If Obsidian's API changed the shape of these structures, the plugin would break in ways that no unit test would catch. The structural types in `sort.ts` pin down what the plugin *expects* of the cache, and the tests exercise the algorithms against that expectation — but nothing verifies that Obsidian still *supplies* it. The seam moved; it did not close.

## Uncertainties and tensions

**The editor-reading seam.** The algorithms are testable, but the code that feeds them is not. `main.ts` reads live editor state into a plain `bounds` record — cursor lines, `lastLine()`, whether the final line is empty — and the resolvers are tested against synthetic versions of that record. Nothing checks that what `main.ts` reads matches what the resolvers assume. Every range bug found so far (#66, #70, #71) lived exactly here: the algorithms were right and the range handed to them was wrong. This is now the thinnest part of the testing theory, and it is where I would look first for the next one.

**The checkbox asymmetry.** Checked checkboxes are stripped for sorting; unchecked ones are not. I can see two possible intents: either the author wanted checked items to sort as if they were plain text (so they intermix naturally with non-task lines), or the regex was written to match "interesting" checkbox states and the exclusion of unchecked boxes is a side effect of the pattern `[^ ]` (which requires a non-space character). The comment on line 32-33 says "matches any non-empty checkbox," suggesting the distinction is intentional — but the _sorting consequence_ of this choice is never documented or tested.

**The `compare` field.** Resolved in 2.0.3. The collator is now built as a class field initializer rather than assigned in `onload` behind a `!` assertion, so there is no window in which `compare` exists but is unset. This does introduce a quieter assumption: `navigator.language` must be readable at plugin construction, which holds in Obsidian's Electron renderer but is a host contract rather than a guarantee.

**List sort's blank-line guard.** This is the only command that validates its input beyond "are there lines?" The presence of this guard implies that the list-sorting algorithm would produce incorrect results (or crash) on non-contiguous lists, but the nature of the failure isn't documented. A maintainer extending list sort would need to understand that parent pointers assume contiguity.

**The `setLines` split, removed in 2.0.2.** `setLines` used to call `replaceRange` when `start !== end` and `setValue` otherwise. The `else` was inherited from upstream, where "no selection" genuinely meant the whole file; once frontmatter handling redefined the no-selection range as a _sub_-range `[frontStart, lastLine]`, that branch was wrong. It fired precisely when `frontStart === lastLine` — a note with frontmatter and one line below it — and rewrote the whole document with the sorted result, destroying the frontmatter. `getLines` had the mirror-image bug, returning every line unsliced in the same case. Both branches are gone; the remaining path is the one that was always correct. Read this as a caution about "harmless dead code": the branch survived because the condition looked unreachable, and the reasoning that made it look unreachable was itself the bug.
