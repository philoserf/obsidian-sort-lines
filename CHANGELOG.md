# Changelog

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
