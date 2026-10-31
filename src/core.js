// Pure logic shared by the service worker and the library page. No DOM, no chrome.* calls.

export const ACTIVITY_RE = /urn:li:(activity|ugcPost|share):(\d{6,25})/;

// ---------- identity ----------

export function urnFrom(str) {
  if (!str) return null;
  let s = String(str);
  try { s = decodeURIComponent(s); } catch {}
  const m = s.match(ACTIVITY_RE);
  return m ? `urn:li:${m[1]}:${m[2]}` : null;   // ids stay strings, never Number()
}

// Only https LinkedIn (or plain https) links survive; everything else is dropped.
export function safeUrl(str) {
  if (!str) return null;
  try {
    const u = new URL(String(str).trim());
    if (u.protocol !== 'https:') return null;
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|trk|tracking|lipi|rcm)/i.test(p)) u.searchParams.delete(p);
    u.hash = '';
    return u.toString();
  } catch { return null; }
}

export function postUrl(urn) {
  return urn ? `https://www.linkedin.com/feed/update/${urn}/` : null;
}

// Author slug from a profile/company link: "/in/jane-doe/" -> "in/jane-doe"
export function authorSlug(href) {
  if (!href) return null;
  try {
    const p = new URL(href, 'https://www.linkedin.com').pathname.split('/').filter(Boolean);
    if ((p[0] === 'in' || p[0] === 'company' || p[0] === 'school') && p[1]) return `${p[0]}/${decodeURIComponent(p[1]).toLowerCase()}`;
  } catch {}
  return null;
}

// ---------- text ----------

export function cleanText(s) {
  return String(s || '').replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// Search form: NFKD, no accents, lower case, punctuation as space. Devanagari etc. survive.
export function norm(s) {
  return String(s || '').normalize('NFKD').replace(/\p{M}/gu, (m) => (/[ऀ-෿]/.test(m) ? m : ''))
    .toLowerCase().replace(/[^\p{L}\p{N}\p{M}#@+]+/gu, ' ').trim();
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}

export const prefixOf = (text) => norm(text).slice(0, 80);

// A post seen without an id (the new feed has none) gets a fingerprint key; it is merged into the
// real id later, when the same post shows up on the Saved page.
export function itemKey({ urn, url, author, text }) {
  if (urn) return urn;
  const fromUrl = urnFrom(url);
  if (fromUrl) return fromUrl;
  const p = norm(text);
  if (author?.slug && p.length >= 20) return `fp:${author.slug}:${hash(p)}`;
  if (url) return `url:${url}`;
  return null;
}

// ---------- merge ----------

const longer = (a, b) => ((b || '').length > (a || '').length ? b : a);

export function mergeItem(old, inc, now = new Date().toISOString()) {
  if (!old) {
    return {
      tags: [], note: '', opens: 0, status: 'saved', confirmed: false,
      firstSeenAt: now, lastSeenAt: now, sources: [],
      ...inc,
      sources: [...new Set(inc.sources || [])],
    };
  }
  const out = { ...old };
  out.urn = old.urn || inc.urn;
  out.url = old.urn ? old.url : inc.url || old.url;
  if (!out.url && out.urn) out.url = postUrl(out.urn);
  out.text = longer(old.text, inc.text);
  out.author = { ...(inc.author || {}), ...Object.fromEntries(Object.entries(old.author || {}).filter(([, v]) => v)) };
  out.preview = old.preview?.title ? old.preview : inc.preview || old.preview;
  out.kind = old.kind && old.kind !== 'post' ? old.kind : inc.kind || old.kind;
  out.observedSaveAt = old.observedSaveAt || inc.observedSaveAt;   // first observed save wins
  out.importedSavedAt = old.importedSavedAt || inc.importedSavedAt;
  out.importedPrecision = old.importedSavedAt ? old.importedPrecision : inc.importedPrecision;
  out.confirmed = !!(old.confirmed || inc.confirmed);
  if (inc.status) out.status = inc.status;
  if (inc.listRank != null && inc.rankSession) { out.listRank = inc.listRank; out.rankSession = inc.rankSession; }
  out.sources = [...new Set([...(old.sources || []), ...(inc.sources || [])])];
  out.lastSeenAt = now;
  out.firstSeenAt = old.firstSeenAt || now;
  return out;
}

// Best known save time: what we saw happen beats the export, both beat nothing. Never post age.
export function savedAtOf(it) {
  return it.observedSaveAt || it.importedSavedAt || null;
}

// Does fingerprint item `fp` describe the same post as `item`?
// The feed may cut a post short ("…more"), so the shorter text must be the opening of the longer one,
// and that opening must be long enough to mean something.
export function sameByFingerprint(fp, item) {
  if (!fp.author?.slug || fp.author.slug !== item.author?.slug) return false;
  const a = norm(fp.text), b = norm(item.text);
  const n = Math.min(a.length, b.length, 240);
  if (n < 40) return false;
  return a.slice(0, n) === b.slice(0, n);
}

// Exactly one candidate, or none: an ambiguous match stays as separate records.
export function uniqueMatch(candidates, item) {
  const m = candidates.filter((c) => sameByFingerprint(c, item));
  return m.length === 1 ? m[0] : null;
}

// Fold record `src` into `dst` without losing anything the user added to either.
export function absorb(dst, src, now) {
  const out = mergeItem(dst, { ...src, key: dst.key, urn: dst.urn || src.urn }, now);
  out.tags = [...new Set([...(dst.tags || []), ...(src.tags || [])])];
  out.note = [dst.note, src.note].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n');
  out.opens = (dst.opens || 0) + (src.opens || 0);
  out.lastOpenedAt = [dst.lastOpenedAt, src.lastOpenedAt].filter(Boolean).sort().pop();
  out.dismissedAt = dst.dismissedAt || src.dismissedAt;
  out.firstSeenAt = [dst.firstSeenAt, src.firstSeenAt].filter(Boolean).sort()[0] || now;
  return out;
}

// ---------- search ----------

export function parseQuery(q) {
  const phrases = [], terms = [];
  String(q || '').replace(/"([^"]+)"|(\S+)/g, (_, ph, t) => {
    const v = norm(ph || t);
    if (v) (ph ? phrases : terms).push(v);
    return '';
  });
  return { phrases, terms };
}

