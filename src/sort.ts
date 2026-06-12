// Pure sorting algorithms — no runtime Obsidian dependency (ListItemCache
// is a type-only import). main.ts orchestrates editor state around these;
// tests import them directly.
import type { ListItemCache } from "obsidian";

export interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
}

export interface HeadingPart {
  to: number;
  title: Line;
  lines: Line[];
  headings: HeadingPart[];
}

export interface ListPart {
  children: ListPart[];
  title: Line;
  lastLine: number;
}

export interface LinkRef {
  position: {
    start: { line: number; col: number };
    end: { line: number; col: number };
  };
  displayText?: string;
}

export type Comparator = (x: string, y: string) => number;

// Matches any non-empty checkbox: [x], [X], [-], [?], [/], [!], etc.
// Intentionally broad to support Obsidian's alternative checkbox statuses.
export const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/i;

/** First sortable line: the line after the frontmatter block, or 0. */
export function getFrontStart(
  frontmatter: { position?: { end?: { line?: number } } } | undefined,
): number {
  return (frontmatter?.position?.end?.line ?? -1) + 1;
}

/**
 * Replace each link on a line with its display text. Splices right to
 * left so earlier replacements don't shift later link positions.
 */
export function replaceLinksOnLine(line: string, links: LinkRef[]): string {
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

function getSortedHeadings(
  lines: Line[],
  from: number,
  heading: Line,
  compare: Comparator,
): HeadingPart {
  const headings: HeadingPart[] = [];
  const contentLines: Line[] = [];
  let currentIndex = from;

  while (currentIndex < lines.length) {
    const current = lines[currentIndex];
    if ((current.headingLevel ?? 0) <= (heading.headingLevel ?? 0)) break;

    if (current.headingLevel) {
      headings.push(
        getSortedHeadings(lines, currentIndex + 1, current, compare),
      );
      currentIndex = headings.at(-1)?.to ?? currentIndex;
    } else {
      contentLines.push(current);
    }
    currentIndex++;
  }

  return {
    lines: contentLines,
    to:
      headings.length > 0
        ? (headings.at(-1)?.to ?? currentIndex - 1)
        : currentIndex - 1,
    headings: headings.sort((a, b) =>
      compare(a.title.formatted.trim(), b.title.formatted.trim()),
    ),
    title: heading,
  };
}

/**
 * Sort headings recursively: siblings sort alphabetically at each level,
 * content lines stay under their heading.
 */
export function sortHeadings(lines: Line[], compare: Comparator): Line[] {
  const root: Line = {
    headingLevel: 0,
    formatted: "",
    source: "",
    lineNumber: -1,
  };
  const res = getSortedHeadings(lines, 0, root, compare);
  const flatten = (h: HeadingPart): Line[] => {
    const list = [h.title, ...h.lines];
    for (const sub of h.headings) {
      list.push(...flatten(sub));
    }
    return list;
  };
  return flatten(res).slice(1);
}

function getSortedListParts(
  lines: Line[],
  cacheMap: Map<number, ListItemCache>,
  index: number,
  compareFn: (a: ListPart, b: ListPart) => number,
): ListPart {
  const children: ListPart[] = [];
  const startListCache = cacheMap.get(index);
  if (!startListCache)
    return { children: [], title: lines[index], lastLine: index };
  const title = lines[index];

  // Obsidian's ListItemCache.parent is the line number of the parent item,
  // or a negative value for top-level items (no parent).
  // This loop collects children: the next line is a child if:
  //   1. Its parent pointer is deeper than ours (nested under us), OR
  //   2. We're top-level (parent < 0) and the next item has any parent (is nested)
  while (
    startListCache.parent < (cacheMap.get(index + 1)?.parent ?? -1) ||
    (startListCache.parent < 0 && (cacheMap.get(index + 1)?.parent ?? -1) >= 0)
  ) {
    index++;
    const newChild = getSortedListParts(lines, cacheMap, index, compareFn);
    index = newChild.lastLine ?? index;
    children.push(newChild);
  }

  const lastLine = children.at(-1)?.lastLine ?? index;
  children.sort(compareFn);
  return { children, title, lastLine };
}

/**
 * Sort a list (and every nested sublist) recursively. `inputLines` is the
 * list's line range; entries are padded to their absolute line numbers so
 * the cacheMap's parent pointers (absolute line numbers) line up.
 */
export function sortListLines(
  inputLines: Line[],
  cacheMap: Map<number, ListItemCache>,
  compareFn: (a: ListPart, b: ListPart) => number,
): Line[] {
  const firstLineNumber = inputLines[0]?.lineNumber;
  if (firstLineNumber == null) return inputLines;
  const lines = [...new Array(firstLineNumber).fill(undefined), ...inputLines];
  let index = firstLineNumber;

  const children: ListPart[] = [];
  while (index < lines.length) {
    const newChild = getSortedListParts(lines, cacheMap, index, compareFn);
    children.push(newChild);
    index = newChild.lastLine + 1;
  }
  children.sort(compareFn);

  const flatten = (part: ListPart): Line[] =>
    part.children.reduce<Line[]>(
      (acc, cur) => acc.concat(flatten(cur)),
      [part.title],
    );
  return children.reduce<Line[]>((acc, cur) => acc.concat(flatten(cur)), []);
}
