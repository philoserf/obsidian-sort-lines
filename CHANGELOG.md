# Changelog

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
