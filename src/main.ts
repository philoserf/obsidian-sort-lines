import type { CachedMetadata, ListItemCache } from "obsidian";
import { MarkdownView, Plugin } from "obsidian";

interface Line {
  source: string;
  formatted: string;
  headingLevel: number | undefined;
  lineNumber: number;
  checked: boolean;
}

interface HeadingPart {
  to: number;
  title: Line;
  lines: Line[];
  headings: HeadingPart[];
}

interface ListPart {
  children: ListPart[];
  title: Line;
  lastLine: number;
}

interface EditorContext {
  view: MarkdownView;
  cache: CachedMetadata;
  start: number;
  end: number;
  endLineLength: number;
}

// Matches any non-empty checkbox: [x], [X], [-], [?], [/], [!], etc.
// Intentionally broad to support Obsidian's alternative checkbox statuses.
const CHECKBOX_REGEX = /^(\s*)- \[[^ ]\]/i;

export default class SortLinesPlugin extends Plugin {
  private compare!: (x: string, y: string) => number;

  override onload() {
    const { compare } = new Intl.Collator(navigator.language, {
      usage: "sort",
      sensitivity: "base",
      numeric: true,
      ignorePunctuation: true,
    });
    this.compare = compare;

    this.addCommand({
      id: "sort-alphabetically-with-checkboxes",
      name: "Sort alphabetically with checkboxes",
      callback: () => this.sortAlphabetically(false, false),
    });
    this.addCommand({
      id: "sort-list-alphabetically-with-checkboxes",
      name: "Sort current list alphabetically with checkboxes",
      callback: () => this.sortAlphabetically(true, false),
    });
    this.addCommand({
      id: "sort-alphabetically",
      name: "Sort alphabetically",
      callback: () => this.sortAlphabetically(false, true),
    });
    this.addCommand({
      id: "sort-list-alphabetically",
      name: "Sort current list alphabetically",
      callback: () => this.sortAlphabetically(true, true),
    });
    this.addCommand({
      id: "sort-checkboxes",
      name: "Sort current list by checkboxes",
      callback: () =>
        this.sortListRecursively((a, b) => {
          if (a.title.checked !== b.title.checked)
            return a.title.checked ? 1 : -1;
          return 0;
        }),
    });
    this.addCommand({
      id: "sort-length",
      name: "Sort by length of line",
      callback: () => this.sortLengthOfLine(),
    });
    this.addCommand({
      id: "sort-headings",
      name: "Sort headings",
      callback: () => this.sortHeadings(),
    });
    this.addCommand({
      id: "permute-reverse",
      name: "Reverse lines",
      callback: () => this.permuteReverse(),
    });
    this.addCommand({
      id: "permute-shuffle",
      name: "Shuffle lines",
      callback: () => this.permuteShuffle(),
    });

    const alphabetical = (a: ListPart, b: ListPart) =>
      this.compare(a.title.formatted.trim(), b.title.formatted.trim());
    const alphabeticalWithCheckboxes = (a: ListPart, b: ListPart) => {
      if (a.title.checked !== b.title.checked) return a.title.checked ? 1 : -1;
      return this.compare(a.title.formatted.trim(), b.title.formatted.trim());
    };
    this.addCommand({
      id: "sort-list-recursively",
      name: "Sort current list recursively",
      callback: () => this.sortListRecursively(alphabetical),
    });
    this.addCommand({
      id: "sort-list-recursively-with-checkboxes",
      name: "Sort current list recursively with checkboxes",
      callback: () => this.sortListRecursively(alphabeticalWithCheckboxes),
    });
  }

  private sortAlphabetically(fromCurrentList = false, ignoreCheckboxes = true) {
    const ctx = this.getEditorContext(fromCurrentList);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;

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

  private sortListRecursively(compareFn: (a: ListPart, b: ListPart) => number) {
    const ctx = this.getEditorContext(true);
    if (!ctx) return;
    const inputLines = this.getLines(ctx);
    if (
      inputLines.length === 0 ||
      inputLines.find((line) => line.source.trim() === "")
    )
      return;

    const firstLineNumber = inputLines.first()?.lineNumber;
    if (firstLineNumber == null) return;
    const lines = [
      ...new Array(firstLineNumber).fill(undefined),
      ...inputLines,
    ];
    let index = firstLineNumber;

    if (!ctx.cache.listItems) return;
    const cacheMap = new Map(
      ctx.cache.listItems.map((item) => [item.position.start.line, item]),
    );

    const children: ListPart[] = [];
    while (index < lines.length) {
      const newChild = this.getSortedListParts(
        lines,
        cacheMap,
        index,
        compareFn,
      );
      children.push(newChild);
      index = newChild.lastLine + 1;
    }
    children.sort(compareFn);

    const res = children.reduce<Line[]>(
      (acc, cur) => acc.concat(this.listPartToList(cur)),
      [],
    );
    this.setLines(ctx, res);
  }

  private getSortedListParts(
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

    while (
      startListCache.parent < (cacheMap.get(index + 1)?.parent ?? -1) ||
      (startListCache.parent < 0 &&
        (cacheMap.get(index + 1)?.parent ?? -1) >= 0)
    ) {
      index++;
      const newChild = this.getSortedListParts(
        lines,
        cacheMap,
        index,
        compareFn,
      );
      index = newChild.lastLine ?? index;
      children.push(newChild);
    }

    const lastLine = children.last()?.lastLine ?? index;
    children.sort(compareFn);
    return { children, title, lastLine };
  }

  private listPartToList(list: ListPart): Line[] {
    return list.children.reduce<Line[]>(
      (acc, cur) => acc.concat(this.listPartToList(cur)),
      [list.title],
    );
  }

  private sortHeadings() {
    const ctx = this.getEditorContext(false);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;
    const res = this.getSortedHeadings(lines, 0, {
      headingLevel: 0,
      formatted: "",
      source: "",
      lineNumber: -1,
      checked: false,
    });
    this.setLines(ctx, this.headingsToString(res).slice(1));
  }

  private headingsToString(heading: HeadingPart): Line[] {
    const list = [heading.title, ...heading.lines];
    for (const h of heading.headings) {
      list.push(...this.headingsToString(h));
    }
    return list;
  }

  private getSortedHeadings(
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
        headings.push(this.getSortedHeadings(lines, currentIndex + 1, current));
        currentIndex = headings.last()?.to ?? currentIndex;
      } else {
        contentLines.push(current);
      }
      currentIndex++;
    }

