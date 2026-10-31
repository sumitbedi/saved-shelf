import * as db from '../src/db.js';
import {
  search, coverage, indexDoc, resurface, savedAtOf, mergeItem, absorb, parseCSV, guessColumns, dateOrderNeeded,
  importRows, parseQuery, safeUrl, urnFrom,
} from '../src/core.js';

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, props = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter((k) => k != null && k !== false));
  return el;
};

const state = { q: '', sort: 'saved-new', shelf: 'all', author: null, limit: 60, open: new Set(), editing: null, picking: null };
let items = [];
let collections = [];

// ---------- data ----------

async function load() {
  items = (await db.all()).map((it) => Object.assign(it, { _doc: indexDoc(it) }));
  const meta = (await db.getMeta('collections')) || [];
  collections = [...new Set([...meta, ...items.flatMap((i) => i.tags || [])])].sort((a, b) => a.localeCompare(b));
}

async function save(list) {
  const clean = list.map(({ _doc, ...rest }) => rest);
  await db.putMany(clean);
  for (const it of list) it._doc = indexDoc(it);
  chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {});
}

// Edit one record from what's stored now, not from this page's possibly stale copy. If the record has
// moved (merged into LinkedIn's copy) or gone, reload instead of bringing it back.
async function patch(it, fn) {
  let fresh = null;
  await db.update([it.key], (cur) => {
    const c = cur.get(it.key);
    if (!c) return {};
    fresh = fn({ ...c });
    return { put: [fresh] };
  });
  chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {});
  if (!fresh) { toast('That post was updated in the background. Showing the latest.'); await load(); return; }
  Object.assign(it, fresh, { _doc: indexDoc(fresh) });
}

// Merge a batch (import, restore) against what's stored at commit time.
async function mergeStored(list, fn) {
  const keys = [...new Set(list.map((i) => i.key))];
  await db.update(keys, (cur) => ({ put: list.map((inc) => fn(cur.get(inc.key), inc)) }));
  chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {});
}

async function saveCollections() { await db.setMeta('collections', collections); }

const byKey = (k) => items.find((i) => i.key === k);

// ---------- render ----------

function render() {
  renderSide();
  const cov = coverage(items);
  const r = search(items, { q: state.q, sort: state.q && state.sort === 'saved-new' ? 'relevance' : state.sort, shelf: state.shelf, author: state.author, limit: state.limit });
  const list = $('#list');
  list.replaceChildren(...r.hits.map((x) => row(x.it, x.field)));
  $('#more').hidden = r.total <= state.limit;

  const chip = $('#author-chip');
  chip.hidden = !state.author;
  if (state.author) chip.textContent = items.find((i) => i.author?.slug === state.author)?.author?.name || state.author;

  const scope = $('#scope');
  if (!items.length) scope.textContent = '';
  else if (state.q || state.author || state.shelf !== 'all') scope.textContent = `${r.total} of ${cov.items} saves`;
  else scope.textContent = `${cov.items} saves · ${cov.withText} with text · ${cov.withDate} with a save date`;

  const again = $('#again');
  const picks = !state.q && !state.author && state.shelf === 'all' ? resurface(items, 3) : [];
  again.hidden = !picks.length;
  $('.again-row', again).replaceChildren(...picks.map(mini));

  const empty = $('#empty');
  empty.hidden = r.total > 0;
  if (r.total === 0) empty.replaceChildren(...(items.length ? noMatches() : firstRun()));
}

function renderSide() {
  const live = items.filter((i) => i.status !== 'unsaved');
  const counts = { all: live.length, inbox: live.filter((i) => !i.tags?.length).length, unsaved: items.length - live.length };
  for (const [k, v] of Object.entries(counts)) { const b = $(`[data-count="${k}"]`); if (b) b.textContent = v || ''; }
  $('#tags').replaceChildren(...collections.map((t) => h('button', { class: 'shelf', 'data-shelf': `tag:${t}` },
    h('span', {}, t), h('b', {}, String(live.filter((i) => i.tags?.includes(t)).length || '')))));
  document.querySelectorAll('.shelf').forEach((b) => b.setAttribute('aria-current', String(b.dataset.shelf === state.shelf)));
}

