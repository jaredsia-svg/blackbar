// Writes a fresh PDF whose pages are single flattened images.
//
// This is the whole safety argument of the tool, so it is worth stating
// plainly. The usual way to "redact" a PDF is to draw a black rectangle over
// the text. That is not redaction: the text objects are still in the file, and
// anyone can select, copy, or `pdftotext` them straight back out. Newspapers
// have published documents redacted that way and been read anyway.
//
// So Blackbar never edits the input. It rasterises each page to a canvas,
// paints the black boxes onto those pixels, and then builds a *new* PDF from
// the resulting images with this writer. The output has no text objects, no
// fonts, no annotations, no embedded attachments, no JavaScript, no XMP, and
// no document-information dictionary carried over from the original. There is
// nothing underneath the black boxes because there is no underneath.
//
// The cost, which the UI states rather than hides: the output is not
// searchable or selectable, and it is bigger than the original. That trade is
// the point. A redaction you cannot undo is worth more than a text layer.
(function (root) {
  'use strict';

  const encoder = new TextEncoder();
  const ascii = s => encoder.encode(s);

  // A PDF cross-reference table is a list of byte offsets, so the file has to
  // be assembled as bytes while counting them. Chunks accumulate here and are
  // concatenated once at the end.
  function Sink() {
    const chunks = [];
    let length = 0;
    return {
      push(bytes) {
        const b = typeof bytes === 'string' ? ascii(bytes) : bytes;
        chunks.push(b);
        length += b.length;
        return b.length;
      },
      get length() { return length; },
      concat() {
        const out = new Uint8Array(length);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        return out;
      },
    };
  }

  // PDF numbers must not be written in exponential notation, and trailing
  // zeros only make the file bigger.
  function num(n) {
    if (!Number.isFinite(n)) throw new Error('Blackbar: refusing to write a non-finite number into a PDF');
    const fixed = n.toFixed(4);
    return fixed.replace(/\.?0+$/, '') || '0';
  }

  // Escapes a literal string for a PDF ( ) string object.
  function litstr(s) {
    return '(' + String(s).replace(/[\\()]/g, m => '\\' + m).replace(/[\r\n]/g, ' ') + ')';
  }

  // pages: [{ widthPt, heightPt, image: { bytes, width, height, filter } }]
  //   widthPt/heightPt — the page box in points, so the output prints at the
  //     same physical size as the original however densely it was rasterised.
  //   filter — 'DCTDecode' for JPEG bytes, 'FlateDecode' for deflated raw RGB.
  function build(pages, options) {
    if (!Array.isArray(pages) || pages.length === 0) {
      throw new Error('Blackbar: a PDF needs at least one page');
    }
    const opts = options || {};
    const sink = Sink();

    // Object 0 is the free-list head and is never written; offsets[i] is the
    // byte offset of object i.
    const offsets = [0];
    // Object ids run 1..3 for the catalog, page tree and info, then three per
    // page. The highest id is therefore 3 + 3n, and /Size is one past it —
    // it counts the free-list entry at index 0. Getting this one short leaves
    // the final page's image out of the cross-reference table, which forgiving
    // readers silently repair and strict ones render as a blank page.
    const objectCount = 4 + pages.length * 3;

    const begin = id => { offsets[id] = sink.length; sink.push(id + ' 0 obj\n'); };
    const end = () => sink.push('endobj\n');

    // The %-comment with high bytes is what tells transfer agents the file is
    // binary. Without it some tools will happily mangle the JPEG streams.
    sink.push('%PDF-1.7\n');
    sink.push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));

    const pageId = i => 4 + i * 3;
    const contentId = i => 5 + i * 3;
    const imageId = i => 6 + i * 3;

    // 1: catalog
    begin(1);
    sink.push('<< /Type /Catalog /Pages 2 0 R >>\n');
    end();

    // 2: page tree
    begin(2);
    sink.push('<< /Type /Pages /Count ' + pages.length + ' /Kids [' +
      pages.map((_, i) => pageId(i) + ' 0 R').join(' ') + '] >>\n');
    end();

    // 3: document information. Deliberately minimal — this is a new document,
    // and nothing about the original belongs in it. No author, no title, no
    // creation date, because those are exactly the fields that leak.
    begin(3);
    sink.push('<< /Producer ' + litstr(opts.producer || 'Blackbar') + ' >>\n');
    end();

    pages.forEach((page, i) => {
      const img = page.image;
      const w = num(page.widthPt);
      const h = num(page.heightPt);

      begin(pageId(i));
      sink.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + ']' +
        ' /Resources << /XObject << /Im0 ' + imageId(i) + ' 0 R >> /ProcSet [/PDF /ImageC] >>' +
        ' /Contents ' + contentId(i) + ' 0 R >>\n');
      end();

      // Scale the unit image square up to the page box and draw it once.
      const stream = 'q\n' + w + ' 0 0 ' + h + ' 0 0 cm\n/Im0 Do\nQ\n';
      begin(contentId(i));
      sink.push('<< /Length ' + ascii(stream).length + ' >>\nstream\n');
      sink.push(stream);
      sink.push('endstream\n');
      end();

      begin(imageId(i));
      sink.push('<< /Type /XObject /Subtype /Image' +
        ' /Width ' + img.width + ' /Height ' + img.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8' +
        ' /Filter /' + img.filter +
        ' /Length ' + img.bytes.length + ' >>\nstream\n');
      sink.push(img.bytes);
      sink.push('\nendstream\n');
      end();
    });

    // Cross-reference table. Entries are fixed at 20 bytes each, which is why
    // the offset is zero-padded to ten digits and the line ends with " \n".
    const xrefAt = sink.length;
    sink.push('xref\n0 ' + objectCount + '\n');
    sink.push('0000000000 65535 f \n');
    for (let id = 1; id < objectCount; id++) {
      sink.push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
    }

    sink.push('trailer\n<< /Size ' + objectCount + ' /Root 1 0 R /Info 3 0 R >>\n');
    sink.push('startxref\n' + xrefAt + '\n%%EOF\n');

    return sink.concat();
  }

  root.BlackbarPdfWrite = { build, num, litstr };
})(typeof window !== 'undefined' ? window : globalThis);
