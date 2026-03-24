import { describe, expect, test } from "bun:test";

interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
  checked: boolean;
}

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

const collator = new Intl.Collator("en", {
  usage: "sort",
  sensitivity: "base",
  numeric: true,
  ignorePunctuation: true,
});
const compare = collator.compare;

describe("heading sort", () => {
  interface HeadingPart {
    to: number;
    title: Line;
    lines: Line[];
    headings: HeadingPart[];
  }

  function getSortedHeadings(
    lines: Line[],
    from: number,
    heading: Line,
  ): HeadingPart {
    const headings: HeadingPart[] = [];
    const contentLines: Line[] = [];
    let currentIndex = from;

    while (currentIndex < lines.length) {
      const current = lines[currentIndex];
      if ((current.headingLevel ?? 0) <= (heading.headingLevel ?? 0)) break;

      if (current.headingLevel) {
        headings.push(getSortedHeadings(lines, currentIndex + 1, current));
        currentIndex = headings[headings.length - 1]?.to ?? currentIndex;
      } else {
        contentLines.push(current);
      }
      currentIndex++;
    }

    return {
      lines: contentLines,
      to:
        headings.length > 0
          ? (headings[headings.length - 1]?.to ?? currentIndex - 1)
          : currentIndex - 1,
      headings: headings.sort((a, b) => {
        const res = (a.title.headingLevel ?? 0) - (b.title.headingLevel ?? 0);
        if (res === 0) {
          return compare(a.title.formatted.trim(), b.title.formatted.trim());
        }
        return res;
      }),
      title: heading,
    };
  }

  function headingsToString(heading: HeadingPart): Line[] {
    const list = [heading.title, ...heading.lines];
    for (const h of heading.headings) {
      list.push(...headingsToString(h));
    }
    return list;
  }

  test("sorts sibling headings alphabetically", () => {
    const lines: Line[] = [
      makeLine("## Zebra", { headingLevel: 2, lineNumber: 0 }),
      makeLine("## Apple", { headingLevel: 2, lineNumber: 1 }),
    ];

    const root = makeLine("", { headingLevel: 0, lineNumber: -1 });
    const result = getSortedHeadings(lines, 0, root);
    const output = headingsToString(result).slice(1);

    expect(output.map((l) => l.source)).toEqual(["## Apple", "## Zebra"]);
  });

  test("nested headings sort within parent", () => {
    const lines: Line[] = [
      makeLine("## Parent", { headingLevel: 2, lineNumber: 0 }),
      makeLine("### Zebra", { headingLevel: 3, lineNumber: 1 }),
      makeLine("### Apple", { headingLevel: 3, lineNumber: 2 }),
    ];

    const root = makeLine("", { headingLevel: 0, lineNumber: -1 });
    const result = getSortedHeadings(lines, 0, root);
    const output = headingsToString(result).slice(1);

    expect(output.map((l) => l.source)).toEqual([
      "## Parent",
      "### Apple",
      "### Zebra",
    ]);
  });
});

describe("link replacement by positional splicing", () => {
  interface LinkRef {
    position: {
      start: { line: number; col: number };
      end: { line: number; col: number };
    };
    displayText: string | undefined;
  }

  function replaceLinks(line: string, links: LinkRef[]): string {
    const sorted = [...links].sort(
      (a, b) => b.position.start.col - a.position.start.col,
    );
    let result = line;
    for (const link of sorted) {
      result =
        result.substring(0, link.position.start.col) +
        (link.displayText ?? "") +
        result.substring(link.position.end.col);
    }
    return result;
  }

  test("single link replaced by display text", () => {
    // "some [[foo]] text" — link at cols 5..14
    const line = "some [[foo]] text";
    const links: LinkRef[] = [
      {
        position: { start: { line: 0, col: 5 }, end: { line: 0, col: 12 } },
        displayText: "foo",
      },
    ];
    expect(replaceLinks(line, links)).toBe("some foo text");
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
    expect(replaceLinks(line, links)).toBe("foo bar foo");
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
    expect(replaceLinks(line, links)).toBe("alpha and beta");
  });

  test("link with no display text replaced with empty string", () => {
    const line = "before [[link]] after";
    const links: LinkRef[] = [
      {
        position: { start: { line: 0, col: 7 }, end: { line: 0, col: 15 } },
        displayText: undefined,
      },
    ];
    expect(replaceLinks(line, links)).toBe("before  after");
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
    expect(replaceLinks(line, links)).toBe("a b c");
  });
});

describe("checkbox regex", () => {
  const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/i;

  test("matches checked checkbox", () => {
    expect(CHECKBOX_REGEX.test("- [x] task")).toBe(true);
  });

  test("matches uppercase checked checkbox", () => {
    expect(CHECKBOX_REGEX.test("- [X] task")).toBe(true);
  });

  test("does not match unchecked checkbox", () => {
    expect(CHECKBOX_REGEX.test("- [ ] task")).toBe(false);
  });

  test("matches indented checkbox", () => {
    expect(CHECKBOX_REGEX.test("  - [x] task")).toBe(true);
  });

  test("does not match plain text", () => {
    expect(CHECKBOX_REGEX.test("plain text")).toBe(false);
  });

  test("matches cancelled checkbox [-]", () => {
    expect(CHECKBOX_REGEX.test("- [-] cancelled task")).toBe(true);
  });

  test("matches question checkbox [?]", () => {
    expect(CHECKBOX_REGEX.test("- [?] uncertain task")).toBe(true);
  });

  test("matches partial checkbox [/]", () => {
    expect(CHECKBOX_REGEX.test("- [/] in progress task")).toBe(true);
  });
});

describe("frontmatter boundary calculation", () => {
  function getFrontStart(
    frontmatter: { position?: { end?: { line?: number } } } | undefined,
  ): number {
    return (frontmatter?.position?.end?.line ?? -1) + 1;
  }

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