const fmt = (iso, withYear) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
function dateLabel(it) {
  const s = savedAtOf(it);
  const thisYear = (d) => new Date(d).getFullYear() === new Date().getFullYear();
  if (s) {
    const local = it.observedSaveAt ? 'You saved this here, so the time comes from this computer' :
      it.importedPrecision === 'date' ? 'Save date from LinkedIn’s export (day only)' : 'Save time from LinkedIn’s export';
    return h('span', { class: 'date', 'data-kind': 'saved', title: local }, `saved ${fmt(s, !thisYear(s))}`);
  }
  if (it.firstSeenAt) return h('span', { class: 'date', 'data-kind': 'seen', title: 'LinkedIn doesn’t show when you saved this. Import your data export to get the date.' }, fmt(it.firstSeenAt, !thisYear(it.firstSeenAt)));
  return h('span', { class: 'date', 'data-kind': 'none' }, 'date unknown');
}

// Highlight query words inside text, using text nodes only.
function marked(text, q) {
  const pq = parseQuery(q);
  const words = [...pq.terms, ...pq.phrases].filter((w) => w.length > 1);
  if (!words.length) return [text];
  const out = [];
  const lower = text.toLowerCase();
  const ranges = [];
  for (const w of words) {
    // match on the original text loosely: case-insensitive, accents left as typed
    let i = lower.indexOf(w);
    while (i >= 0) { ranges.push([i, i + w.length]); i = lower.indexOf(w, i + w.length); }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let at = 0;
  for (const [a, b] of ranges) { if (a < at) continue; out.push(text.slice(at, a), h('mark', {}, text.slice(a, b))); at = b; }
  out.push(text.slice(at));
  return out;
}

function row(it, field) {
  const open = state.open.has(it.key);
  const text = it.text || '';
  const li = h('li', { class: 'item', 'data-key': it.key });
  const authorBtn = it.author?.slug
    ? h('button', { class: 'link who', title: 'Show only this person', onclick: () => { state.author = it.author.slug; state.limit = 60; render(); } }, it.author.name || it.author.slug)
    : h('span', { class: 'who' }, it.author?.name || 'Unknown author');
  li.append(h('div', { class: 'meta' }, authorBtn, it.author?.headline ? h('span', { class: 'headline' }, it.author.headline) : null,
    it.key.startsWith('fp:') ? h('span', { class: 'badge', title: 'Kept when you saved it. It joins up with LinkedIn’s copy the next time it appears on your Saved page.' }, 'kept from feed') : null,
    it.status === 'unsaved' ? h('span', { class: 'badge' }, 'unsaved on LinkedIn') : null,
    dateLabel(it)));
  if (it.note && state.editing !== it.key) li.append(h('div', { class: 'note' }, ...marked(it.note, state.q)));
  if (text) {
    const p = h('p', { class: open ? 'body' : 'body clamp' }, ...marked(text, state.q));
    li.append(p);
  } else {
    li.append(h('p', { class: 'body missing' }, it.preview?.title ? '' : 'No text yet. Open your Saved page on LinkedIn and this fills in when the post shows up.'));
  }
  if (it.preview?.title) li.append(h('div', { class: 'preview' }, ...marked(it.preview.title, state.q), it.preview.domain ? h('small', {}, it.preview.domain) : null));
  if (state.editing === it.key) li.append(noteEditor(it));
  if (state.picking === it.key) li.append(picker(it));

  const acts = h('div', { class: 'row-acts' });
  const url = safeUrl(it.url);
  if (url) acts.append(h('a', { href: url, target: '_blank', rel: 'noopener', onclick: () => opened(it) }, 'Open on LinkedIn'));
  if (text.length > 280) acts.append(h('button', { onclick: () => { open ? state.open.delete(it.key) : state.open.add(it.key); render(); } }, open ? 'Less' : 'More'));
  acts.append(h('button', { onclick: () => { state.editing = state.editing === it.key ? null : it.key; render(); } }, it.note ? 'Edit note' : 'Add a note'));
  acts.append(h('button', { onclick: () => { state.picking = state.picking === it.key ? null : it.key; render(); } }, 'Collections'));
  for (const t of it.tags || []) acts.append(h('span', { class: 'tag' }, t));
  acts.append(removeBtn(it));
  li.append(acts);
  return li;
}

function removeBtn(it) {
  const b = h('button', { style: 'margin-left:auto' }, 'Remove');
  b.onclick = () => {
    const sure = h('span', { style: 'margin-left:auto;display:flex;gap:10px;font-size:12.5px;color:var(--ink-3)' },
      'Remove from Shelf? It stays saved on LinkedIn.',
      h('button', { onclick: async () => { await db.remove([it.key]); items = items.filter((i) => i !== it); chrome.runtime.sendMessage({ type: 'changed' }).catch(() => {}); render(); } }, 'Remove'),
      h('button', { onclick: () => render() }, 'Keep'));
    b.replaceWith(sure);
  };
  return b;
}

function noteEditor(it) {
  const ta = h('textarea', { class: 'note-edit', placeholder: 'Why did you save this? One line is enough.', maxLength: 1000, value: it.note || '' });
  let saving = false;
  const done = async () => {
    if (saving) return; saving = true;
    const note = ta.value.trim().slice(0, 1000);
    state.editing = null;
    await patch(it, (c) => ({ ...c, note }));
    render();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); done(); }
    if (e.key === 'Escape') { state.editing = null; render(); }
  });
  ta.addEventListener('blur', done);
  queueMicrotask(() => ta.focus());
  return ta;
}

