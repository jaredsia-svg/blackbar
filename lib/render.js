// Burns boxes into pixels and encodes the result.
//
// The one function that must never be "optimised" into drawing onto the
// displayed canvas: redaction happens on a copy of the source bitmap, and the
// encoded bytes come from that copy. The preview canvas carries selection
// handles, hover states and a dashed outline, none of which belong in the
// output, and a reviewer who saw a dashed box in their exported PDF would
// rightly stop trusting the rest of it.
(function (root) {
  'use strict';

  // Paints filled rectangles onto a fresh canvas of the same size and returns
  // it. `boxes` are in the source canvas's pixel coordinates.
  function flatten(source, boxes) {
    const canvas = document.createElement('canvas');
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(source, 0, 0);

    ctx.fillStyle = '#000000';
    for (const box of boxes) {
      // Round outward. A box rounded inward can leave a half-lit pixel column
      // at the edge of a glyph, which is faint but not nothing.
      const x = Math.floor(box.x);
      const y = Math.floor(box.y);
      const w = Math.ceil(box.x + box.w) - x;
      const h = Math.ceil(box.y + box.h) - y;
      ctx.fillRect(x, y, Math.max(1, w), Math.max(1, h));
    }
    return canvas;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Blackbar: the browser could not encode a page image'));
      }, type, quality);
    });
  }

  // Encodes a canvas as the image a PDF can embed directly.
  //
  // JPEG goes in as DCTDecode with no re-encoding. Lossless goes in as raw RGB
  // through FlateDecode, which means deflating it here — bigger files, but no
  // compression artefacts around small text, which matters for a document
  // someone may need to read as evidence.
  async function encodeForPdf(canvas, lossless, quality) {
    if (!lossless) {
      const blob = await canvasToBlob(canvas, 'image/jpeg', quality === undefined ? 0.92 : quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return { bytes, width: canvas.width, height: canvas.height, filter: 'DCTDecode' };
    }

    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // PDF's DeviceRGB wants three channels; the canvas gives four.
    const rgb = new Uint8Array(canvas.width * canvas.height * 3);
    for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
      rgb[j] = data[i];
      rgb[j + 1] = data[i + 1];
      rgb[j + 2] = data[i + 2];
    }
    return {
      bytes: await deflate(rgb),
      width: canvas.width,
      height: canvas.height,
      filter: 'FlateDecode',
    };
  }

  // CompressionStream('deflate') emits a zlib stream, which is exactly what
  // PDF's FlateDecode expects.
  async function deflate(bytes) {
    if (typeof CompressionStream !== 'function') {
      throw new Error('Blackbar: this browser cannot produce lossless output — switch the quality setting to JPEG');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  root.BlackbarRender = { flatten, encodeForPdf, canvasToBlob, deflate };
})(typeof window !== 'undefined' ? window : globalThis);