const FIELDS = [
  ['note', (it) => it.note, 4],
  ['title', (it) => it.preview?.title, 3],
  ['text', (it) => it.text, 2],
  ['author', (it) => `${it.author?.name || ''} ${it.author?.headline || ''}`, 2],
  ['tags', (it) => (it.tags || []).join(' '), 3],
  ['domain', (it) => it.preview?.domain, 1],
];

export function indexDoc(it) {
  const f = {};
  for (const [name, get] of FIELDS) f[name] = ' ' + norm(get(it)) + ' ';
  return f;
}

// Returns null when not matching, else { score, field }.
export function matchItem(doc, pq) {
  if (!pq.terms.length && !pq.phrases.length) return { score: 0, field: null };
  let score = 0, best = null, bestW = 0;
  const all = [...pq.terms.map((t) => [t, false]), ...pq.phrases.map((p) => [p, true])];
  for (const [needle, phrase] of all) {
    let hit = false;
    for (const [name, , w] of FIELDS) {
      const hay = doc[name];
      const i = hay.indexOf(phrase ? ` ${needle} ` : needle);
      const j = phrase && i < 0 ? hay.indexOf(needle) : i;
      if (j >= 0) {
        hit = true;
        const wordStart = hay[j - 1] === ' ';
        score += w * (wordStart ? 2 : 1);
        if (w > bestW) { bestW = w; best = name; }
      }
    }
    if (!hit) return null;   // AND across terms
  }
  return { score, field: best };
}

const t = (s) => (s ? Date.parse(s) : NaN);

export function compare(sort) {
  const tie = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const byTime = (get, dir) => (a, b) => {
    const x = t(get(a)), y = t(get(b));
    if (isNaN(x) && isNaN(y)) return tie(a, b);
    if (isNaN(x)) return 1;            // unknown dates last, whichever direction
    if (isNaN(y)) return -1;
    return (x - y) * dir || tie(a, b);
  };
  switch (sort) {
    case 'saved-old': return byTime(savedAtOf, 1);
    case 'author': return (a, b) => (a.author?.name || '￿').localeCompare(b.author?.name || '￿') || tie(a, b);
    case 'linkedin': return (a, b) => {
      const x = a.listRank ?? Infinity, y = b.listRank ?? Infinity;
      return x === y ? byTime(savedAtOf, -1)(a, b) : x - y;
    };
    case 'added': return byTime((i) => i.firstSeenAt, -1);
    case 'saved-new':
    default: return byTime(savedAtOf, -1);
  }
}