function picker(it) {
  const wrap = h('div', { class: 'picker', role: 'group', 'aria-label': 'Collections' });
  if (!collections.length) wrap.append(h('span', { class: 'hint' }, 'Make a collection in the sidebar first.'));
  for (const t of collections) {
    const on = it.tags?.includes(t);
    wrap.append(h('button', { 'aria-pressed': String(!!on), onclick: async () => {
      await patch(it, (c) => ({ ...c, tags: on ? (c.tags || []).filter((x) => x !== t) : [...new Set([...(c.tags || []), t])] }));
      render();
    } }, t));
  }
  return wrap;
}

function mini(it) {
  return h('div', { class: 'card-mini' },
    h('span', { class: 'who' }, it.author?.name || 'Unknown author'),
    h('p', {}, it.note || it.text),
    h('div', { class: 'row-acts acts' },
      safeUrl(it.url) ? h('a', { href: safeUrl(it.url), target: '_blank', rel: 'noopener', onclick: () => opened(it) }, 'Open') : null,
      h('button', { onclick: async () => { await patch(it, (c) => ({ ...c, dismissedAt: new Date().toISOString() })); render(); } }, 'Not now')));
}

async function opened(it) {
  await patch(it, (c) => ({ ...c, opens: (c.opens || 0) + 1, lastOpenedAt: new Date().toISOString() }));
  setTimeout(render, 300);
}

function noMatches() {
  const q = state.q;
  return [h('h2', {}, q ? `Nothing for “${q}” on your shelf` : 'Nothing here yet'),
    h('p', {}, q ? 'Shelf can only search posts it has seen. Older saves get added when you open your Saved page on LinkedIn and scroll, or import your data export for their links and dates.'
      : state.shelf.startsWith('tag:') ? 'Use Collections on any post to file it here.' : 'Nothing matches these filters.')];
}

function firstRun() {
  return [h('h2', {}, 'Your saved posts, findable'),
    h('p', {}, 'Shelf keeps a private copy of what you save on LinkedIn, so you can search it, sort it by when you saved it and file it into collections. Everything stays on this computer.'),
    h('ol', { class: 'ways' },
      h('li', {}, h('b', {}, 'Save posts the way you already do'), h('span', {}, 'Each one is kept with its text and the time you saved it.')),
      h('li', {}, h('b', {}, 'Open your Saved page on LinkedIn'), h('span', {}, 'Posts LinkedIn shows you there are added. A search box appears at the top.')),
      h('li', {}, h('b', {}, 'Import your LinkedIn data export'), h('span', {}, 'Adds the link and save date of every post you ever saved.'))),
    h('p', { style: 'margin-top:18px' },
      h('a', { class: 'btn', href: 'https://www.linkedin.com/my-items/saved-posts/', target: '_blank', rel: 'noopener' }, 'Open my Saved page'), ' ',
      h('button', { class: 'btn secondary', onclick: () => showImport() }, 'Import'))];
}

