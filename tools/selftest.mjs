// Unit pass over everything that does not need a browser.
//
// The browser-side modules are written as classic scripts attached to a global
// so that they can be loaded here without a bundler, the same way the page
// loads them. tools/uitest.mjs covers the parts that need a real canvas.
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

import { buildTextPdf, FIXTURE_LINES } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

let passed = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) passed++;
  else failures.push(label + (detail === undefined ? '' : ' — ' + detail));
};

for (const file of ['detect.js', 'boxes.js', 'pdfwrite.js']) {
  runInThisContext(readFileSync(join(root, 'lib', file), 'utf8'), { filename: file });
}
const Detect = globalThis.BlackbarDetect;
const Boxes = globalThis.BlackbarBoxes;
const PdfWrite = globalThis.BlackbarPdfWrite;

// ---------- checksums ----------

check('luhn accepts a real card', Detect.luhnValid('4242424242424242'));
check('luhn accepts amex length', Detect.luhnValid('378282246310005'));
check('luhn rejects a transposition', !Detect.luhnValid('4242424242424252'));
check('luhn rejects repeated digits', !Detect.luhnValid('4444444444444444'));
check('luhn rejects a short number', !Detect.luhnValid('42424242'));
check('iban accepts a valid GB number', Detect.ibanValid('GB82 WEST 1234 5698 7654 32'));
check('iban rejects a bad check digit', !Detect.ibanValid('GB83 WEST 1234 5698 7654 32'));
check('mod97 of a known value', Detect.mod97('3214282912345698765432161182') === 1);

// ---------- detectors ----------

const kindsIn = (text, options) => Detect.findAll(text, options).map(f => f.kind);
const textsOf = (text, kind, options) =>
  Detect.findAll(text, options).filter(f => f.kind === kind).map(f => f.text);

check('finds an email', kindsIn('write to a.b+c@sub.example.co.uk now').includes('email'));
check('email keeps its whole domain',
  textsOf('write to a.b+c@sub.example.co.uk now', 'email')[0] === 'a.b+c@sub.example.co.uk');

for (const phone of ['(415) 555-0132', '415-555-0132', '415.555.0132', '+44 20 7946 0958', '+1 (415) 555-0132']) {
  check('finds phone ' + phone, kindsIn('call ' + phone + ' today').includes('phone'), phone);
}
// findAll reports everything it finds and labels how sure it is; the caller
// decides what to act on. These two assert the label, not the filtering.
check('a bare ten-digit run is reported at medium confidence', (() => {
  const found = Detect.findAll('call 415 555 0132').filter(f => f.kind === 'phone');
  return found.length === 1 && found[0].confidence === 'medium';
})());
check('a separated number is reported at high confidence', (() => {
  const found = Detect.findAll('call 415-555-0132').filter(f => f.kind === 'phone');
  return found.length === 1 && found[0].confidence === 'high';
})());

check('finds a Luhn-valid card', kindsIn('card 4242 4242 4242 4242 ok').includes('card'));
check('ignores a sixteen-digit non-card', !kindsIn('ref 1234 5678 9012 3456 ok').includes('card'));
check('finds a dashed SSN', kindsIn('ssn 123-45-6789').includes('ssn'));
check('rejects SSN area 666', !kindsIn('ssn 666-45-6789').includes('ssn'));
check('rejects SSN serial 0000', !kindsIn('ssn 123-45-0000').includes('ssn'));
check('finds a bare SSN only when labelled', kindsIn('SSN: 123456789').includes('ssn'));
check('ignores nine bare digits with no label', !kindsIn('order 123456789 shipped').includes('ssn'));
check('finds an IPv4 address', kindsIn('host 192.168.1.44 up').includes('ip'));
check('rejects an out-of-range dotted quad', !kindsIn('build 999.1.1.1 failed').includes('ip'));
check('finds a URL', kindsIn('see https://example.com/a?token=abc for more').includes('url'));
check('a URL drops the sentence full stop',
  textsOf('see https://example.com/a.', 'url')[0] === 'https://example.com/a');
check('finds a street address', kindsIn('at 1600 Amphitheatre Parkway today').includes('address'));
check('finds a labelled date of birth', kindsIn('DOB: 04/11/1979').includes('dob'));
check('ignores an unlabelled date', !kindsIn('shipped 04/11/1979').includes('dob'));

// ---------- terms ----------

check('matches a listed term', textsOf('Jane spoke to jane', 'term', { terms: ['Jane'] }).length === 2);
check('term matching is case-insensitive',
  textsOf('JANE spoke', 'term', { terms: ['jane'] })[0] === 'JANE');
check('a term does not match inside a longer word',
  Detect.findAll('Janet spoke', { terms: ['Jane'] }).length === 0);
check('the longer of two overlapping terms wins',
  textsOf('Jane Doe called', 'term', { terms: ['Jane', 'Jane Doe'] })[0] === 'Jane Doe');
check('a term with punctuation still matches',
  textsOf('ref #A-1/22 here', 'term', { terms: ['#A-1/22'] }).length === 1);

