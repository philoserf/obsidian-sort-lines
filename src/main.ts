import type { CachedMetadata } from "obsidian";
import { MarkdownView, Notice, Plugin } from "obsidian";
import {
  type Comparator,
  collectLines,
  getFrontStart,
  type Line,
  type ListPart,
  type Range,
  resolveListRange,
  resolveSelectionRange,
  sortHeadings,
  sortListLines,
} from "./sort";

interface SortTarget {
  view: MarkdownView;
  cache: CachedMetadata;
}

interface EditorContext extends SortTarget {
  start: number;
  end: number;
  endLineLength: number;
}

/** Everything the range resolvers need to read off the editor. */
function bounds({ view, cache }: SortTarget) {
  const editor = view.editor;
  const lastLine = editor.lastLine();
  return {
    from: editor.getCursor("from").line,
    to: editor.getCursor("to").line,
    frontStart: getFrontStart(cache.frontmatter),
    lastLine,
    lastLineEmpty: editor.getLine(lastLine) === "",
  };
}

export default class SortLinesPlugin extends Plugin {
  // Built at construction, not in onload: a definite-assignment assertion
  // here would only postpone the failure to whichever method ran first,
  // reporting it as "this.compare is not a function" with no hint that the
  // real problem was call order.
  private readonly compare: Comparator = new Intl.Collator(navigator.language, {
    usage: "sort",
    sensitivity: "base",
    numeric: true,
    ignorePunctuation: true,
  }).compare;

  override onload() {
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
    const ctx = this.getSelectionContext();
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
    const ctx = this.getEnclosingListContext();
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
    const ctx = this.getSelectionContext();
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
    const ctx = this.getSelectionContext();
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
    const ctx = this.getSelectionContext();
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
    const ctx = this.getSelectionContext();
    if (!ctx) {
      new Notice("Sort Lines: no active editor");
      return;
    }
    const lines = this.getLines(ctx);
    if (lines.length === 0) {
      new Notice("Sort Lines: no lines to sort");
      return;
    }
    // Fisher-Yates. Both reads are in range for the whole loop; the guard
    // is what lets the compiler see that without an assertion.
    for (let i = lines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const from = lines[i];
      const to = lines[j];
      if (!from || !to) continue;
      lines[i] = to;
      lines[j] = from;
    }
    this.setLines(ctx, lines);
  }

  /** The sort range for every command but the list sort. */
  private getSelectionContext(): EditorContext | undefined {
    const target = this.resolveTarget();
    if (!target) return;
    return this.buildContext(target, resolveSelectionRange(bounds(target)));
  }

  /** The sort range for the list sort: the list enclosing the cursor. */
  private getEnclosingListContext(): EditorContext | undefined {
    const target = this.resolveTarget();
    if (!target) return;
    return this.buildContext(
      target,
      resolveListRange(bounds(target), target.cache.sections ?? []),
    );
  }

  private resolveTarget(): SortTarget | undefined {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;

    const cache = this.app.metadataCache.getFileCache(view.file);
    if (!cache) return;

    return { view, cache };
  }

  private buildContext(target: SortTarget, range: Range): EditorContext {
    return {
      ...target,
      start: range.start,
      end: range.end,
      // Read after the range is final: an earlier read would measure a line
      // the write no longer ends on.
      endLineLength: target.view.editor.getLine(range.end).length,
    };
  }

  private getLines(ctx: EditorContext): Line[] {
    return collectLines(ctx.view.editor.getValue(), {
      links: [...(ctx.cache.links ?? []), ...(ctx.cache.embeds ?? [])],
      headings: ctx.cache.headings ?? [],
      start: ctx.start,
      end: ctx.end,
    });
  }

  private setLines(ctx: EditorContext, lines: Line[]) {
    ctx.view.editor.replaceRange(
      lines.map((e) => e.source).join("\n"),
      { line: ctx.start, ch: 0 },
      { line: ctx.end, ch: ctx.endLineLength },
    );
  }
}
