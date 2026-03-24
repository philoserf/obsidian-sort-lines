# Reduce, Simplify, Remove — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the plugin from 11 commands to 6 and reduce total code by ~330 lines through deletion, inlining, and simplification.

**Architecture:** Single-file Obsidian plugin (`src/main.ts`) with co-located tests (`src/main.test.ts`). All changes are within these two files. No new files, no new abstractions.

**Tech Stack:** TypeScript, Bun (test runner), Biome (lint/format), Obsidian Plugin API.

**Spec:** `docs/superpowers/specs/2026-03-24-reduce-simplify-remove-design.md`

---

## Chunk 1: Test Deletions

Tests are deleted first so we can run the surviving suite as a safety net throughout the plugin changes.

### Task 1: Delete 5 test suites that test language built-ins

**Files:**

- Modify: `src/main.test.ts:30-146`

- [ ] **Step 1: Delete the 5 test suites**

Delete these `describe` blocks entirely:

- `"alphabetical sort"` (lines 30-48)
- `"alphabetical sort with checkboxes"` (lines 50-87)
- `"sort by length"` (lines 89-107)
- `"reverse"` (lines 109-121)
- `"fisher-yates shuffle"` (lines 123-146)

After deletion, the file should go from `describe("heading sort"` directly after the `compare` constant.

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: All remaining tests pass (heading sort, link replacement, checkbox regex, frontmatter boundary).

- [ ] **Step 3: Commit**

```bash
git add src/main.test.ts
git commit -m "test: delete suites that test language built-ins"
```

### Task 2: Trim checkbox regex tests from 8 to 3

**Files:**

- Modify: `src/main.test.ts` — the `"checkbox regex"` describe block

- [ ] **Step 1: Delete 5 redundant tests**

Keep only these 3 tests inside the `"checkbox regex"` describe:

- `"matches checked checkbox"` — tests `- [x] task`
- `"does not match unchecked checkbox"` — tests `- [ ] task`
- `"matches cancelled checkbox [-]"` — tests `- [-] cancelled task`

Delete:

- `"matches uppercase checked checkbox"` — `[X]`
- `"matches question checkbox [?]"` — `[?]`
- `"matches partial checkbox [/]"` — `[/]`
- `"matches indented checkbox"` — indented
- `"does not match plain text"` — plain text

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: All remaining tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/main.test.ts
git commit -m "test: trim checkbox regex to 3 essential cases"
```

### Task 3: Remove `checked` from test infrastructure and update heading comparator

**Files:**

- Modify: `src/main.test.ts` — `Line` interface, `makeLine` function, heading sort comparator

- [ ] **Step 1: Remove `checked` from the test's `Line` interface**

Change:

```ts
interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
  checked: boolean;
}
```

To:

```ts
interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
}
```

- [ ] **Step 2: Remove `checked` from `makeLine`**

Change:

```ts
function makeLine(source: string, overrides: Partial<Line> = {}): Line {
  return {
    source,
    formatted: source,
    headingLevel: undefined,
    lineNumber: 0,
    checked: /^(\s*)- \[[^ ]\]/i.test(source),
    ...overrides,
  };
}
```

To:

```ts
function makeLine(source: string, overrides: Partial<Line> = {}): Line {
  return {
    source,
    formatted: source,
    headingLevel: undefined,
    lineNumber: 0,
    ...overrides,
  };
}
```

- [ ] **Step 3: Simplify heading sort test comparator to pure alphabetical**

In the `"heading sort"` describe block, find the `getSortedHeadings` function's comparator. Change:

```ts
headings: headings.sort((a, b) => {
  const res = (a.title.headingLevel ?? 0) - (b.title.headingLevel ?? 0);
  if (res === 0) {
    return compare(a.title.formatted.trim(), b.title.formatted.trim());
  }
  return res;
}),
```

To:

```ts
headings: headings.sort((a, b) =>
  compare(a.title.formatted.trim(), b.title.formatted.trim()),
),
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main.test.ts
git commit -m "test: remove checked field and simplify heading comparator"
```

## Chunk 2: Plugin Deletions

With the test suite trimmed and green, now delete features from the plugin.

### Task 4: Delete 5 commands and their supporting code from `onload()`

**Files:**

- Modify: `src/main.ts:49-115`

- [ ] **Step 1: Delete the 5 command registrations from `onload()`**

Delete the `this.addCommand({...})` blocks for:

- `sort-alphabetically-with-checkboxes` (lines 49-53)
- `sort-list-alphabetically-with-checkboxes` (lines 54-58)
- `sort-list-alphabetically` (lines 64-68)
- `sort-checkboxes` (lines 69-78)
- `sort-list-recursively-with-checkboxes` (lines 111-115)

- [ ] **Step 2: Delete the `alphabetical` and `alphabeticalWithCheckboxes` closures**

Delete lines 100-105:

```ts
const alphabetical = (a: ListPart, b: ListPart) =>
  this.compare(a.title.formatted.trim(), b.title.formatted.trim());
