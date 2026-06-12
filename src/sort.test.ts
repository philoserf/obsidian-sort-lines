import { describe, expect, test } from "bun:test";
import type { ListItemCache } from "obsidian";
import {
  CHECKBOX_REGEX,
  getFrontStart,
  type Line,
  type LinkRef,
  replaceLinksOnLine,
  sortHeadings,
  sortListLines,
} from "./sort";

function makeLine(source: string, overrides: Partial<Line> = {}): Line {
  return {
    source,
    formatted: source,
    headingLevel: undefined,
    lineNumber: 0,
    ...overrides,
  };
}

const collator = new Intl.Collator("en", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
});
const compare = collator.compare;

describe("sortHeadings", () => {
  test("sorts sibling headings alphabetically", () => {
    const lines: Line[] = [
      makeLine("## Zebra", { headingLevel: 2, lineNumber: 0 }),
      makeLine("## Apple", { headingLevel: 2, lineNumber: 1 }),
    ];

    const output = sortHeadings(lines, compare);

    expect(output.map((l) => l.source)).toEqual(["## Apple", "## Zebra"]);
  });

  test("nested headings sort within parent", () => {
    const lines: Line[] = [
      makeLine("## Parent", { headingLevel: 2, lineNumber: 0 }),
      makeLine("### Zebra", { headingLevel: 3, lineNumber: 1 }),
      makeLine("### Apple", { headingLevel: 3, lineNumber: 2 }),
    ];

    const output = sortHeadings(lines, compare);

    expect(output.map((l) => l.source)).toEqual([
      "## Parent",
      "### Apple",
      "### Zebra",
    ]);
  });

  test("content lines stay under their heading", () => {
    const lines: Line[] = [
      makeLine("## Zebra", { headingLevel: 2, lineNumber: 0 }),
      makeLine("zebra body", { lineNumber: 1 }),
      makeLine("## Apple", { headingLevel: 2, lineNumber: 2 }),
      makeLine("apple body", { lineNumber: 3 }),
    ];

    const output = sortHeadings(lines, compare);

    expect(output.map((l) => l.source)).toEqual([
      "## Apple",
      "apple body",
      "## Zebra",
      "zebra body",
    ]);
  });
});

describe("replaceLinksOnLine", () => {
  test("single link replaced by display text", () => {
    // "some [[foo]] text" — link at cols 5..12
    const line = "some [[foo]] text";
    const links: LinkRef[] = [
      {
        position: { start: { line: 0, col: 5 }, end: { line: 0, col: 12 } },
        displayText: "foo",
      },
    ];
    expect(replaceLinksOnLine(line, links)).toBe("some foo text");
  });

  test("duplicate links replaced at correct positions", () => {
    // "[[foo]] bar [[foo]]" — two identical link texts
    const line = "[[foo]] bar [[foo]]";
    const links: LinkRef[] = [
      {
        position: { start: { line: 0, col: 0 }, end: { line: 0, col: 7 } },
        displayText: "foo",
      },
      {
        position: { start: { line: 0, col: 12 }, end: { line: 0, col: 19 } },
        displayText: "foo",
      },
    ];
    expect(replaceLinksOnLine(line, links)).toBe("foo bar foo");
  });

  test("multiple different links replaced positionally", () => {
    // "[[alpha]] and [[beta]]"
    const line = "[[alpha]] and [[beta]]";
    const links: LinkRef[] = [
      {
        position: { start: { line: 0, col: 0 }, end: { line: 0, col: 9 } },
        displayText: "alpha",
      },
      {
        position: { start: { line: 0, col: 14 }, end: { line: 0, col: 22 } },
        displayText: "beta",
      },
    ];
    expect(replaceLinksOnLine(line, links)).toBe("alpha and beta");
  });

  test("link with no display text replaced with empty string", () => {
    const line = "before [[link]] after";
    const links: LinkRef[] = [
      {
        position: { start: { line: 0, col: 7 }, end: { line: 0, col: 15 } },
        displayText: undefined,
      },
    ];
    expect(replaceLinksOnLine(line, links)).toBe("before  after");
  });

  test("links provided in forward order still splice correctly", () => {
    // Ensure right-to-left sorting works regardless of input order
    const line = "[[a]] [[b]] [[c]]";
    const links: LinkRef[] = [
      {
        position: { start: { line: 0, col: 0 }, end: { line: 0, col: 5 } },
        displayText: "a",
      },
      {
        position: { start: { line: 0, col: 6 }, end: { line: 0, col: 11 } },
        displayText: "b",
      },
      {
        position: { start: { line: 0, col: 12 }, end: { line: 0, col: 17 } },
        displayText: "c",
      },
    ];
    expect(replaceLinksOnLine(line, links)).toBe("a b c");
  });
});

