# Sort Lines

Sort and permute lines, lists, and headings in [Obsidian](https://obsidian.md/). Originally created by [Vinzent](https://github.com/Vinzent03/obsidian-sort-and-permute-lines).

## You probably shouldn't install this

This is personal tooling, not a general-purpose plugin. It is opinionated in ways that only make sense for one person's workflow:

- **Single user.** The only known installation is the maintainer's. Breaking changes ship without migration paths (see `CHANGELOG.md` — 2.0.0 removed five commands including checkbox-aware sorts and flat-list sort, changed heading sort to pure alphabetical).
- **Fork, not upstream.** This diverged from `Vinzent03/obsidian-sort-and-permute-lines` and is not a drop-in replacement. Commands were removed, sort behavior changed, and internals restructured.
- **No issue triage for feature requests.** Bugs are welcome; feature requests from other users will almost always be closed as out-of-scope.

If you want something similar, the code is MIT-licensed — fork it and adapt. Don't expect upstream to accommodate your workflow.

## Commands

| Command              | Behavior                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| Sort alphabetically  | Sort selected lines (or whole file) alphabetically using `Intl.Collator` |
| Sort by length       | Sort selected lines by character count                                   |
| Sort headings        | Recursively sort heading sections alphabetically at each level           |
| Reverse              | Reverse the order of selected lines                                      |
| Shuffle              | Randomly reorder selected lines (Fisher-Yates)                           |
| Sort list recursively | Sort the enclosing list and all nested sublists alphabetically          |

All commands operate on the current selection. If nothing is selected, the whole file is used (excluding frontmatter). List commands operate on the enclosing list at the cursor.

## Alternatives

- [Vinzent03/obsidian-sort-and-permute-lines](https://github.com/Vinzent03/obsidian-sort-and-permute-lines) — the original upstream this fork diverged from.
