# Changelog

## 2.0.2

### Fixed

- Sorting a note with frontmatter and a single line below it no longer shuffles the frontmatter into the body and overwrites the file (#66). The whole-document range is now spliced with `replaceRange` in every case; the `setValue` fallback it replaced dated from upstream, where "no selection" meant the whole file rather than the range below the frontmatter
- A stale metadata cache no longer aborts a command with a `TypeError` when a heading position points past the end of the document (#64)

### Changed

- Extract `collectLines` into `sort.ts` so the line-shaping and range logic is testable without Obsidian (#66, #64)
- Drop the inert `i` flag from `CHECKBOX_REGEX` — the pattern contains no letters to case-fold (#61)
- Remove the non-existent `scripts/` directory from `biome.json` (#59)

## 2.0.1

### Fixed

- Sort headings no longer deletes content lines under headings (regression from the tooling modernization: a `?? 0` coercion made body lines terminate sections)
- Sort current list recursively no longer loops forever on lists that do not start at line 0 (past-the-end lines terminated the parent-pointer walk incorrectly)

### Changed

- Extract pure sort algorithms into `sort.ts`; tests import production code instead of re-implementing it (#57)
- Update dependencies

## 2.0.0

### Removed

- 5 commands: checkbox-aware sorts (handled by other tools) and flat-list sort (redundant with recursive)
- `checked` field from Line type

### Changed

- Heading sort uses pure alphabetical comparison (previously sorted by level first)
- `sortAlphabetically` simplified to no-arg method
- Inlined `headingsToString` and `listPartToList` single-use helpers

### Removed (tests)

- 5 test suites that tested language built-ins rather than plugin logic
- 5 redundant checkbox regex tests (8 to 3)

## 1.1.0

### Added

- User feedback via Notice when commands silently fail (no editor, no lines, blank lines in list)
- Fisher-Yates shuffle replacing Obsidian's `Array.prototype.shuffle()` patch
- Pre-release validation in the release workflow
- Repository settings configuration

### Fixed

- List commands now restricted to list sections only
- Positional splicing for wiki-link replacement (fixes duplicate link handling)
- Release workflow restricted to semver tags
- Glob pattern for tag filter instead of regex
- Explicit types in tsconfig for TypeScript 6
- Dead NaN guard removed from frontmatter boundary calculation

### Changed

- Replaced Obsidian Array.prototype extensions with standard JavaScript
- Updated dependencies: Biome, bun-types, TypeScript, @types/node
- Normalized CI workflow whitespace
- Updated LICENSE to MIT with current copyright

## 1.0.0

Initial release. Sort and permute lines, lists, and headings in Obsidian.