const alphabeticalWithCheckboxes = (a: ListPart, b: ListPart) => {
  if (a.title.checked !== b.title.checked) return a.title.checked ? 1 : -1;
  return this.compare(a.title.formatted.trim(), b.title.formatted.trim());
};
```

- [ ] **Step 3: Update `sort-list-recursively` to use an inline comparator**

The command currently references the deleted `alphabetical` closure. Change:

```ts
callback: () => this.sortListRecursively(alphabetical),
```

To:

```ts
callback: () =>
  this.sortListRecursively((a, b) =>
    this.compare(a.title.formatted.trim(), b.title.formatted.trim()),
  ),
```

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "refactor: remove 5 commands (checkbox and flat-list variants)"
```

### Task 5: Remove `checked` field from plugin

**Files:**

- Modify: `src/main.ts` — `Line` interface, `getLines`, `sortHeadings`

- [ ] **Step 1: Remove `checked` from the `Line` interface**

Change:

```ts
interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
  checked: boolean;
}
```

To:

```ts
interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
}
```

- [ ] **Step 2: Remove `checked` assignment from `getLines`**

In the `getLines` method, remove the `checked` line from the `Line` literal:

```ts
checked: CHECKBOX_REGEX.test(line),
```

- [ ] **Step 3: Remove `checked: false` from the dummy Line in `sortHeadings`**

In `sortHeadings`, change:

```ts
const res = this.getSortedHeadings(lines, 0, {
  headingLevel: 0,
  formatted: "",
  source: "",
  lineNumber: -1,
  checked: false,
});
```

To:

```ts
const res = this.getSortedHeadings(lines, 0, {
  headingLevel: 0,
  formatted: "",
  source: "",
  lineNumber: -1,
});
```

- [ ] **Step 4: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No type errors, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "refactor: remove checked field from Line"
```

### Task 6: Simplify `sortAlphabetically`

**Files:**

- Modify: `src/main.ts` — `sortAlphabetically` method and its call site in `onload()`

- [ ] **Step 1: Remove parameters from `sortAlphabetically`**

Change:

```ts
  private sortAlphabetically(fromCurrentList = false, ignoreCheckboxes = true) {
    const ctx = this.getEditorContext(fromCurrentList);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const lines = this.getLines(ctx);
    if (lines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }

    if (ignoreCheckboxes) {
      lines.sort((a, b) =>
        this.compare(a.formatted.trim(), b.formatted.trim()),
      );
    } else {
      lines.sort((a, b) => {
        if (a.checked !== b.checked) return a.checked ? 1 : -1;
        return this.compare(a.formatted.trim(), b.formatted.trim());
      });
    }

    this.setLines(ctx, lines);
  }