// ---------- import ----------

function showImport() { $('#import').hidden = false; $('#import').scrollIntoView({ block: 'nearest' }); }

async function onFile(file) {
  const box = $('#mapping');
  box.hidden = false;
  if (file.size > 30e6) { box.replaceChildren(h('p', { class: 'sum' }, 'That file is over 30 MB. Pick just the saved items file from the export, not the whole archive.')); return; }
  const rows = parseCSV(await file.text());
  if (rows.length < 2) { box.replaceChildren(h('p', { class: 'sum' }, 'That file has no rows.')); return; }
  const g = guessColumns(rows);
  const pick = (label, val, allowNone) => h('label', {}, `${label} `, h('select', { 'data-col': label },
    allowNone ? h('option', { value: -1 }, 'none') : null,
    ...g.header.map((name, i) => h('option', { value: i, selected: i === val }, name || `column ${i + 1}`))));
  const cols = h('div', { class: 'cols' }, pick('Link', g.url), pick('Saved date', g.date, true), pick('Text', g.text, true));
  const order = h('label', { hidden: true }, 'Dates are written ', h('select', { id: 'order' },
    h('option', { value: 'dmy' }, 'day/month/year'), h('option', { value: 'mdy' }, 'month/day/year')));
  const sum = h('p', { class: 'sum' });
  const table = h('table');
  const go = h('button', { class: 'btn' }, 'Import');
  box.replaceChildren(cols, order, table, sum, go);
  const sel = () => {
    const v = (l) => +cols.querySelector(`[data-col="${l}"]`).value;
    return { url: v('Link'), date: v('Saved date'), text: v('Text'), order: order.hidden ? null : $('#order').value };
  };
  let result;
  const preview = () => {
    const m = sel();
    order.hidden = !dateOrderNeeded(rows, m.date);
    m.order = order.hidden ? null : $('#order').value;
    result = importRows(rows, m);
    const known = new Set(items.map((i) => i.key));
    const fresh = result.items.filter((i) => !known.has(i.key)).length;
    table.replaceChildren(h('tr', {}, h('th', {}, 'Link'), h('th', {}, 'Saved')),
      ...result.items.slice(0, 4).map((i) => h('tr', {}, h('td', {}, i.url), h('td', {}, i.importedSavedAt ? i.importedSavedAt.slice(0, 16).replace('T', ' ') : '—'))));
    sum.textContent = `${result.items.length} saves found: ${fresh} new, ${result.items.length - fresh} already on your shelf (they get their save date).` +
      (result.errors.length ? ` ${result.errors.length} rows skipped (rows ${result.errors.slice(0, 5).map((e) => e.row).join(', ')}${result.errors.length > 5 ? '…' : ''}).` : '') +
      (m.date < 0 ? ' No date column chosen, so these won’t sort by save date.' : '');
    go.disabled = !result.items.length;
  };
  box.addEventListener('change', preview);
  preview();
  go.onclick = async () => {
    go.disabled = true;
    const now = new Date().toISOString();
    await mergeStored(result.items, (old, inc) => mergeItem(old, inc, now));
    await load();
    toast(`Imported ${result.items.length} saves`);
    $('#import').hidden = true; box.hidden = true;
    render();
  };
}

// ---------- backup ----------

