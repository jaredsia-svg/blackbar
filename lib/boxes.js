// Turns character spans into rectangles on a rendered page.
//
// A PDF has no lines and no words. It has text-showing operators that place
// runs of glyphs at coordinates, and pdf.js hands those back as items. To go
// from "characters 40 to 58 of this page" to "these three black rectangles",
// three things have to happen: the items get stitched into a plausible reading
// order with the whitespace a human would see, a span gets attributed back to
// the items it covers, and the covered fraction of each item becomes a box.
//
// The last step is the approximate one: within a single item, character
// positions are interpolated by proportion of the string length, because the
// per-glyph advances are not in the text content. For a proportional font the
// edges of a partial-item box can therefore be off by a fraction of a
// character. Two things keep that safe rather than merely close:
//
//   - Boxes are padded outward before they are painted, never inward.
//   - Boxes that touch after padding are merged, so a redaction never has a
//     hairline gap through the middle of a word.
//
// Erring outward means the worst case is covering a neighbouring character.
// Erring inward would mean leaving a sliver of a name visible, which is the
// failure this whole program exists to avoid.
(function (root) {
  'use strict';

  // How much of the font's height sits above and below the baseline, as a
  // fraction of the em. Glyph boxes are not reported per item, so these are
  // constants: comfortably clear of cap height and of descenders, but under
  // 1em in total. That ceiling is not cosmetic. Body text is typically set
  // with about 1.1em of leading, so a box taller than an em starts to collide
  // with the lines above and below, and once boxes collide they merge — which
  // is how a redaction of one phone number turns into a black slab over three
  // lines of text nobody asked to hide.
  const ASCENT = 0.82;
  const DESCENT = 0.22;

  // Items whose baselines differ by less than this fraction of their height
  // are treated as the same visual line.
  const LINE_TOLERANCE = 0.55;

  // A gap this many multiples of the font height between the end of one item
  // and the start of the next reads as a space to a human, so the stitched
  // text gets one too. Without this, "Jane" "Doe" becomes "JaneDoe" and the
  // term matcher misses it.
  const SPACE_GAP = 0.18;

  // items: [{ str, x, y, w, h, hasEOL }] in canvas coordinates, y increasing
  // downward, y being the baseline. Returns the stitched page text plus the
  // same items annotated with their [start, end) range within it.
  function buildPageText(items) {
    let text = '';
    const placed = [];
    let previous = null;

    for (const item of items) {
      if (previous) {
        const sameLine = Math.abs(item.y - previous.y) <= Math.max(item.h, previous.h) * LINE_TOLERANCE;
        if (!sameLine || previous.hasEOL) {
          text += '\n';
        } else {
          const gap = item.x - (previous.x + previous.w);
          const alreadySpaced = /\s$/.test(previous.str) || /^\s/.test(item.str);
          if (!alreadySpaced && gap > previous.h * SPACE_GAP) text += ' ';
        }
      }
      const start = text.length;
      text += item.str;
      placed.push({ ...item, start, end: text.length });
      previous = { ...item, str: item.str };
    }

    return { text, items: placed };
  }

  // Even division of a run's width across its characters. Correct only for a
  // monospaced font; lib/measure.js supplies a real one in the browser.
  function evenAdvance(item, n) {
    const length = item.str.length;
    if (length <= 0) return 0;
    return item.w * (Math.min(n, length) / length);
  }

  // The rectangle covering characters [from, to) of a single placed item.
  function sliceRect(item, from, to, advance) {
    const length = item.end - item.start;
    if (length <= 0) return null;
    const a = Math.max(0, from - item.start);
    const b = Math.min(length, to - item.start);
    if (b <= a) return null;

    const measure = advance || evenAdvance;
    const x0 = measure(item, a);
    const x1 = measure(item, b);
    return {
      x: item.x + x0,
      y: item.y - item.h * ASCENT,
      w: Math.max(0, x1 - x0),
      h: item.h * (ASCENT + DESCENT),
    };
  }

  // All rectangles covering [start, end) across a page's placed items.
  function spanToRects(placedItems, start, end, advance) {
    const rects = [];
    for (const item of placedItems) {
      if (item.end <= start || item.start >= end) continue;
      const rect = sliceRect(item, start, end, advance);
      if (rect && rect.w > 0 && rect.h > 0) rects.push(rect);
    }
    return rects;
  }

  // Grows every rectangle outward. Always called before merging, so that
  // boxes which only nearly touch end up genuinely joined.
  function padRects(rects, padX, padY) {
    return rects.map(r => ({
      x: r.x - padX,
      y: r.y - padY,
      w: r.w + padX * 2,
      h: r.h + padY * 2,
    }));
  }

  function union(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x, y,
      w: Math.max(a.x + a.w, b.x + b.w) - x,
      h: Math.max(a.y + a.h, b.y + b.h) - y,
    };
  }

  // Whether two boxes belong to the same line of text. Requiring the shorter
  // box to be half-covered vertically is what keeps a redaction on one line
  // from reaching up into the line above it: boxes that merely graze each
  // other are on different lines and must stay apart.
  function sameLine(a, b) {
    const shared = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return shared >= Math.min(a.h, b.h) * 0.5;
  }

  // Merges boxes that sit on the same line and are no further apart than
  // `maxGap`. Repeats until nothing changes, because merging two boxes can
  // bring the result into contact with a third.
  //
  // A gap is closed rather than left open even when the boxes do not touch,
  // because a bar broken at every space announces the word lengths underneath
  // it — "four letters, then three" narrows a redacted name much further than
  // it looks like it should.
  function mergeRects(rects, maxGap) {
    const gap = maxGap || 0;
    let current = rects.slice().sort((a, b) => a.y - b.y || a.x - b.x);
    let merged = true;
    while (merged) {
      merged = false;
      const next = [];
      for (const rect of current) {
        const hit = next.findIndex(other =>
          sameLine(rect, other) &&
          Math.max(other.x, rect.x) - Math.min(other.x + other.w, rect.x + rect.w) <= gap);
        if (hit === -1) {
          next.push(rect);
        } else {
          next[hit] = union(next[hit], rect);
          merged = true;
        }
      }
      current = next;
    }
    return current;
  }

  // The whole pipeline for one page: accepted spans in, paintable boxes out.
  // `pad` is in pixels and defaults to a fraction of the line height so that
  // the padding scales with the render resolution.
  function boxesForSpans(placedItems, spans, options) {
    const opts = options || {};
    let rects = [];
    for (const span of spans) {
      rects = rects.concat(spanToRects(placedItems, span.start, span.end, opts.advance));
    }
    if (rects.length === 0) return [];

    const median = rects.map(r => r.h).sort((a, b) => a - b)[Math.floor(rects.length / 2)];
    const padX = opts.padX !== undefined ? opts.padX : median * 0.12;
    // Vertical padding stays small for the reason ASCENT and DESCENT do: the
    // box has to stay inside the line's leading.
    const padY = opts.padY !== undefined ? opts.padY : median * 0.04;
    const joinGap = opts.joinGap !== undefined ? opts.joinGap : median * 0.6;
    return mergeRects(padRects(rects, padX, padY), joinGap);
  }

  // Point-in-rectangle, for letting the reviewer click a box to remove it.
  function rectAt(rects, x, y) {
    for (let i = rects.length - 1; i >= 0; i--) {
      const r = rects[i];
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return i;
    }
    return -1;
  }

  // Normalises a drag into a rectangle with positive width and height.
  function rectFromDrag(x0, y0, x1, y1) {
    return {
      x: Math.min(x0, x1),
      y: Math.min(y0, y1),
      w: Math.abs(x1 - x0),
      h: Math.abs(y1 - y0),
    };
  }

  root.BlackbarBoxes = {
    buildPageText, spanToRects, sliceRect, boxesForSpans, evenAdvance,
    mergeRects, padRects, sameLine, rectAt, rectFromDrag,
    ASCENT, DESCENT, LINE_TOLERANCE, SPACE_GAP,
  };
})(typeof window !== 'undefined' ? window : globalThis);