```

To:

```ts
  private sortAlphabetically() {
    const ctx = this.getEditorContext(false);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const lines = this.getLines(ctx);
    if (lines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    lines.sort((a, b) =>
      this.compare(a.formatted.trim(), b.formatted.trim()),
    );
    this.setLines(ctx, lines);
  }
```

- [ ] **Step 2: Simplify the call site in `onload()`**

Change:

```ts
callback: () => this.sortAlphabetically(false, true),
```

To:

```ts
callback: () => this.sortAlphabetically(),
```

- [ ] **Step 3: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No type errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "refactor: simplify sortAlphabetically to no-arg method"
```

## Chunk 3: Inlining and Final Simplification

### Task 7: Inline `headingsToString` into `sortHeadings` and simplify comparator

**Files:**

- Modify: `src/main.ts` — `sortHeadings`, `headingsToString`, `getSortedHeadings`

- [ ] **Step 1: Inline `headingsToString` into `sortHeadings`**

In `sortHeadings`, replace:

```ts
this.setLines(ctx, this.headingsToString(res).slice(1));
```

With the function body inlined as a local function:

```ts
const flatten = (h: HeadingPart): Line[] => {
  const list = [h.title, ...h.lines];
  for (const sub of h.headings) {
    list.push(...flatten(sub));
  }
  return list;
};
this.setLines(ctx, flatten(res).slice(1));
```

Then delete the `headingsToString` method entirely.

- [ ] **Step 2: Simplify heading sort comparator to pure alphabetical**

In `getSortedHeadings`, change:

```ts
headings: headings.sort((a, b) => {
  const res = (a.title.headingLevel ?? 0) - (b.title.headingLevel ?? 0);
  if (res === 0) {
    return this.compare(
      a.title.formatted.trim(),
      b.title.formatted.trim(),
    );
  }
  return res;
}),
```

To:

```ts
headings: headings.sort((a, b) =>
  this.compare(a.title.formatted.trim(), b.title.formatted.trim()),
),
```

- [ ] **Step 3: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No type errors, all tests pass (heading sort tests validate the algorithm).

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "refactor: inline headingsToString and simplify heading comparator"
```

### Task 8: Inline `listPartToList` into `sortListRecursively`

**Files:**

- Modify: `src/main.ts` — `sortListRecursively`, `listPartToList`

- [ ] **Step 1: Inline `listPartToList` into `sortListRecursively`**

In `sortListRecursively`, replace:

```ts
const res = children.reduce<Line[]>(
  (acc, cur) => acc.concat(this.listPartToList(cur)),
  [],
);
```

With the function body inlined as a local function:

```ts
const flatten = (part: ListPart): Line[] =>
  part.children.reduce<Line[]>(
    (acc, cur) => acc.concat(flatten(cur)),
    [part.title],
  );
const res = children.reduce<Line[]>((acc, cur) => acc.concat(flatten(cur)), []);
```

Then delete the `listPartToList` method entirely.

- [ ] **Step 2: Run typecheck and tests**

Run: `bun run typecheck && bun test`
Expected: No type errors, all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "refactor: inline listPartToList into sortListRecursively"
```

### Task 9: Final validation

**Files:**

- Verify: `src/main.ts`, `src/main.test.ts`

- [ ] **Step 1: Run full validation**

Run: `bun run validate`
Expected: All checks pass (typecheck, biome, build, artifact verification).

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: All tests pass.

- [ ] **Step 3: Verify line counts match spec estimates**

Run: `wc -l src/main.ts src/main.test.ts`
Expected: Plugin ~280 lines, tests ~250 lines (approximate).

- [ ] **Step 4: Verify command count**

Run: `grep -c 'this.addCommand' src/main.ts`
Expected: `6`

- [ ] **Step 5: Run lint and format**

Run: `bun run lint:fix`
Expected: Clean or auto-fixed.

- [ ] **Step 6: Commit any format fixes**

```bash
git add -A
git commit -m "style: apply biome formatting after refactor"
```

Skip this step if lint:fix made no changes.