async function exportJSON() {
  const data = { app: 'shelf', version: 1, exportedAt: new Date().toISOString(), collections, items: items.map(({ _doc, ...r }) => r) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  h('a', { href: url, download: `shelf-backup-${data.exportedAt.slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function restoreJSON(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'shelf' || !Array.isArray(data.items)) throw new Error('not a Shelf backup');
    const now = new Date().toISOString();
    const ok = data.items.filter((i) => i && typeof i.key === 'string' && i.key.length < 300).map((i) => ({
      key: i.key, urn: urnFrom(i.urn) || undefined, url: safeUrl(i.url) || undefined,
      text: typeof i.text === 'string' ? i.text.slice(0, 20000) : '',
      author: i.author && typeof i.author === 'object' ? { name: String(i.author.name || '').slice(0, 120) || undefined, slug: String(i.author.slug || '').slice(0, 120) || undefined, headline: String(i.author.headline || '').slice(0, 220) || undefined } : {},
      preview: i.preview?.title ? { title: String(i.preview.title).slice(0, 300), domain: String(i.preview.domain || '').slice(0, 100) || undefined } : undefined,
      kind: ['post', 'article', 'link'].includes(i.kind) ? i.kind : 'post',
      observedSaveAt: isNaN(Date.parse(i.observedSaveAt)) ? undefined : i.observedSaveAt,
      importedSavedAt: isNaN(Date.parse(i.importedSavedAt)) ? undefined : i.importedSavedAt,
      status: i.status === 'unsaved' ? 'unsaved' : 'saved', sources: ['backup'],
      tags: Array.isArray(i.tags) ? i.tags.filter((t) => typeof t === 'string').map((t) => t.slice(0, 40)).slice(0, 30) : [],
      note: typeof i.note === 'string' ? i.note.slice(0, 1000) : '',
    }));
    await mergeStored(ok, (old, inc) => (old ? absorb(old, inc, now) : mergeItem(null, inc, now)));
    if (Array.isArray(data.collections)) { collections = [...new Set([...collections, ...data.collections.filter((c) => typeof c === 'string')])]; await saveCollections(); }
    await load(); render();
    toast(`Restored ${ok.length} saves`);
  } catch (e) { toast(`Couldn’t restore: ${e.message}`); }
}

// ---------- wiring ----------

let toastT = 0;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 2400); }

function wire() {
  const q = $('#q');
  let t = 0;
  q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { state.q = q.value.trim(); state.limit = 60; render(); }, 60); });
  q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { q.value = ''; state.q = ''; render(); } });
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); q.focus(); }
  });
  $('#sort').onchange = (e) => { state.sort = e.target.value; render(); };
  $('#author-chip').onclick = () => { state.author = null; render(); };
  $('.side nav').addEventListener('click', (e) => {
    const b = e.target.closest('.shelf'); if (!b) return;
    state.shelf = b.dataset.shelf; state.limit = 60; render();
  });
  $('#new-tag').onsubmit = async (e) => {
    e.preventDefault();
    const name = e.target.t.value.trim().slice(0, 40);
    if (name && !collections.includes(name)) { collections.push(name); collections.sort((a, b) => a.localeCompare(b)); await saveCollections(); }
    e.target.reset(); state.shelf = name ? `tag:${name}` : state.shelf; render();
  };
  $('#more').onclick = () => { state.limit += 60; render(); };
  $('#open-import').onclick = showImport;
  $('[data-close="import"]').onclick = () => { $('#import').hidden = true; };
  $('#file').onchange = (e) => e.target.files[0] && onFile(e.target.files[0]);
  $('#export').onclick = exportJSON;
  $('#restore').onchange = (e) => e.target.files[0] && restoreJSON(e.target.files[0]);
  const cap = $('#capture');
  chrome.storage.local.get('capture').then((r) => { cap.checked = r.capture !== false; });
  cap.onchange = () => { chrome.storage.local.set({ capture: cap.checked }); toast(cap.checked ? 'Shelf will keep posts you save' : 'Paused. Shelf won’t read LinkedIn until you turn this back on'); };
  // pick up posts saved in other tabs
  document.addEventListener('visibilitychange', async () => { if (!document.hidden) { await load(); render(); } });
  const m = location.hash.match(/q=([^&]*)/);
  if (m) { q.value = decodeURIComponent(m[1]); state.q = q.value.trim(); }
}

wire();
await load();
render();
