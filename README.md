# Blackbar

A document redactor that runs entirely in your browser. Nothing is uploaded.

Open a PDF, an image or a text file, review what Blackbar thinks is sensitive,
and export a copy with the approved parts removed. There is no server, no
build step and no network request once the page has loaded.

```
npm install     # only needed to run the tests
npm start       # serves the folder at http://localhost:8017
```

The app itself is `index.html`, `app.js`, `app.css`, `lib/` and `vendor/` — a
static folder. It cannot be opened straight off the disk with `file://`,
because ES modules and pdf.js's worker are blocked there; any static server
will do, and `npm start` is one.

## Why not just draw a black rectangle

Because that does not remove anything. A rectangle drawn over text in a PDF
editor is one more object painted on top of text that is still in the file,
still selectable, and still recoverable with `pdftotext` or a copy and paste.
Redacted court filings, intelligence reports and corporate disclosures have all
been un-redacted this way by readers who simply selected the text.

Blackbar never edits the input document. It rasterises each page, paints the
approved boxes onto those pixels, and builds a **new** PDF out of the resulting
images. The output contains no text objects, no fonts, no annotations, no
embedded files, no JavaScript, and none of the original's metadata — no author,
title, timestamps or revision history. There is nothing underneath the black
bars because there is no underneath.

`tools/selftest.mjs` asserts this rather than assuming it: it opens the
exported file with a real PDF parser and fails if a single text object survives.

## What it costs

- **The exported PDF is images.** It is no longer searchable or selectable, and
  it is larger than the original. That is the trade being made deliberately.
- **Original metadata is dropped, not preserved.** Usually what you want from a
  redactor, but worth knowing if you needed it.

## How it decides what to propose

Everything Blackbar finds is a *proposal*. Nothing is covered that you have not
seen, and every proposal can be switched off by clicking it on the page.

Detection is rule-based and runs locally. Where a value can check itself it
must: card numbers are validated with Luhn, IBANs with mod-97, and US Social
Security numbers against the ranges that have never been issued. Detectors that
match on shape alone — postcodes, street addresses, bare ten-digit numbers — are
marked lower-confidence and are off until you ask for them.

The bias is towards precision, because recall has a backstop and precision does
not: you can catch a missed value by eye during review, but a list padded with
hundreds of false positives trains you to approve everything, which loses both.

| Detector | Validated by |
| --- | --- |
| Email addresses | structure |
| Payment card numbers | Luhn checksum |
| Bank accounts (IBAN) | mod-97 checksum |
| US Social Security numbers | issued-range rules |
| Phone numbers | E.164 and NANP shapes |
| IP addresses | octet range |
| Web addresses | scheme and host |
| Street addresses | house number + street type *(lower confidence)* |
| Postal codes | US ZIP, UK postcode *(lower confidence)* |
| Dates of birth | requires a birth-date keyword |

**Names are not on that list, and cannot be.** No rule finds a name reliably.
Type the names you care about into the terms box and every occurrence is
matched, ignoring case, longest first.

## Reviewing

- Detected values are covered with a solid black bar — exactly what the export
  will contain, so the preview is never more reassuring than the result.
- **Click a bar** to turn that one off. It becomes a dashed amber outline, so a
  mistaken dismissal is visible, and clicking it again turns it back on.
- **Drag on the page** to add a box by hand. Click a box you drew to remove it.
  This is the only way to cover anything on a page with no text layer.

## Known limits

- **Scanned documents have no text layer.** If a PDF is a photograph of a page,
  there is nothing to search and Blackbar will find nothing. Everything must be
  covered by hand. There is no OCR.
- **Form fields and annotations are drawn but not searched.** pdf.js reports
  page text, not annotation contents, so a value typed into a form field is
  visible on the page and will not be detected. Cover those by hand.
- **Rotated text is approximated.** Boxes are axis-aligned, so text on an angle
  gets its bounding box rather than a tight one.
- **Character positions inside a run are reconstructed, not reported.** PDF
  gives the width of a whole run, not of each glyph, so Blackbar measures the
  run with the page's own font and normalises against the known total. Boxes
  are padded outward and never inward, so the worst case is covering a
  neighbouring character rather than leaving one showing.
- **Password-protected PDFs are refused.** Remove the password first.
- No DOCX, XLSX or PPTX. Those are archives of XML with their own hiding
  places, and half-supporting them would be worse than not.

## Check the output

The habit worth keeping, whatever tool you use: open the exported file, select
all, copy, and paste it somewhere. If anything you redacted comes back, the
redaction failed. With Blackbar nothing should — there is no text to select.

## Tests

```
npm test        # detectors, geometry and the PDF writer, in node
npm run test:ui # the real page in a real browser, end to end
```

`npm test` builds a PDF that genuinely contains text, runs it through the
pipeline, and re-opens the result to prove the text is gone. `npm run test:ui`
drives the actual interface with Playwright: it loads that PDF, checks the
detections, clicks a bar off and back on, drags a box, exports, and then
verifies the downloaded file contains no text objects and none of the secrets
as raw bytes. It also renders a deliberately adversarial line — narrow glyphs
before a card number, where estimating character positions by even division is
badly wrong — and asserts the bar covers the value's ink from first pixel to
last.

## Layout

```
index.html        the page
app.js            the controller: load, review, export
app.css           all of the styling
lib/detect.js     rules that propose spans, and the checksums behind them
lib/boxes.js      character spans to rectangles on a page
lib/measure.js    real glyph advances, so a bar lands on its text
lib/pdfread.js    pdf.js wrapper: page images plus positioned text
lib/pdfwrite.js   builds the image-only output PDF
lib/render.js     burns boxes into pixels and encodes them
vendor/           pdf.js, so the page never fetches code from elsewhere
tools/            the two test suites, a fixture builder, a static server
```

## Licence

pdf.js in `vendor/` is Apache-2.0; its licence is alongside it.
