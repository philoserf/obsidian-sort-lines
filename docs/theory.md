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

This has real consequences. The plugin cannot function outside Obsidian. It cannot be meaningfully tested against real documents without mocking Obsidian's entire metadata layer, which is why the test suite instead duplicates the algorithmic functions (`getSortedHeadings`, `replaceLinks`, `getFrontStart`) as free-standing copies with their own interface definitions. The tests verify the algorithms work on pre-digested data; they do not and cannot verify that Obsidian's cache produces the data the algorithms expect. This is a deliberate trade-off: the plugin trusts the host environment completely and gains simplicity by not reimplementing markdown parsing, at the cost of an untestable seam at the cache boundary.

## Two kinds of hierarchy, two different strategies

Heading sort and list sort both process recursive structures, but they work differently because the underlying data differs.

**Heading sort** works from a flat array of `Line` objects, some of which have a `headingLevel`. `getSortedHeadings` walks this array linearly, building a tree as it goes: when it encounters a heading deeper than the current one, it recurses; when it encounters one at the same level or shallower, it returns. Content lines (non-headings) between headings are attached to the most recent heading. Sibling headings at each level are sorted independently. The tree is then flattened back to a line array. This is a clean, self-contained algorithm — it only needs the heading levels, which are simple integers.

**List sort** is more complex because list nesting in Obsidian is represented not by indentation depth but by parent pointers: each `ListItemCache` entry has a `parent` field that is either the line number of its parent item or a negative number for top-level items. The `getSortedListParts` function walks forward through the line array, using these parent pointers to determine which subsequent items are children of the current one. The while-loop condition at line 173-177 is the trickiest code in the codebase: it continues collecting children as long as the next line's parent pointer is deeper than the current item's parent, or (for top-level items) as long as the next line has any parent at all. This works, but the logic is dense enough that a wrong reading of what Obsidian means by "parent" values would produce subtly incorrect nesting. The list sort also has a guard that no other command has: it rejects input containing blank lines, because blank lines would break the assumption that the list is contiguous and that parent pointers form a connected tree.

There is also a structural difference in how context is obtained. List sort passes `fromCurrentList: true` to `getEditorContext`, which causes the method to expand the cursor position to encompass the entire list section (found via `cache.sections`). All other commands use the selection as-is, or fall back to the full document minus frontmatter. This is because a list is a coherent unit that shouldn't be partially sorted — if your cursor is anywhere inside a list, you almost certainly mean the whole list.

## The seam between selection and document

`getEditorContext` is the boundary negotiation layer. It answers: what region of the document should this operation affect? The rules are:

1. If the user has a multi-line selection, use those lines.
2. If the command is list-sort, expand the cursor to the enclosing list section.
3. Otherwise, use the entire document from after the frontmatter to the end.

This is where `start`, `end`, and `endLineLength` are computed, and `setLines` uses these to decide whether to call `replaceRange` (selection) or `setValue` (whole document). The distinction matters because `replaceRange` preserves content outside the selection, while `setValue` replaces everything.

A subtle consequence: when sorting the whole document, frontmatter is excluded from the sort range but the `getLines` method reads the _entire_ document and then slices. This means every line gets processed through the link-replacement and checkbox-stripping pipeline, including lines that will be discarded. This is wasteful but harmless, and avoiding it would complicate the code for no user-visible benefit.

## What the code is shaped to accommodate

**Adding a new sort order** is trivial. Copy `sortAlphabetically`, change the comparator, register a new command. The pattern is fully established and every sort command follows the same shape: get context, get lines, sort, set lines.

**Adding a new structural sort** (something beyond flat lines, headings, and lists) would be moderate work. You'd need a new recursive builder analogous to `getSortedHeadings` or `getSortedListParts`, and you'd need to decide how `getEditorContext` should handle selection expansion for the new structure. The pattern exists but isn't abstracted — you'd be writing a new instance, not plugging into a framework.

**Changing what "formatted" means** — the normalization pipeline — is where a maintainer who doesn't understand the theory would cause damage. Adding a new normalization step requires understanding the order dependency (links before checkboxes), the right-to-left splicing requirement, and the principle that `source` must never be modified. Someone who tried to "simplify" by normalizing in place, or who added a transformation that altered `source`, would break the fundamental invariant.

**Changing how the plugin interacts with Obsidian's cache** would be the hardest kind of change. The parent-pointer logic for lists, the section-finding for list context expansion, and the heading-level association all depend on specific properties of `CachedMetadata`. If Obsidian's API changed the shape of these structures, the plugin would break in ways that no unit test would catch, because the tests don't exercise the cache integration.

## Uncertainties and tensions

**The duplicated test code.** The test file re-declares the `Line` and `HeadingPart` interfaces and re-implements `getSortedHeadings` and the link-replacement function as standalone copies rather than importing from `main.ts`. This means the tests can drift from the implementation. Today they appear to be in sync — but the `headingsToString` helper in the test uses `headings[headings.length - 1]` while the production code uses `.at(-1)`, suggesting they were written (or edited) at slightly different times. If someone refactors the production algorithm and forgets to update the test copy, the tests will still pass while testing the wrong thing. I believe this duplication exists because the production code is a class with private methods that can't be easily imported, and because the Obsidian dependency makes the module difficult to import in a test context. It's a pragmatic choice, but it's the thinnest part of the testing theory.

**The checkbox asymmetry.** Checked checkboxes are stripped for sorting; unchecked ones are not. I can see two possible intents: either the author wanted checked items to sort as if they were plain text (so they intermix naturally with non-task lines), or the regex was written to match "interesting" checkbox states and the exclusion of unchecked boxes is a side effect of the pattern `[^ ]` (which requires a non-space character). The comment on line 32-33 says "matches any non-empty checkbox," suggesting the distinction is intentional — but the _sorting consequence_ of this choice is never documented or tested.

**The `compare` field.** The collator is initialized in `onload` and stored as a class field with the non-null assertion `!`. If any code path reached `compare` before `onload` ran, it would throw. This is safe given Obsidian's plugin lifecycle (commands can't fire before `onload` completes), but it's an implicit contract with the host environment that isn't enforced by the type system.

**List sort's blank-line guard.** This is the only command that validates its input beyond "are there lines?" The presence of this guard implies that the list-sorting algorithm would produce incorrect results (or crash) on non-contiguous lists, but the nature of the failure isn't documented. A maintainer extending list sort would need to understand that parent pointers assume contiguity.

**The `setLines` split.** When `start !== end`, the method uses `replaceRange`; otherwise `setValue`. But the "otherwise" case corresponds to "no selection, sort the whole document," where `start` is the frontmatter boundary and `end` is the last line — yet `start !== end` would be true for any document longer than one line. Looking more carefully: when there's no multi-line selection _and_ `fromCurrentList` didn't expand the range, the code falls through to the `start: frontStart, end: frontEnd` branch, where `start !== end` will almost always be true. The `setValue` path (the `else` in `setLines`) would only trigger for a single-line document with no frontmatter. This appears to be dead code in practice, or at least a path that only fires in a degenerate case. A maintainer might be tempted to remove it, but it's the safe fallback and the cost of keeping it is nil.
