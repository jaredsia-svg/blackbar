// Rule-based detectors that propose spans of a document for redaction.
//
// Every detector here is a *proposal*. Nothing in this file removes anything;
// it hands the reviewer a list of candidate spans and the reviewer decides.
// That division is deliberate. A redactor that silently trusts a regex is a
// redactor that silently misses things, and the failure is invisible until the
// document is already public.
//
// Two rules govern what may live in this file:
//
//   1. A detector that can check itself, must. Card numbers get Luhn, IBANs
//      get mod-97. A checksum turns "sixteen digits" into "a card number" and
//      keeps the review list short enough that a human will actually read it.
//   2. Precision beats recall, because recall has a backstop and precision
//      does not. A missed span can still be caught by eye in the review pass;
//      a list padded with hundreds of false positives trains the reviewer to
//      approve everything, which loses both.
//
// Confidence is 'high' when a detector validated something structural (a
// checksum, an anchored keyword) and 'medium' when it matched shape alone.
// The UI pre-selects high and leaves medium for the reviewer to look at.
(function (root) {
  'use strict';

  // ---------- helpers ----------

  // Luhn, as used by card numbers. Rejects the all-same-digit sequences that
  // pass the checksum but are placeholders in practice (4444...).
  function luhnValid(digits) {
    if (digits.length < 13 || digits.length > 19) return false;
    if (/^(\d)\1+$/.test(digits)) return false;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let d = digits.charCodeAt(i) - 48;
      if (double) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      sum += d;
      double = !double;
    }
    return sum % 10 === 0;
  }

  // ISO 7064 mod-97-10, as used by IBANs. Done in chunks because the whole
  // number overflows a double.
  function mod97(input) {
    let remainder = 0;
    for (const ch of input) {
      const code = ch.charCodeAt(0);
      const value = code >= 65 ? String(code - 55) : ch;
      for (const digit of value) remainder = (remainder * 10 + (digit.charCodeAt(0) - 48)) % 97;
    }
    return remainder;
  }

  function ibanValid(raw) {
    const iban = raw.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
    return mod97(iban.slice(4) + iban.slice(0, 4)) === 1;
  }

  // A US SSN with any of the ranges the SSA has never issued.
  function ssnValid(area, group, serial) {
    if (area === '000' || area === '666' || area[0] === '9') return false;
    return group !== '00' && serial !== '0000';
  }

  // Runs a regex over the text and yields matches with absolute offsets. The
  // regex must be global; it is cloned so a detector table can be reused
  // across documents without lastIndex leaking between runs.
  function* scan(text, re) {
    const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (m[0] === '') { rx.lastIndex++; continue; }
      yield m;
    }
  }

  // ---------- detectors ----------
  //
  // Each entry: { kind, label, hint, find(text) -> [{start, end, confidence}] }
  // `hint` is what the review UI shows to explain why a span was proposed.

  const DETECTORS = [
    {
      kind: 'email',
      label: 'Email addresses',
      hint: 'A local part, an @, and a domain with a dotted suffix.',
      find(text) {
        const out = [];
        for (const m of scan(text, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,24}/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        return out;
      },
    },
    {
      kind: 'card',
      label: 'Payment card numbers',
      hint: 'Thirteen to nineteen digits that pass the Luhn checksum.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\b(?:\d[ -]?){12,18}\d\b/g)) {
          const digits = m[0].replace(/[ -]/g, '');
          if (luhnValid(digits)) out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        return out;
      },
    },
    {
      kind: 'iban',
      label: 'Bank accounts (IBAN)',
      hint: 'A country prefix and check digits that satisfy mod-97.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{2,4}){2,8}\b/g)) {
          if (ibanValid(m[0])) out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        return out;
      },
    },
    {
      kind: 'ssn',
      label: 'US Social Security numbers',
      hint: 'Nine digits in 3-2-4 grouping, outside the never-issued ranges.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\b(\d{3})[- ](\d{2})[- ](\d{4})\b/g)) {
          if (ssnValid(m[1], m[2], m[3])) out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        // Nine bare digits are only an SSN if something nearby says so —
        // otherwise every order number in the document lights up.
        for (const m of scan(text, /\b(?:ssn|social security(?:\s+(?:number|no\.?|#))?)\s*[:#-]?\s*(\d{3})(\d{2})(\d{4})\b/gi)) {
          if (ssnValid(m[1], m[2], m[3])) out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        return out;
      },
    },
    {
      kind: 'phone',
      label: 'Phone numbers',
      hint: 'A dialable number: E.164, or a North American number with separators.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\+\d{1,3}[\s.-]?(?:\(\d{1,4}\)[\s.-]?)?\d{1,4}(?:[\s.-]?\d{2,4}){1,4}\b/g)) {
          const digits = m[0].replace(/\D/g, '');
          if (digits.length >= 8 && digits.length <= 15) {
            out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
          }
        }
        // A parenthesised area code cannot be anchored with \b — the paren is
        // not a word character, so there is no boundary in front of it.
        for (const m of scan(text, /(?:\(\d{3}\)\s*\d{3}[-.\s]?\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4})\b/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        // Ten bare digits, or a 3-3-4 spaced group, are shape-only.
        for (const m of scan(text, /\b\d{3}\s\d{3}\s\d{4}\b/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'medium' });
        }
        return out;
      },
    },
    {
      kind: 'ip',
      label: 'IP addresses',
      hint: 'A dotted quad in range, or a colon-grouped IPv6 address.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        for (const m of scan(text, /\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'medium' });
        }
        return out;
      },
    },
    {
      kind: 'url',
      label: 'Web addresses',
      hint: 'An http(s) URL. Query strings often carry tokens and identifiers.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\bhttps?:\/\/[^\s<>"')\]]+/g)) {
          // Trailing punctuation belongs to the sentence, not the URL.
          const trimmed = m[0].replace(/[.,;:!?]+$/, '');
          out.push({ start: m.index, end: m.index + trimmed.length, confidence: 'high' });
        }
        return out;
      },
    },
    {
      kind: 'address',
      label: 'Street addresses',
      hint: 'A house number followed by a street name and a street-type word.',
      find(text) {
        const types = 'Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Place|Pl|Terrace|Ter|Way|Circle|Cir|Parkway|Pkwy|Highway|Hwy';
        const re = new RegExp('\\b\\d{1,6}[A-Za-z]?\\s+(?:[A-Z][A-Za-z.\'-]*\\s+){0,4}(?:' + types + ')\\b\\.?', 'g');
        const out = [];
        for (const m of scan(text, re)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'medium' });
        }
        return out;
      },
    },
    {
      kind: 'postcode',
      label: 'Postal codes',
      hint: 'A US ZIP or a UK postcode.',
      find(text) {
        const out = [];
        for (const m of scan(text, /\b\d{5}(?:-\d{4})?\b(?=\s|$|[.,;)])/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'medium' });
        }
        for (const m of scan(text, /\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/g)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'medium' });
        }
        return out;
      },
    },
    {
      kind: 'dob',
      label: 'Dates of birth',
      hint: 'A date introduced by a birth-date keyword.',
      find(text) {
        const out = [];
        const re = /\b(?:d\.?o\.?b\.?|date of birth|born(?:\s+on)?)\b\s*[:.]?\s*(?:\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{4})/gi;
        for (const m of scan(text, re)) {
          out.push({ start: m.index, end: m.index + m[0].length, confidence: 'high' });
        }
        return out;
      },
    },
  ];

  // ---------- custom terms ----------

  function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Literal terms the reviewer typed — usually names, which no rule can find
  // reliably. Matched whole-word and case-insensitively, longest first so
  // "Jane Doe" wins over "Jane".
  function findTerms(text, terms) {
    const out = [];
    const cleaned = terms.map(t => t.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
    for (const term of cleaned) {
      const boundary = /^[\w]/.test(term) ? '\\b' : '';
      const trailing = /[\w]$/.test(term) ? '\\b' : '';
      const re = new RegExp(boundary + escapeRegex(term) + trailing, 'gi');
      for (const m of scan(text, re)) {
        out.push({ kind: 'term', label: 'Terms you listed', hint: 'Matched "' + term + '".', start: m.index, end: m.index + m[0].length, confidence: 'high', term });
      }
    }
    return out;
  }

  // ---------- overlap ----------

  // Findings can overlap: a URL containing an email, an address containing a
  // postcode. Keeping both would let the reviewer reject one and believe the
  // text was covered, so overlapping spans collapse to a single winner —
  // longest first, then higher confidence, then earlier.
  function resolveOverlaps(findings) {
    const order = { high: 0, medium: 1 };
    const sorted = findings.slice().sort((a, b) => {
      const lenDiff = (b.end - b.start) - (a.end - a.start);
      if (lenDiff !== 0) return lenDiff;
      const confDiff = order[a.confidence] - order[b.confidence];
      if (confDiff !== 0) return confDiff;
      return a.start - b.start;
    });
    const kept = [];
    for (const f of sorted) {
      if (!kept.some(k => f.start < k.end && k.start < f.end)) kept.push(f);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  // ---------- entry point ----------

  // Returns findings sorted by position, each with a stable id so the review
  // UI can keep a decision attached to a span across a re-scan.
  function findAll(text, options) {
    const opts = options || {};
    const enabled = opts.kinds || null;
    const found = [];

    for (const d of DETECTORS) {
      if (enabled && !enabled.includes(d.kind)) continue;
      for (const hit of d.find(text)) {
        found.push({ kind: d.kind, label: d.label, hint: d.hint, ...hit });
      }
    }
    if (opts.terms && opts.terms.length) found.push(...findTerms(text, opts.terms));

    return resolveOverlaps(found).map(f => ({
      ...f,
      id: f.kind + ':' + f.start + ':' + f.end,
      text: text.slice(f.start, f.end),
    }));
  }

  // Applies accepted spans to a string. `style` decides what replaces them:
  // 'block' keeps the shape with █, 'label' names the kind, 'remove' deletes.
  function applyToText(text, spans, style) {
    const ordered = spans.slice().sort((a, b) => a.start - b.start);
    let out = '';
    let cursor = 0;
    for (const s of ordered) {
      if (s.start < cursor) continue;
      out += text.slice(cursor, s.start);
      if (style === 'label') out += '[' + String(s.kind || 'redacted').toUpperCase() + ']';
      else if (style === 'remove') out += '';
      else out += '█'.repeat(Math.max(1, s.end - s.start));
      cursor = s.end;
    }
    return out + text.slice(cursor);
  }

  root.BlackbarDetect = {
    findAll, findTerms, applyToText, resolveOverlaps,
    DETECTORS, luhnValid, ibanValid, mod97,
    KINDS: DETECTORS.map(d => ({ kind: d.kind, label: d.label, hint: d.hint })),
  };
})(typeof window !== 'undefined' ? window : globalThis);
