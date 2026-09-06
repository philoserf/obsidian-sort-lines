import { describe, expect, test } from "bun:test";
import type { ListItemCache } from "obsidian";
import {
  CHECKBOX_REGEX,
  collectLines,
  getFrontStart,
  type HeadingRef,
  type Line,
  type LinkRef,
  replaceLinksOnLine,
  resolveListRange,
  resolveSelectionRange,
  type SectionRef,
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

describe("collectLines", () => {
  const noRefs = { links: [], headings: [] };

  // A note with frontmatter and exactly one content line is the only shape
  // where start === end, which used to make getLines return the whole
  // document — frontmatter included — and setLines overwrite the file.
  test("frontmatter is never swept in when the range is a single line", () => {
    const text = "---\ntitle: x\n---\n- b";

    const output = collectLines(text, { ...noRefs, start: 3, end: 3 });

    expect(output.map((l) => l.source)).toEqual(["- b"]);
  });

  test("single-line range keeps its absolute lineNumber", () => {
    const text = "---\ntitle: x\n---\n- b";

    const output = collectLines(text, { ...noRefs, start: 3, end: 3 });

    expect(output[0].lineNumber).toBe(3);
  });

  test("frontmatter with only a trailing newline is not swept in", () => {
    const text = "---\na: 1\n---\n";

    const output = collectLines(text, { ...noRefs, start: 3, end: 3 });

    expect(output.map((l) => l.source)).toEqual([""]);
  });

  test("start past end yields no lines", () => {
    const text = "---\na: 1\n---";

    expect(collectLines(text, { ...noRefs, start: 3, end: 2 })).toEqual([]);
  });

  test("end is inclusive", () => {
    const output = collectLines("a\nb\nc\nd", { ...noRefs, start: 1, end: 2 });

    expect(output.map((l) => l.source)).toEqual(["b", "c"]);
  });

  test("heading levels are assigned by absolute line", () => {
    const headings: HeadingRef[] = [
      { level: 2, position: { start: { line: 1 } } },
    ];

    const output = collectLines("intro\n## Heading\nbody", {
      links: [],
      headings,
      start: 0,
      end: 2,
    });

    expect(output.map((l) => l.headingLevel)).toEqual([
      undefined,
      2,
      undefined,
    ]);
  });

  // Obsidian's metadata cache can lag the editor during rapid edits, so a
  // heading position can point past the end of the current text.
  test("a stale heading position past the end is skipped, not thrown on", () => {
    const headings: HeadingRef[] = [
      { level: 2, position: { start: { line: 1 } } },
      { level: 3, position: { start: { line: 99 } } },
    ];

    const output = collectLines("intro\n## Heading", {
      links: [],
      headings,
      start: 0,
      end: 1,
    });

    expect(output.map((l) => l.headingLevel)).toEqual([undefined, 2]);
  });

  test("links are matched by absolute line, then the range is applied", () => {
    // "[[a]]" on frontmatter line 1 and on in-range line 4.
    const links: LinkRef[] = [
      {
        position: { start: { line: 1, col: 0 }, end: { line: 1, col: 5 } },
        displayText: "front",
      },
      {
        position: { start: { line: 4, col: 2 }, end: { line: 4, col: 7 } },
        displayText: "body",
      },
    ];

    const output = collectLines("---\n[[a]]\n---\nplain\n- [[a]]", {
      links,
      headings: [],
      start: 3,
      end: 4,
    });

    expect(output.map((l) => l.formatted)).toEqual(["plain", "- body"]);
  });

  // The marker is replaced by the captured indent, so the separating space
  // survives — every caller compares on `formatted.trim()`.
  test("checkbox markers are stripped from formatted, not source", () => {
    const output = collectLines("  - [x] done", {
      ...noRefs,
      start: 0,
      end: 0,
    });

    expect(output[0].formatted).toBe("   done");
    expect(output[0].source).toBe("  - [x] done");
  });
});

describe("resolveSelectionRange", () => {
  // A document with no frontmatter and no trailing newline.
  const plain = { frontStart: 0, lastLine: 4, lastLineEmpty: false };

  test("a multi-line selection is the range", () => {
    expect(resolveSelectionRange({ ...plain, from: 1, to: 3 })).toEqual({
      start: 1,
      end: 3,
    });
  });

  test("no selection sorts the whole document below frontmatter", () => {
    expect(
      resolveSelectionRange({
        from: 3,
        to: 3,
        frontStart: 3,
        lastLine: 7,
        lastLineEmpty: false,
      }),
    ).toEqual({ start: 3, end: 7 });
  });

  // "" collates before everything, so an empty final line would sort to the
  // top and inject a blank under the frontmatter.
  test("a trailing empty line is dropped from a whole-document range", () => {
    expect(
      resolveSelectionRange({
        from: 3,
        to: 3,
        frontStart: 3,
        lastLine: 5,
        lastLineEmpty: true,
      }),
    ).toEqual({ start: 3, end: 4 });
  });

  test("a trailing empty line is dropped from a selection too", () => {
    // Select-all reaches the empty final line just as the no-selection path does.
    expect(
      resolveSelectionRange({
        from: 0,
        to: 5,
        frontStart: 0,
        lastLine: 5,
        lastLineEmpty: true,
      }),
    ).toEqual({ start: 0, end: 4 });
  });

  test("an empty line is kept when it is the only line in the range", () => {
    // Frontmatter plus a trailing newline: dropping it would invert the range.
    expect(
      resolveSelectionRange({
        from: 3,
        to: 3,
        frontStart: 3,
        lastLine: 3,
        lastLineEmpty: true,
      }),
    ).toEqual({ start: 3, end: 3 });
  });

  test("a frontmatter-only document yields an empty range", () => {
    const range = resolveSelectionRange({
      from: 1,
      to: 1,
      frontStart: 3,
      lastLine: 2,
      lastLineEmpty: false,
    });

    expect(range.start).toBeGreaterThan(range.end);
  });
});

describe("resolveListRange", () => {
  const bounds = { frontStart: 0, lastLine: 5, lastLineEmpty: false };
  const list = (start: number, end: number): SectionRef => ({
    type: "list",
    position: { start: { line: start }, end: { line: end } },
  });

  test("the enclosing list section is the range", () => {
    expect(
      resolveListRange({ ...bounds, from: 2, to: 2 }, [list(1, 3)]),
    ).toEqual({ start: 1, end: 3 });
  });

  // A one-item list is a section whose start and end are the same line.
  // Treating that as "no range" made the command sort the whole document.
  test("a one-item list is a range, not an absent one", () => {
    expect(
      resolveListRange({ ...bounds, from: 4, to: 4 }, [list(4, 4)]),
    ).toEqual({ start: 4, end: 4 });
  });

  test("non-list sections are ignored", () => {
    const paragraph: SectionRef = {
      type: "paragraph",
      position: { start: { line: 4 }, end: { line: 4 } },
    };

    expect(
      resolveListRange({ ...bounds, from: 4, to: 4 }, [paragraph]),
    ).toEqual({ start: 0, end: 5 });
  });

  test("falls back to selection behavior with no enclosing list", () => {
    expect(resolveListRange({ ...bounds, from: 4, to: 4 }, [])).toEqual({
      start: 0,
      end: 5,
    });
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