describe("CHECKBOX_REGEX", () => {
  test("matches checked checkbox", () => {
    expect(CHECKBOX_REGEX.test("- [x] task")).toBe(true);
  });

  test("does not match unchecked checkbox", () => {
    expect(CHECKBOX_REGEX.test("- [ ] task")).toBe(false);
  });

  test("matches cancelled checkbox [-]", () => {
    expect(CHECKBOX_REGEX.test("- [-] cancelled task")).toBe(true);
  });
});

describe("getFrontStart", () => {
  test("no frontmatter returns 0", () => {
    expect(getFrontStart(undefined)).toBe(0);
  });

  test("frontmatter ending at line 3 returns 4", () => {
    expect(getFrontStart({ position: { end: { line: 3 } } })).toBe(4);
  });

  test("frontmatter ending at line 0 returns 1", () => {
    expect(getFrontStart({ position: { end: { line: 0 } } })).toBe(1);
  });

  test("missing position returns 0", () => {
    expect(getFrontStart({})).toBe(0);
  });

  test("missing end returns 0", () => {
    expect(getFrontStart({ position: {} })).toBe(0);
  });
});

describe("sortListLines", () => {
  // Obsidian's ListItemCache.parent is the parent's line number, or a
  // negative value for top-level items.
  function cacheItem(line: number, parent: number): [number, ListItemCache] {
    return [
      line,
      {
        parent,
        position: {
          start: { line, col: 0, offset: 0 },
          end: { line, col: 0, offset: 0 },
        },
      } as ListItemCache,
    ];
  }

  const compareParts = (a: { title: Line }, b: { title: Line }): number =>
    compare(a.title.formatted.trim(), b.title.formatted.trim());

  test("sorts a flat list", () => {
    const lines = [
      makeLine("- b", { lineNumber: 0 }),
      makeLine("- a", { lineNumber: 1 }),
    ];
    const cacheMap = new Map([cacheItem(0, -1), cacheItem(1, -1)]);

    const output = sortListLines(lines, cacheMap, compareParts);

    expect(output.map((l) => l.source)).toEqual(["- a", "- b"]);
  });

  test("children move with their parent", () => {
    const lines = [
      makeLine("- b", { lineNumber: 0 }),
      makeLine("  - b2", { lineNumber: 1 }),
      makeLine("- a", { lineNumber: 2 }),
    ];
    const cacheMap = new Map([
      cacheItem(0, -1),
      cacheItem(1, 0),
      cacheItem(2, -1),
    ]);

    const output = sortListLines(lines, cacheMap, compareParts);

    expect(output.map((l) => l.source)).toEqual(["- a", "- b", "  - b2"]);
  });

  test("nested children sort within their parent", () => {
    const lines = [
      makeLine("- parent", { lineNumber: 0 }),
      makeLine("  - z", { lineNumber: 1 }),
      makeLine("  - a", { lineNumber: 2 }),
    ];
    const cacheMap = new Map([
      cacheItem(0, -1),
      cacheItem(1, 0),
      cacheItem(2, 0),
    ]);

    const output = sortListLines(lines, cacheMap, compareParts);

    expect(output.map((l) => l.source)).toEqual(["- parent", "  - a", "  - z"]);
  });

  test("handles a list that does not start at line 0", () => {
    const lines = [
      makeLine("- z", { lineNumber: 2 }),
      makeLine("- a", { lineNumber: 3 }),
    ];
    const cacheMap = new Map([cacheItem(2, -3), cacheItem(3, -3)]);

    const output = sortListLines(lines, cacheMap, compareParts);

    expect(output.map((l) => l.source)).toEqual(["- a", "- z"]);
  });

  test("returns input for an empty list", () => {
    expect(sortListLines([], new Map(), compareParts)).toEqual([]);
  });
});
