// Works out where a character sits inside a run of text.
//
// pdf.js reports a run as a string plus a total width. It does not report
// where each glyph within that run begins, so covering "characters 27 to 47 of
// this line" means reconstructing the advance widths. Assuming every character
// is the same width — the obvious first guess — is wrong for every
// proportional font: an 'i' is roughly a third the width of an 'm', the error
// accumulates along the run, and by the middle of a line the box is off by
// several characters. In practice that leaves the first two letters of an
// email address sitting in the clear next to a black bar, which is precisely
// the failure this program exists to prevent.
//
// So the widths are measured instead. pdf.js registers each embedded font with
// the browser under a generated family name while it renders the page, and
// that name is on the item, so the same font that drew the glyphs can measure
// them. When it is unavailable the measurement falls back to a generic
// sans-serif, which is still far closer than assuming uniform width.
//
// Either way the result is normalised against the run's known total width, so
// the ends always land exactly where pdf.js says they do and only the interior
// division is estimated.
(function (root) {
  'use strict';

  function create() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    // Prefix widths are computed once per run and reused; a page redraws on
    // every keystroke in the terms box and measuring is not free.
    const cache = new WeakMap();

    function prefixes(item) {
      const hit = cache.get(item);
      if (hit) return hit;

      const family = item.font ? '"' + item.font + '", sans-serif' : 'sans-serif';
      // Measured at a fixed nominal size; only the ratios are used.
      ctx.font = '100px ' + family;

      const widths = new Float64Array(item.str.length + 1);
      for (let i = 1; i <= item.str.length; i++) {
        widths[i] = ctx.measureText(item.str.slice(0, i)).width;
      }
      const total = widths[item.str.length];
      // A run of spaces, or a font that measures to nothing, has no usable
      // ratios — fall back to even division rather than dividing by zero.
      const scale = total > 0 ? item.w / total : item.w / Math.max(1, item.str.length);
      if (total > 0) for (let i = 0; i <= item.str.length; i++) widths[i] *= scale;
      else for (let i = 0; i <= item.str.length; i++) widths[i] = i * scale;

      cache.set(item, widths);
      return widths;
    }

    // The distance from the start of the run to the start of character n.
    return function advance(item, n) {
      if (n <= 0) return 0;
      if (n >= item.str.length) return item.w;
      return prefixes(item)[n];
    };
  }

  root.BlackbarMeasure = { create };
})(typeof window !== 'undefined' ? window : globalThis);