// ---------- overlap ----------

const overlapped = Detect.findAll('mail me at bob@example.com or https://x.co/bob@example.com');
check('overlapping findings collapse to one span each',
  overlapped.every((f, i) => i === 0 || f.start >= overlapped[i - 1].end),
  JSON.stringify(overlapped.map(f => [f.kind, f.start, f.end])));

// ---------- applying to text ----------

const sample = 'Call Jane on (415) 555-0132.';
const spans = Detect.findAll(sample, { terms: ['Jane'] });
const blocked = Detect.applyToText(sample, spans, 'block');
check('block redaction removes the original text',
  !blocked.includes('Jane') && !blocked.includes('555-0132'), blocked);
check('block redaction preserves length', blocked.length === sample.length, blocked);
check('label redaction names the kind',
  Detect.applyToText(sample, spans, 'label').includes('[PHONE]'));
check('remove redaction deletes outright',
  Detect.applyToText(sample, spans, 'remove') === 'Call  on .');

// ---------- geometry ----------

const items = [
  { str: 'Jane', x: 10, y: 100, w: 40, h: 10, hasEOL: false },
  { str: 'Doe', x: 56, y: 100, w: 30, h: 10, hasEOL: true },
  { str: 'and Sam Roe', x: 10, y: 120, w: 99, h: 10, hasEOL: false },
];
const stitched = Boxes.buildPageText(items);
check('stitching inserts a space across a gap', stitched.text.startsWith('Jane Doe'), stitched.text);
check('stitching breaks the line at hasEOL', stitched.text.includes('Doe\nand'), stitched.text);
check('placed items carry their offsets',
  stitched.items[2].start === stitched.text.indexOf('and Sam Roe'));

const nameSpan = { start: 0, end: 8 };
const oneLine = Boxes.boxesForSpans(stitched.items, [nameSpan]);
check('a name split across two items becomes one box', oneLine.length === 1, JSON.stringify(oneLine));
check('the box starts left of the text', oneLine[0].x < 10);
check('the box ends right of the text', oneLine[0].x + oneLine[0].w > 86);
// Helvetica's cap height is about 0.72em and its descenders reach about
// 0.21em below the baseline. The box has to clear both, or it shaves the top
// off a capital or leaves the tail of a 'y' showing.
check('the box clears cap height above the baseline', oneLine[0].y <= 100 - 10 * 0.72,
  String(oneLine[0].y));
check('the box clears the descenders below the baseline',
  oneLine[0].y + oneLine[0].h >= 100 + 10 * 0.21,
  String(oneLine[0].y + oneLine[0].h));

const twoLines = Boxes.boxesForSpans(stitched.items, [nameSpan, { start: 17, end: 24 }]);
check('separate lines stay separate boxes', twoLines.length === 2, JSON.stringify(twoLines));

check('a partial item is only partly covered',
  Boxes.sliceRect(stitched.items[2], stitched.items[2].start, stitched.items[2].start + 3).w < 99);
check('merging joins touching rectangles on one line',
  Boxes.mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 9, y: 0, w: 10, h: 10 }]).length === 1);
check('merging leaves distant rectangles alone',
  Boxes.mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 40, y: 0, w: 10, h: 10 }]).length === 2);
check('merging closes a gap the size of a space',
  Boxes.mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 14, y: 0, w: 10, h: 10 }], 6).length === 1);
check('merging never joins boxes on different lines',
  Boxes.mergeRects([{ x: 0, y: 0, w: 10, h: 10 }, { x: 12, y: 40, w: 10, h: 10 }], 20).length === 2);
// The slab bug: two boxes that overlap vertically by a sliver are adjacent
// lines, not one line, and must not become a single block.
check('boxes that only graze vertically stay separate',
  Boxes.mergeRects([{ x: 0, y: 0, w: 100, h: 10 }, { x: 0, y: 9, w: 100, h: 10 }]).length === 2);
check('a redaction stays inside its own line', (() => {
  // Three lines at realistic 13pt-on-14pt leading, rendered at 2x.
  const lines = [0, 1, 2].map(n => ({ str: 'secret text here', x: 80, y: 100 + n * 28, w: 200, h: 26, hasEOL: true }));
  const page = Boxes.buildPageText(lines);
  const boxes = Boxes.boxesForSpans(page.items, [{ start: page.items[1].start, end: page.items[1].end }]);
  if (boxes.length !== 1) return false;
  const top = page.items[0].y, bottom = page.items[2].y;
  return boxes[0].y > top && boxes[0].y + boxes[0].h < bottom;
})());
check('hit testing finds the top rectangle',
  Boxes.rectAt([{ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }], 7, 7) === 1);
check('hit testing misses outside', Boxes.rectAt([{ x: 0, y: 0, w: 10, h: 10 }], 40, 40) === -1);
check('a drag normalises to positive extents', (() => {
  const r = Boxes.rectFromDrag(30, 40, 10, 10);
  return r.x === 10 && r.y === 10 && r.w === 20 && r.h === 30;
})());

// ---------- pdf writer ----------

