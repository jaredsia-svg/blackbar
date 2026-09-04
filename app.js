// Blackbar's controller: file in, review, redacted file out.
//
// The review step is the product. Detection is a suggestion engine and it is
// wrong in both directions, so every proposal is visible on the document
// itself and every one of them can be turned off by clicking it. Nothing is
// covered that the reviewer has not seen.
(function () {
  'use strict';

  const Detect = window.BlackbarDetect;
  const Boxes = window.BlackbarBoxes;
  const PdfRead = window.BlackbarPdfRead;
  const PdfWrite = window.BlackbarPdfWrite;
  const Render = window.BlackbarRender;
  const measure = window.BlackbarMeasure.create();

  const el = id => document.getElementById(id);
  const views = { drop: el('view-drop'), review: el('view-review') };

  // A dismissed detection still has to be visible, or the reviewer cannot
  // change their mind — it becomes a dashed outline they can click again.
  const state = {
    kind: null,        // 'pdf' | 'image' | 'text'
    name: '',
    pages: [],         // { index, source, canvas, widthPt, heightPt, items, findings, hits, manual, dismissed }
    text: '',
    enabled: new Set(Detect.KINDS.map(k => k.kind).concat('term')),
    includeMedium: false,
    terms: [],
  };

  // ---------- chrome ----------

  function busy(on, message) {
    el('busy').hidden = !on;
    if (message) el('busy-text').textContent = message;
  }

  function show(name) {
    for (const key of Object.keys(views)) views[key].hidden = key !== name;
  }

  function fail(message) {
    const box = el('drop-error');
    box.textContent = message;
    box.hidden = false;
  }

  // ---------- loading ----------

  const TEXT_EXT = /\.(txt|md|markdown|csv|log|json|xml|yml|yaml)$/i;

  async function loadFile(file) {
    el('drop-error').hidden = true;
    if (!file) return;

    try {
      if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
        busy(true, 'Reading the PDF…');
        const bytes = new Uint8Array(await file.arrayBuffer());
        const pages = await PdfRead.load(bytes, (n, total) =>
          busy(true, 'Rendering page ' + n + ' of ' + total + '…'));
        startReview('pdf', file.name, pages);
      } else if (/^image\//.test(file.type) || /\.(png|jpe?g)$/i.test(file.name)) {
        busy(true, 'Reading the image…');
        startReview('image', file.name, [await loadImage(file)]);
      } else if (/^text\//.test(file.type) || TEXT_EXT.test(file.name)) {
        busy(true, 'Reading the file…');
        state.text = await file.text();
        startReview('text', file.name, []);
      } else {
        fail('Blackbar can open PDFs, PNG and JPEG images, and plain text files. That looked like none of those.');
      }
    } catch (error) {
      // A failure here means the document was not fully understood, and a
      // partial review is worse than none: it looks complete.
      fail('That file could not be opened: ' + (error && error.message ? error.message : String(error)) +
        '. Nothing was redacted. If the PDF is password-protected, remove the password first.');
      show('drop');
    } finally {
      busy(false);
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        // An image has no text layer, so there is nothing to detect and
        // everything is covered by hand.
        resolve({ index: 0, canvas, widthPt: img.naturalWidth, heightPt: img.naturalHeight, text: '', items: [] });
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('the image could not be decoded')); };
      img.src = url;
    });
  }

  function startReview(kind, name, pages) {
    state.kind = kind;
    state.name = name;
    state.pages = pages.map(p => ({
      ...p,
      source: p.canvas,          // pristine; never drawn on
      canvas: null,              // the on-screen copy, created below
      findings: [],
      hits: [],
      manual: [],
      dismissed: new Set(),
    }));

    el('doc-name').textContent = name;
    el('doc-name').title = name;
    el('textview').hidden = kind !== 'text';
    el('pages').hidden = kind === 'text';
    el('lossless').closest('.exportopts').hidden = kind === 'text';

    if (kind !== 'text') buildPageElements();
    show('review');
    rescan();
  }

  // ---------- detection ----------

  function acceptedKinds() {
    return Array.from(state.enabled).filter(k => k !== 'term');
  }

  function scanText(text) {
    const found = Detect.findAll(text, { kinds: acceptedKinds(), terms: state.terms });
    return found.filter(f => f.confidence === 'high' || state.includeMedium);
  }

  // Recomputes everything downstream of the settings. Cheap enough to run on
  // every keystroke for documents of a sane size, and being always-consistent
  // is worth more than being clever about it.
  function rescan() {
    if (state.kind === 'text') {
      state.findings = scanText(state.text);
      drawTextView();
    } else {
      for (const page of state.pages) {
        page.findings = scanText(page.text);
        page.dismissed = new Set(Array.from(page.dismissed));
        page.hits = page.findings.map(f => ({
          finding: f,
          rects: Boxes.boxesForSpans(page.items, [f], { advance: measure }),
        }));
        drawPage(page);
      }
    }
    renderKinds();
    renderCounts();
  }

  // ---------- sidebar ----------

  function allFindings() {
    return state.kind === 'text' ? state.findings : state.pages.flatMap(p => p.findings);
  }

  // Counts are taken with the kind filter lifted, so a group that is switched
  // off still shows how much it would catch. A zero next to "Payment cards"
  // means something different from a blank, and the reviewer needs to be able
  // to tell those apart.
  function countsByKind() {
    const texts = state.kind === 'text' ? [state.text] : state.pages.map(p => p.text);
    const tally = {};
    for (const text of texts) {
      const all = Detect.findAll(text, { terms: state.terms });
      for (const f of all) {
        if (f.confidence === 'medium' && !state.includeMedium) continue;
        tally[f.kind] = (tally[f.kind] || 0) + 1;
      }
    }
    return tally;
  }

  function renderKinds() {
    const tally = countsByKind();
    const rows = Detect.KINDS.concat([{ kind: 'term', label: 'Terms you listed', hint: 'Literal matches on what you typed above.' }]);
    const host = el('kinds');
    host.textContent = '';

    for (const row of rows) {
      const n = tally[row.kind] || 0;
      const label = document.createElement('label');
      label.className = 'kind' + (n === 0 ? ' empty' : '');
      label.title = row.hint;

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state.enabled.has(row.kind);
      box.disabled = n === 0;
      box.dataset.kind = row.kind;
      box.addEventListener('change', () => {
        if (box.checked) state.enabled.add(row.kind);
        else state.enabled.delete(row.kind);
        rescan();
      });

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = row.label;

      const count = document.createElement('span');
      count.className = 'n';
      count.textContent = String(n);

      label.append(box, name, count);
      host.append(label);
    }
  }

  function renderCounts() {
    const covered = state.kind === 'text'
      ? state.findings.filter(f => !dismissedText.has(f.id)).length
      : state.pages.reduce((sum, p) => sum + p.hits.filter(h => !p.dismissed.has(h.finding.id)).length, 0);
    const manual = state.pages.reduce((sum, p) => sum + p.manual.length, 0);
    const skipped = state.kind === 'text'
      ? dismissedText.size
      : state.pages.reduce((sum, p) => sum + p.dismissed.size, 0);

    const parts = ['<strong>' + covered + '</strong> match' + (covered === 1 ? '' : 'es') + ' will be covered'];
    if (manual) parts.push('<strong>' + manual + '</strong> box' + (manual === 1 ? '' : 'es') + ' you drew');
    if (skipped) parts.push('<strong>' + skipped + '</strong> you turned off');
    el('counts').innerHTML = parts.join('<br>');

    const total = covered + manual;
    el('export').disabled = total === 0 && state.kind !== 'text';
    el('exportnote').textContent = total === 0 ? 'Nothing is selected yet.' : '';
  }

  // ---------- page rendering ----------

  function buildPageElements() {
    const host = el('pages');
    host.textContent = '';

    for (const page of state.pages) {
      const wrap = document.createElement('div');
      wrap.className = 'page';

      const canvas = document.createElement('canvas');
      canvas.width = page.source.width;
      canvas.height = page.source.height;
      page.canvas = canvas;

      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = 'Page ' + (page.index + 1);

      wrap.append(canvas, num);
      host.append(wrap);
      attachDrawing(page, canvas);
    }
  }

  function activeBoxes(page) {
    const spans = page.hits.filter(h => !page.dismissed.has(h.finding.id)).map(h => h.finding);
    return Boxes.boxesForSpans(page.items, spans, { advance: measure }).concat(page.manual);
  }

  function drawPage(page, preview) {
    const ctx = page.canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, page.canvas.width, page.canvas.height);
    ctx.drawImage(page.source, 0, 0);

    // Solid black, exactly as it will be burned in — the preview must not be
    // more reassuring than the output.
    ctx.fillStyle = '#000';
    for (const box of activeBoxes(page)) ctx.fillRect(box.x, box.y, box.w, box.h);

    // Dismissed detections: dashed, so a mistaken dismissal is obvious and
    // can be clicked back on.
    const off = page.hits.filter(h => page.dismissed.has(h.finding.id));
    if (off.length) {
      ctx.save();
      ctx.strokeStyle = '#d98b1f';
      ctx.lineWidth = Math.max(1.5, page.canvas.width / 700);
      ctx.setLineDash([6, 5]);
      for (const hit of off) for (const r of hit.rects) ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.restore();
    }

    if (preview) {
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.45)';
      ctx.fillRect(preview.x, preview.y, preview.w, preview.h);
      ctx.restore();
    }
  }

  // ---------- drawing and clicking on a page ----------

  function attachDrawing(page, canvas) {
    let start = null;

    // Screen pixels and canvas pixels differ whenever the page is scaled to
    // fit, so every pointer position is converted before it is used.
    const at = event => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (event.clientX - rect.left) * (canvas.width / rect.width),
        y: (event.clientY - rect.top) * (canvas.height / rect.height),
      };
    };

    canvas.addEventListener('pointerdown', event => {
      start = at(event);
      // Capture keeps a drag alive if the pointer leaves the canvas, but it
      // throws for a pointer the browser is not currently tracking. That must
      // not take the rest of the handler down with it — losing `start` would
      // mean the drag silently never began.
      try { canvas.setPointerCapture(event.pointerId); } catch { /* not fatal */ }
    });

    canvas.addEventListener('pointermove', event => {
      if (!start) return;
      const now = at(event);
      drawPage(page, Boxes.rectFromDrag(start.x, start.y, now.x, now.y));
    });

    canvas.addEventListener('pointerup', event => {
      if (!start) return;
      const end = at(event);
      const rect = Boxes.rectFromDrag(start.x, start.y, end.x, end.y);
      start = null;

      // A drag too small to be a box was a click, and a click means "change
      // your mind about whatever is under it".
      const minimum = canvas.width * 0.008;
      if (rect.w < minimum && rect.h < minimum) toggleAt(page, end.x, end.y);
      else page.manual.push(rect);

      drawPage(page);
      renderCounts();
    });

    canvas.addEventListener('pointercancel', () => { start = null; drawPage(page); });
  }

  // Click order matters: a hand-drawn box sits on top, so it is removed first;
  // then a live detection is dismissed; then a dismissed one is restored.
  function toggleAt(page, x, y) {
    const manualHit = Boxes.rectAt(page.manual, x, y);
    if (manualHit !== -1) { page.manual.splice(manualHit, 1); return; }

    for (const hit of page.hits) {
      if (page.dismissed.has(hit.finding.id)) continue;
      if (Boxes.rectAt(hit.rects, x, y) !== -1) { page.dismissed.add(hit.finding.id); return; }
    }
    for (const hit of page.hits) {
      if (!page.dismissed.has(hit.finding.id)) continue;
      if (Boxes.rectAt(hit.rects, x, y) !== -1) { page.dismissed.delete(hit.finding.id); return; }
    }
  }

  // ---------- text documents ----------

  const dismissedText = new Set();

  function drawTextView() {
    const view = el('textview');
    view.textContent = '';
    let cursor = 0;

    for (const f of state.findings) {
      if (f.start < cursor) continue;
      view.append(document.createTextNode(state.text.slice(cursor, f.start)));
      const mark = document.createElement('mark');
      mark.textContent = state.text.slice(f.start, f.end);
      mark.title = f.label + ' — click to keep it';
      if (dismissedText.has(f.id)) { mark.className = 'off'; mark.title = f.label + ' — click to cover it'; }
      mark.addEventListener('click', () => {
        if (dismissedText.has(f.id)) dismissedText.delete(f.id); else dismissedText.add(f.id);
        drawTextView();
        renderCounts();
      });
      view.append(mark);
      cursor = f.end;
    }
    view.append(document.createTextNode(state.text.slice(cursor)));
  }

  // ---------- export ----------

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function redactedName(extension) {
    const base = state.name.replace(/\.[^.]+$/, '') || 'document';
    return base + '-redacted.' + extension;
  }

  async function exportFile() {
    busy(true, 'Building the redacted file…');
    try {
      if (state.kind === 'text') {
        const spans = state.findings.filter(f => !dismissedText.has(f.id));
        const blob = new Blob([Detect.applyToText(state.text, spans, 'block')], { type: 'text/plain' });
        download(blob, redactedName('txt'));
      } else if (state.kind === 'image') {
        const page = state.pages[0];
        const flat = Render.flatten(page.source, activeBoxes(page));
        download(await Render.canvasToBlob(flat, 'image/png'), redactedName('png'));
      } else {
        const lossless = el('lossless').checked;
        const built = [];
        for (const page of state.pages) {
          busy(true, 'Flattening page ' + (page.index + 1) + ' of ' + state.pages.length + '…');
          const flat = Render.flatten(page.source, activeBoxes(page));
          built.push({
            widthPt: page.widthPt,
            heightPt: page.heightPt,
            image: await Render.encodeForPdf(flat, lossless),
          });
        }
        const bytes = PdfWrite.build(built);
        download(new Blob([bytes], { type: 'application/pdf' }), redactedName('pdf'));
      }
    } catch (error) {
      alert('The redacted file could not be built: ' + (error && error.message ? error.message : error) +
        '\n\nNothing was saved. Your document is unchanged.');
    } finally {
      busy(false);
    }
  }

  // ---------- wiring ----------

  const drop = el('drop');
  const input = el('file');

  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { loadFile(input.files[0]); input.value = ''; });

  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, e => { e.preventDefault(); drop.classList.add('over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, e => { e.preventDefault(); drop.classList.remove('over'); });
  }
  drop.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
  // Without this the browser navigates away to the dropped file and the tab,
  // along with everything in it, is gone.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', e => e.preventDefault());

  let termsTimer = null;
  el('terms').addEventListener('input', () => {
    clearTimeout(termsTimer);
    termsTimer = setTimeout(() => {
      state.terms = el('terms').value.split('\n').map(s => s.trim()).filter(Boolean);
      rescan();
    }, 200);
  });

  el('medium').addEventListener('change', e => { state.includeMedium = e.target.checked; rescan(); });
  el('export').addEventListener('click', exportFile);
  el('restart').addEventListener('click', () => {
    state.pages = [];
    state.text = '';
    state.findings = [];
    dismissedText.clear();
    el('terms').value = '';
    state.terms = [];
    show('drop');
  });

  window.Blackbar = { state, rescan, loadFile, exportFile };
})();
