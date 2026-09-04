// Reads a PDF in the browser: page images to show, and text with coordinates
// to search. Wraps pdf.js so nothing else in the app has to know about it.
//
// Everything here is local. pdf.js is vendored in vendor/ and its worker is
// loaded from the same directory, so the page makes no network request once it
// has loaded, and the file the reviewer picked never leaves the tab.
(function (root) {
  'use strict';

  // Rasterisation resolution. 2x device pixels per PDF point keeps small print
  // readable while reviewing, which matters: the reviewer has to be able to
  // see what they are about to cover.
  const RENDER_SCALE = 2;

  function lib() {
    if (!root.pdfjsLib) throw new Error('Blackbar: pdf.js has not finished loading');
    return root.pdfjsLib;
  }

  // Pulls the text of one page, with every run positioned in the coordinate
  // space of the canvas that page was rendered onto — which is what lets a
  // character span become a rectangle later.
  async function readItems(page, viewport) {
    const content = await page.getTextContent();
    const { Util } = lib();
    const items = [];

    // pdf.js installs each embedded font under a generated family name while
    // it renders, and that is the only handle on the actual metrics. It is
    // only present once the page has been rendered, and not at all for fonts
    // it could not load, so every lookup is allowed to fail.
    const familyOf = name => {
      if (!name) return null;
      try {
        const font = page.commonObjs.get(name);
        return font && font.loadedName ? font.loadedName : null;
      } catch {
        return null;
      }
    };

    for (const item of content.items) {
      // Marked-content markers have no glyphs and no transform.
      if (typeof item.str !== 'string' || !item.transform) continue;

      const tx = Util.transform(viewport.transform, item.transform);
      // The vertical scale of the composed matrix is the rendered font height;
      // item.height is in text space and would be wrong once the viewport
      // scale is applied.
      const height = Math.hypot(tx[2], tx[3]) || item.height * viewport.scale;
      items.push({
        str: item.str,
        x: tx[4],
        y: tx[5],
        w: item.width * viewport.scale,
        h: height,
        hasEOL: Boolean(item.hasEOL),
        font: familyOf(item.fontName),
      });
    }
    return items;
  }

  // Opens a PDF and returns one entry per page: a canvas of the rendered page,
  // the stitched text, and the placed items behind it.
  //
  // `onProgress` is called per page because a long document takes real time to
  // rasterise, and a reviewer staring at a frozen tab assumes it crashed.
  async function load(bytes, onProgress) {
    const pdfjs = lib();
    const doc = await pdfjs.getDocument({
      data: bytes,
      // A password-protected or corrupt file should fail loudly here rather
      // than half-render and give a false sense of a complete review.
      stopAtErrors: true,
      isEvalSupported: false,
    }).promise;

    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: RENDER_SCALE });
      const base = page.getViewport({ scale: 1 });

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;

      const items = await readItems(page, viewport);
      const stitched = root.BlackbarBoxes.buildPageText(items);

      pages.push({
        index: n - 1,
        canvas,
        widthPt: base.width,
        heightPt: base.height,
        text: stitched.text,
        items: stitched.items,
      });

      if (onProgress) onProgress(n, doc.numPages);
      // Page resources are not needed again once it is on a canvas, and a
      // long document will otherwise hold every one of them in memory.
      page.cleanup();
    }

    await doc.destroy();
    return pages;
  }

  root.BlackbarPdfRead = { load, readItems, RENDER_SCALE };
})(typeof window !== 'undefined' ? window : globalThis);
