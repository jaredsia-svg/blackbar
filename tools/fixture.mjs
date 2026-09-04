// Builds a small PDF that actually contains text, so the tests can prove that
// the exported file no longer does.
//
// Deliberately not built with Blackbar's own writer: that one only makes
// image-only PDFs, and a test whose input came from the code under test would
// prove nothing about real documents.
const LINES = [
  'CONFIDENTIAL — internal only',
  'Jane Doe can be reached at jane.doe@example.com',
  'or on (415) 555-0132 during office hours.',
  'Card on file 4242 4242 4242 4242, SSN 123-45-6789.',
  'Mailing address: 1600 Amphitheatre Parkway, 94043.',
  'Nothing else on this line is sensitive at all.',
  // A deliberately adversarial line for the box-placement test. Every
  // character before the value is unusually narrow, so estimating positions by
  // dividing the run's width evenly across its characters puts the value far
  // from where it really is. A line of average-width text would hide that
  // error; this one will not.
  'iiiiiiiiiiiiiiiiiiii 4242424242424242',
];

export function buildTextPdf(lines = LINES) {
  const chunks = [];
  let length = 0;
  const offsets = [0];
  const push = s => {
    const b = Buffer.from(s, 'latin1');
    chunks.push(b);
    length += b.length;
  };
  const begin = id => { offsets[id] = length; push(id + ' 0 obj\n'); };

  const escape = s => s.replace(/[\\()]/g, m => '\\' + m);
  const body = 'BT\n/F1 13 Tf\n14 TL\n40 740 Td\n' +
    lines.map(l => '(' + escape(l) + ') Tj T*\n').join('') + 'ET\n';

  push('%PDF-1.4\n');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\n'); push('endobj\n');
  begin(2); push('<< /Type /Pages /Count 1 /Kids [3 0 R] >>\n'); push('endobj\n');
  begin(3);
  push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]' +
    ' /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\n');
  push('endobj\n');
  begin(4);
  push('<< /Length ' + Buffer.byteLength(body, 'latin1') + ' >>\nstream\n' + body + 'endstream\n');
  push('endobj\n');
  begin(5);
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
  push('endobj\n');

  const xrefAt = length;
  push('xref\n0 6\n0000000000 65535 f \n');
  for (let id = 1; id <= 5; id++) push(String(offsets[id]).padStart(10, '0') + ' 00000 n \n');
  push('trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefAt + '\n%%EOF\n');

  return Buffer.concat(chunks);
}

export const FIXTURE_LINES = LINES;