export function search(items, { q = '', sort = 'saved-new', shelf = 'all', author = null, hasText = false, limit = 500 } = {}) {
  const pq = parseQuery(q);
  const hits = [];
  for (const it of items) {
    if (shelf === 'unsaved' ? it.status !== 'unsaved' : it.status === 'unsaved' && shelf !== 'all-incl') continue;
    if (shelf === 'inbox' && it.tags?.length) continue;
    if (shelf.startsWith('tag:') && !it.tags?.includes(shelf.slice(4))) continue;
    if (author && it.author?.slug !== author) continue;
    if (hasText && !it.text) continue;
    const m = matchItem(it._doc || indexDoc(it), pq);
    if (m) hits.push({ it, ...m });
  }
  const cmp = compare(sort);
  if (sort === 'relevance' && (pq.terms.length || pq.phrases.length)) hits.sort((a, b) => b.score - a.score || cmp(a.it, b.it));
  else hits.sort((a, b) => cmp(a.it, b.it));
  return { total: hits.length, hits: hits.slice(0, limit) };
}

export function coverage(items) {
  const live = items.filter((i) => i.status !== 'unsaved');
  return {
    items: live.length,
    withText: live.filter((i) => i.text).length,
    withDate: live.filter((i) => savedAtOf(i)).length,
    unconfirmed: live.filter((i) => i.key.startsWith('fp:')).length,
    unsaved: items.length - live.length,
  };
}

// A few older saves never opened from here; stable within a day.
export function resurface(items, n = 3, today = new Date()) {
  const day = today.toISOString().slice(0, 10);
  const cutoff = today.getTime() - 14 * 864e5;
  const pool = items.filter((i) => i.status !== 'unsaved' && !i.opens && !i.dismissedAt && i.text &&
    (t(savedAtOf(i)) || t(i.firstSeenAt)) < cutoff);
  return pool.map((i) => [hash(day + i.key), i]).sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(0, n).map((x) => x[1]);
}

// ---------- import ----------

