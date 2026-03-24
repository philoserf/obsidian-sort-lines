# Reduce, Simplify, Remove

Refactoring spec for obsidian-sort-lines. Prioritizes deletions over renames, inlining over extracting, and flattening over restructuring. Sole-owner code with no backward compatibility constraints.

## Context

The plugin has 11 commands, 463 lines of plugin code, and 397 lines of tests. Several commands exist for checkbox-aware sorting that is now handled by other tools. Flat-list sort variants are redundant given recursive sort handles flat lists correctly. Tests include suites that verify JavaScript built-ins rather than plugin logic.

## Goals

- Remove unused features (checkbox handling, flat-list commands)
- Inline single-use helper methods
- Delete tests that don't test plugin logic
- Simplify heading sort comparator

## Non-Goals

- Restructuring into multiple files
- Introducing new abstractions
- Changing build, CI, or release tooling

## Commands: 11 to 6

### Delete (5)

| Command                                    | Reason                                                                                                                                                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sort-alphabetically-with-checkboxes`      | Checkbox sorting handled elsewhere                                                                                                                                                                                       |
| `sort-list-alphabetically-with-checkboxes` | Checkbox sorting handled elsewhere                                                                                                                                                                                       |
| `sort-checkboxes`                          | Checkbox sorting handled elsewhere                                                                                                                                                                                       |
| `sort-list-recursively-with-checkboxes`    | Checkbox sorting handled elsewhere                                                                                                                                                                                       |
| `sort-list-alphabetically`                 | Redundant; recursive sort handles flat lists. Note: recursive sort requires `cache.listItems` and rejects blank lines, which the flat version did not. Acceptable tradeoff — blank lines can be stripped by other tools. |

### Keep (6)

| Command                 | Behavior                                  |
| ----------------------- | ----------------------------------------- |
| `sort-alphabetically`   | Flat alpha sort on selection or whole doc |
| `sort-list-recursively` | Recursive alpha sort on current list      |
| `sort-length`           | Sort by line length                       |
| `sort-headings`         | Recursive heading tree sort               |
| `permute-reverse`       | Reverse lines                             |
| `permute-shuffle`       | Shuffle lines                             |

## Plugin Changes (`src/main.ts`)

### Delete `checked` from `Line`

The `checked` field is only used by checkbox-aware comparators, which are being removed. Delete the field from:

- The `Line` interface definition
- The `getLines` method (the `CHECKBOX_REGEX.test(line)` assignment)
- The dummy `Line` literal in `sortHeadings` (`checked: false` at line 257)
- The test's `Line` interface and `makeLine` function

Keep `CHECKBOX_REGEX` — it is still used to strip checkbox markup from `formatted` so that `- [x] apple` sorts as `apple`.

### Simplify `sortAlphabetically`

Remove both parameters (`fromCurrentList`, `ignoreCheckboxes`). The method always:

- Calls `getEditorContext(false)` (selection or whole doc)
- Uses the plain alpha comparator

### Delete comparator definitions in `onload()`

The `alphabetical` and `alphabeticalWithCheckboxes` closures (currently at lines 100-105) are deleted. The remaining `sort-list-recursively` command gets an inline comparator: `(a, b) => this.compare(a.title.formatted.trim(), b.title.formatted.trim())`.

### Inline `listPartToList`

Called once from `sortListRecursively`. Move the recursive flatten into the calling method as a local function or inline the reduce.

### Inline `headingsToString`

Called once from `sortHeadings`. Move the recursive flatten into the calling method body.

### Simplify heading sort comparator

Replace the two-phase comparator (heading level, then alpha) with pure alphabetical. This is a behavioral change: mixed-level siblings (e.g., `##` and `###` at the same nesting depth) were previously grouped by level first. In practice, well-formed markdown doesn't mix levels as siblings, so this simplification is safe:

```ts
headings.sort((a, b) =>
  this.compare(a.title.formatted.trim(), b.title.formatted.trim()),
);
```

## Test Changes (`src/main.test.ts`)

### Delete 5 suites

| Suite                                 | Reason                                     |
| ------------------------------------- | ------------------------------------------ |
| `"alphabetical sort"`                 | Tests `Intl.Collator`, not plugin logic    |
| `"alphabetical sort with checkboxes"` | Tests deleted feature                      |
| `"sort by length"`                    | Tests `Array.sort` with trivial comparator |
| `"reverse"`                           | Tests `Array.reverse()`                    |
| `"fisher-yates shuffle"`              | Tests a 4-line loop, trivial edge cases    |

### Trim `"checkbox regex"` from 8 to 3 tests

Keep:

- matches `[x]` (core positive case)
- rejects `[ ]` (critical negative case)
- matches `[-]` (alternative status)

Delete:

- matches `[X]` (redundant; `[^ ]` matches any non-space character)
- matches `[?]`, `[/]` (same character class as `[-]`)
- matches indented (tests `\s*` anchoring)
- rejects plain text (trivially correct from `^` anchor)

### Update heading sort test comparator

The test's local `getSortedHeadings` function has its own copy of the two-phase comparator (level, then alpha). Update it to pure alphabetical to match the production change.

### Keep intact

- `"heading sort"` — tests real recursive algorithm (comparator updated per above)
- `"link replacement by positional splicing"` — tests non-obvious right-to-left behavior
- `"frontmatter boundary calculation"` — tests real edge case in optional chaining

## Unchanged

- `EditorContext`, `HeadingPart`, `ListPart` interfaces
- `getEditorContext`, `setLines` methods
- `getLines` method (modified only to remove `checked` assignment; logic unchanged)
- `CHECKBOX_REGEX` (still strips markup from `formatted`)
- `sortLengthOfLine`, `permuteReverse`, `permuteShuffle` method bodies
- Build script, CI workflow, release workflow, validate script

## Estimated Impact

| Metric        | Before | After |
| ------------- | ------ | ----- |
| Commands      | 11     | 6     |
| Plugin lines  | ~463   | ~280  |
| Test lines    | ~397   | ~250  |
| Interfaces    | 4      | 4     |
| `Line` fields | 5      | 4     |
