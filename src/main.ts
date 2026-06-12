import type { CachedMetadata } from "obsidian";
import { MarkdownView, Notice, Plugin } from "obsidian";
import {
  CHECKBOX_REGEX,
  getFrontStart,
  type Line,
  type ListPart,
  replaceLinksOnLine,
  sortHeadings,
  sortListLines,
} from "./sort";

interface EditorContext {
  view: MarkdownView;
  cache: CachedMetadata;
  start: number;
  end: number;
  endLineLength: number;
}

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
      id: "sort-alphabetically",
      name: "Sort alphabetically",
      callback: () => this.sortAlphabetically(),
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

    this.addCommand({
      id: "sort-list-recursively",
      name: "Sort current list recursively",
      callback: () =>
        this.sortListRecursively((a, b) =>
          this.compare(a.title.formatted.trim(), b.title.formatted.trim()),
        ),
    });
  }

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
    lines.sort((a, b) => this.compare(a.formatted.trim(), b.formatted.trim()));
    this.setLines(ctx, lines);
  }

  private sortListRecursively(compareFn: (a: ListPart, b: ListPart) => number) {
    const ctx = this.getEditorContext(true);
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const inputLines = this.getLines(ctx);
    if (inputLines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    if (inputLines.find((line) => line.source.trim() === "")) {
      new Notice("Sort Lines: list contains blank lines");
      return;
    }
    if (!ctx.cache.listItems) {
      new Notice("Sort Lines: cursor is not inside a list");
      return;
    }

    const cacheMap = new Map(
      ctx.cache.listItems.map((item) => [item.position.start.line, item]),
    );
    this.setLines(ctx, sortListLines(inputLines, cacheMap, compareFn));
  }

  private sortHeadings() {
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
    this.setLines(ctx, sortHeadings(lines, this.compare));
  }

  private sortLengthOfLine() {
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
    lines.sort((a, b) => a.formatted.length - b.formatted.length);
    this.setLines(ctx, lines);
  }

  private permuteReverse() {
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
    lines.reverse();
    this.setLines(ctx, lines);
  }

  private permuteShuffle() {
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
    const frontStart = getFrontStart(cache.frontmatter);

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
      const lineLinks = links.filter(
        (link) => link.position.start.line === index,
      );
      const formatted = replaceLinksOnLine(line, lineLinks).replace(
        CHECKBOX_REGEX,
        "$1",
      );
      return {
        source: line,
        formatted,
        headingLevel: undefined,
        lineNumber: index,
      } as Line;
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