// RFC 4180-ish: quotes, doubled quotes, commas and newlines inside quotes, BOM, CRLF.
export function parseCSV(src) {
  const s = String(src).replace(/^﻿/, '');
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Dates: ISO and "YYYY-MM-DD HH:MM[:SS] [UTC]" are exact; a/b/YYYY needs the order (dmy|mdy).
export function parseDate(raw, order = null) {
  const s = String(raw || '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?)?$/i);
  if (m) {
    const [, y, mo, d, h, mi, se, tz] = m;
    if (!h) return valid(y, mo, d) ? { iso: `${y}-${mo}-${d}`, precision: 'date' } : null;
    const zone = !tz ? null : /^(z|utc|gmt)$/i.test(tz) ? 'Z' : tz.replace(/(\d{2})(\d{2})$/, '$1:$2');
    if (!valid(y, mo, d)) return null;
    // no zone given: keep it as a local time, say so in the precision
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${se || '00'}${zone || ''}`;
    return isNaN(Date.parse(iso)) ? null : { iso: new Date(iso).toISOString(), precision: zone ? 'instant' : 'local' };
  }
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const [, a, b, y] = m;
    const o = order || (+a > 12 ? 'dmy' : +b > 12 ? 'mdy' : null);
    if (!o) return { ambiguous: true };
    const [d, mo] = o === 'dmy' ? [a, b] : [b, a];
    const dd = d.padStart(2, '0'), mm = mo.padStart(2, '0');
    return valid(y, mm, dd) ? { iso: `${y}-${mm}-${dd}`, precision: 'date' } : null;
  }
  const ms = Date.parse(s);   // "Oct 3, 2024" and friends; treat as date-only to stay honest
  return isNaN(ms) ? null : { iso: new Date(ms).toISOString().slice(0, 10), precision: 'date' };
}

function valid(y, mo, d) {
  const dt = new Date(Date.UTC(+y, +mo - 1, +d));
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +mo - 1 && dt.getUTCDate() === +d;
}

// Guess which column is the link and which is the date, from the values, not the header names.
export function guessColumns(rows) {
  const [head, ...body] = rows;
  const sample = body.slice(0, 50);
  const score = (fn) => head.map((_, c) => sample.filter((r) => fn(r[c] || '')).length);
  const urlScore = score((v) => /^https?:\/\//i.test(v.trim()));
  const dateScore = score((v) => { const d = parseDate(v); return d && (d.iso || d.ambiguous); });
  const best = (arr) => { const m = Math.max(...arr); return m > 0 ? arr.indexOf(m) : -1; };
  const url = best(urlScore);
  const date = best(dateScore.map((v, i) => (i === url ? -1 : v)));
  const text = head.findIndex((h, i) => i !== url && i !== date && /text|content|title|comment/i.test(h));
  return { header: head, url, date, text };
}

export function dateOrderNeeded(rows, col) {
  if (col < 0) return false;
  return rows.slice(1).some((r) => parseDate(r[col])?.ambiguous);
}

// "/pulse/a-made-up-article-title-jane-doe-abc1x" -> "A made up article title jane doe"
export function titleFromUrl(link) {
  try {
    const seg = new URL(link).pathname.split('/').filter(Boolean).pop() || '';
    const words = decodeURIComponent(seg).replace(/-[a-z0-9]{4,6}$/i, '').split('-').filter(Boolean);
    const t = words.join(' ');
    return t ? t[0].toUpperCase() + t.slice(1) : link;
  } catch { return link; }
}

// rows -> { items, errors } ; errors carry row numbers only, never contents.
export function importRows(rows, { url, date, text = -1, order = null }) {
  const items = [], errors = [];
  rows.slice(1).forEach((r, i) => {
    const n = i + 2;
    const link = safeUrl(r[url]);
    if (!link) return errors.push({ row: n, why: 'link missing or not https' });
    const d = date >= 0 && r[date] ? parseDate(r[date], order) : null;
    if (date >= 0 && r[date] && (!d || d.ambiguous)) return errors.push({ row: n, why: 'date not understood' });
    const urn = urnFrom(link);
    const body = text >= 0 ? cleanText(r[text]) : '';
    const it = {
      urn, url: urn ? postUrl(urn) : link, text: body,
      kind: urn ? 'post' : /linkedin\.com\/pulse\//.test(link) ? 'article' : 'link',
      importedSavedAt: d?.iso, importedPrecision: d?.precision,
      sources: ['import'], confirmed: true,
    };
    if (!urn) it.preview = { title: titleFromUrl(link), domain: new URL(link).hostname.replace(/^www\./, '') };
    it.key = itemKey(it);
    items.push(it);
  });
  const seen = new Set();
  return { items: items.filter((x) => !seen.has(x.key) && seen.add(x.key)), errors };
}

// ---------- validation of what content scripts send ----------

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);

export function sanitizeCapture(raw, now = new Date().toISOString()) {
  if (!raw || typeof raw !== 'object') return null;
  const urn = urnFrom(str(raw.urn, 80));
  const url = safeUrl(str(raw.url, 600)) || (urn ? postUrl(urn) : null);
  const slugHref = str(raw.authorHref, 400);
  const it = {
    urn,
    url: url && /^https:\/\/(www\.)?linkedin\.com\//.test(url) ? url : urn ? postUrl(urn) : null,
    text: cleanText(str(raw.text, 20000)),
    author: {
      name: cleanText(str(raw.authorName, 120)) || undefined,
      headline: cleanText(str(raw.authorHeadline, 220)) || undefined,
      slug: authorSlug(slugHref) || undefined,
      href: slugHref ? safeUrl(new URL(slugHref, 'https://www.linkedin.com').href) || undefined : undefined,
    },
    preview: raw.previewTitle ? { title: cleanText(str(raw.previewTitle, 300)), domain: cleanText(str(raw.previewDomain, 100)) || undefined } : undefined,
    kind: ['post', 'article', 'link'].includes(raw.kind) ? raw.kind : raw.previewTitle ? 'link' : 'post',
    sources: [raw.source === 'save-click' ? 'save-click' : 'saved-page'],
  };
  if (raw.source === 'save-click') { it.observedSaveAt = now; it.status = 'saved'; }
  if (raw.source === 'saved-page') { it.confirmed = true; it.status = 'saved'; }
  if (raw.source === 'unsave-click') { it.status = 'unsaved'; it.sources = []; }
  if (Number.isInteger(raw.listRank) && raw.listRank >= 0 && raw.listRank < 1e6) { it.listRank = raw.listRank; it.rankSession = str(raw.rankSession, 40); }
  it.key = itemKey(it);
  return it.key ? it : null;
}