    return {
      lines: contentLines,
      to:
        headings.length > 0
          ? (headings.last()?.to ?? currentIndex - 1)
          : currentIndex - 1,
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
      title: heading,
    };
  }

  private sortLengthOfLine() {
    const ctx = this.getEditorContext(false);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;
    lines.sort((a, b) => a.formatted.length - b.formatted.length);
    this.setLines(ctx, lines);
  }

  private permuteReverse() {
    const ctx = this.getEditorContext(false);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;
    lines.reverse();
    this.setLines(ctx, lines);
  }

  private permuteShuffle() {
    const ctx = this.getEditorContext(false);
    if (!ctx) return;
    const lines = this.getLines(ctx);
    if (lines.length === 0) return;
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [lines[i], lines[j]] = [lines[j], lines[i]];
    }
    this.setLines(ctx, lines);
  }

  private getEditorContext(
    fromCurrentList: boolean,
  ): EditorContext | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;

    const cache = this.app.metadataCache.getFileCache(view.file);
    if (!cache) return;

    const editor = view.editor;
    let cursorStart = editor.getCursor("from").line;
    let cursorEnd = editor.getCursor("to").line;

    if (fromCurrentList) {
      const list = cache.sections?.find(
        (e) =>
          e.type === "list" &&
          e.position.start.line <= cursorStart &&
          e.position.end.line >= cursorEnd,
      );
      if (list) {
        cursorStart = list.position.start.line;
        cursorEnd = list.position.end.line;
      }
    }

    const cursorEndLineLength = editor.getLine(cursorEnd).length;
    let frontStart = (cache.frontmatter?.position?.end?.line ?? -1) + 1;
    if (Number.isNaN(frontStart)) frontStart = 0;

    const frontEnd = editor.lastLine();
    const frontEndLineLength = editor.getLine(frontEnd).length;

    if (cursorStart !== cursorEnd) {
      return {
        view,
        cache,
        start: cursorStart,
        end: cursorEnd,
        endLineLength: cursorEndLineLength,
      };
    }

    return {
      view,
      cache,
      start: frontStart,
      end: frontEnd,
      endLineLength: frontEndLineLength,
    };
  }

  private getLines(ctx: EditorContext): Line[] {
    const lines = ctx.view.editor.getValue().split("\n");
    const links = [...(ctx.cache.links ?? []), ...(ctx.cache.embeds ?? [])];

    const mapped = lines.map((line, index) => {
      const result: Line = {
        source: line,
        formatted: line,
        headingLevel: undefined,
        lineNumber: index,
        checked: CHECKBOX_REGEX.test(line),
      };

      const lineLinks = links
        .filter((link) => link.position.start.line === index)
        .sort((a, b) => b.position.start.col - a.position.start.col);
      for (const link of lineLinks) {
        result.formatted =
          result.formatted.substring(0, link.position.start.col) +
          (link.displayText ?? "") +
          result.formatted.substring(link.position.end.col);
      }

      result.formatted = result.formatted.replace(CHECKBOX_REGEX, "$1");

      return result;
    });

    for (const heading of ctx.cache.headings ?? []) {
      mapped[heading.position.start.line].headingLevel = heading.level;
    }

    if (ctx.start !== ctx.end) {
      return mapped.slice(ctx.start, ctx.end + 1);
    }
    return mapped;
  }

  private setLines(ctx: EditorContext, lines: Line[]) {
    const editor = ctx.view.editor;
    const text = lines.map((e) => e.source).join("\n");

    if (ctx.start !== ctx.end) {
      editor.replaceRange(
        text,
        { line: ctx.start, ch: 0 },
        { line: ctx.end, ch: ctx.endLineLength },
      );
    } else {
      editor.setValue(text);
    }
  }
}