const image = {
  bytes: new Uint8Array(deflateSync(Buffer.alloc(8 * 6 * 3, 0x20))),
  width: 8, height: 6, filter: 'FlateDecode',
};
const written = PdfWrite.build([
  { widthPt: 612, heightPt: 792, image },
  { widthPt: 200.5, heightPt: 100, image },
]);
const raw = Buffer.from(written).toString('latin1');
// pdf.js takes ownership of the buffer it is handed and detaches it, so
// anything measured from `written` has to be measured before it is parsed.
const writtenBytes = written.length;

check('the file starts with a PDF header', raw.startsWith('%PDF-1.'));
check('the file ends with EOF', raw.trimEnd().endsWith('%%EOF'));
check('a binary marker follows the header', /^%PDF-1\.\d\n%[\x80-\xff]{4}/.test(raw));
check('the declared page count matches', /\/Type \/Pages \/Count 2/.test(raw));
check('a fractional page size is not written in exponential form', raw.includes('0 0 200.5 100'));

const declared = Number(raw.match(/xref\n0 (\d+)/)[1]);
check('the xref covers every object that was written',
  declared === 4 + 2 * 3, 'declared ' + declared);
check('the highest object id written is inside /Size', (() => {
  const ids = [...raw.matchAll(/^(\d+) 0 obj$/gm)].map(m => Number(m[1]));
  return Math.max(...ids) === declared - 1;
})());
const xrefAt = Number(raw.match(/startxref\n(\d+)/)[1]);
check('startxref points at the table', raw.startsWith('xref', xrefAt));
const rows = raw.slice(xrefAt).split('\n').slice(2, 2 + declared);
check('the free-list head is present', rows[0].startsWith('0000000000 65535 f'));
let misplaced = 0;
for (let id = 1; id < declared; id++) {
  if (!raw.startsWith(id + ' 0 obj', Number(rows[id].slice(0, 10)))) misplaced++;
}
check('every xref offset lands on its object', misplaced === 0, misplaced + ' wrong');
check('every xref row is exactly twenty bytes',
  rows.slice(0, declared).every(r => r.length === 19));
check('the writer refuses an empty document', (() => {
  try { PdfWrite.build([]); return false; } catch { return true; }
})());
check('the writer refuses a non-finite page size', (() => {
  try { PdfWrite.build([{ widthPt: NaN, heightPt: 100, image }]); return false; } catch { return true; }
})());

// ---------- the output really has no text ----------

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const fixture = buildTextPdf();
const before = await pdfjs.getDocument({ data: new Uint8Array(fixture) }).promise;
const beforePage = await before.getPage(1);
const beforeText = (await beforePage.getTextContent()).items.map(i => i.str).join(' ');
check('the fixture contains extractable text', beforeText.includes('jane.doe@example.com'), beforeText.slice(0, 80));
check('the fixture detectors fire on that text',
  Detect.findAll(beforeText, { terms: ['Jane Doe'] }).length >= 5);

const after = await pdfjs.getDocument({ data: written }).promise;
check('the written PDF opens', after.numPages === 2);
let leaked = 0;
for (let n = 1; n <= after.numPages; n++) {
  const page = await after.getPage(n);
  if ((await page.getTextContent()).items.length !== 0) leaked++;
}
check('no page of the written PDF has any text object', leaked === 0, leaked + ' page(s) still had text');

// Every page must actually paint its image. A page whose XObject cannot be
// resolved still opens, still reports a size, and still has no text — it is
// simply blank, which no other assertion here would notice.
let unpainted = 0;
for (let n = 1; n <= after.numPages; n++) {
  const ops = await (await after.getPage(n)).getOperatorList();
  if (!ops.fnArray.includes(pdfjs.OPS.paintImageXObject)) unpainted++;
}
check('every page of the written PDF paints its image', unpainted === 0,
  unpainted + ' blank page(s)');

const firstViewport = (await after.getPage(1)).getViewport({ scale: 1 });
check('page size survives the rebuild', firstViewport.width === 612 && firstViewport.height === 792);
const secondViewport = (await after.getPage(2)).getViewport({ scale: 1 });
check('a second, differently sized page survives too',
  secondViewport.width === 200.5 && secondViewport.height === 100);

const meta = await after.getMetadata();
check('the rebuilt file names Blackbar as producer', meta.info.Producer === 'Blackbar');
check('no author is carried into the output', !meta.info.Author);
check('no title is carried into the output', !meta.info.Title);
check('no creation date is carried into the output', !meta.info.CreationDate);

// ---------- report ----------

console.log('\nBlackbar self-test');
console.log('  fixture lines    : ' + FIXTURE_LINES.length);
console.log('  written PDF      : ' + writtenBytes + ' bytes, ' + after.numPages + ' pages\n');

if (failures.length) {
  console.error('  ' + failures.length + ' FAILED:');
  for (const f of failures) console.error('    - ' + f);
  console.error('\n  ' + passed + ' checks passed');
  process.exit(1);
}
console.log('  ' + passed + ' checks passed');
