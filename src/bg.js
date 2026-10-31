import * as db from './db.js';
import { sanitizeCapture, mergeItem, uniqueMatch, absorb, search, coverage, indexDoc, savedAtOf } from './core.js';

const LINKEDIN = /^https:\/\/www\.linkedin\.com\//;
let cache = null;   // rebuilt from IndexedDB whenever needed; never the only copy

async function items() {
  if (!cache) cache = (await db.all()).map((it) => Object.assign(it, { _doc: indexDoc(it) }));
  return cache;
}
const invalidate = () => { cache = null; };

async function capture(raws) {
  if ((await chrome.storage.local.get('capture')).capture === false) return { error: 'paused', keys: [] };
  if (raws.length > 100) return { error: 'too many', keys: [] };
  const now = new Date().toISOString();
  const incoming = raws.map((r) => sanitizeCapture(r, now)).filter(Boolean);
  if (!incoming.length) return { stored: 0, keys: [] };
  const everything = await items();
  const fps = everything.filter((i) => i.key.startsWith('fp:'));
  const canon = everything.filter((i) => !i.key.startsWith('fp:'));
  // Pair records that describe the same post, in either direction; only a single clear match counts.
  const target = new Map();   // incoming key -> key it should live under
  const absorbs = new Map();  // destination key -> fingerprint key folded into it
  for (const inc of incoming) {
    if (inc.urn) {
      const fp = uniqueMatch(fps.filter((f) => ![...absorbs.values()].includes(f.key)), inc);
      if (fp) absorbs.set(inc.key, fp.key);
    } else {
      const c = uniqueMatch(canon, inc);
      if (c) target.set(inc.key, c.key);
    }
  }
  const keys = new Set([...incoming.map((i) => target.get(i.key) || i.key), ...absorbs.values()]);
  const res = await db.update([...keys], (cur) => {
    const out = new Map(), del = [];
    for (const raw of incoming) {
      const key = target.get(raw.key) || raw.key;
      const inc = { ...raw, key, urn: raw.urn || cur.get(key)?.urn };
      let base = out.get(key) || cur.get(key);
      const fpKey = absorbs.get(key);
      if (fpKey && cur.get(fpKey)) {
        base = base ? absorb(base, cur.get(fpKey), now) : { ...cur.get(fpKey), key, urn: inc.urn };
        del.push(fpKey);
      }
      if (!base && inc.status === 'unsaved') continue;   // unsaving something we never had
      const merged = mergeItem(base, inc, now);
      if (merged.urn && merged.sources.includes('saved-page')) merged.confirmed = true;
      delete merged._doc;
      out.set(key, merged);
    }
    return { put: [...out.values()], del };
  });
  invalidate();
  // tell the page which of its records are safely stored (by the key it sent)
  return { stored: res.put, merged: res.del, keys: incoming.map((i) => i.key) };
}

function compact(hit) {
  const { it, field } = hit;
  return {
    key: it.key, url: it.url, field, text: (it.text || '').slice(0, 600),
    author: it.author?.name || '', savedAt: savedAtOf(it), observed: !!it.observedSaveAt,
    title: it.preview?.title || '', tags: it.tags || [], note: it.note || '',
  };
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const fromExtension = sender.id === chrome.runtime.id;
  const fromLinkedIn = fromExtension && sender.tab && LINKEDIN.test(sender.tab.url || '') && sender.frameId === 0;
  const fromPage = fromExtension && (sender.url || '').startsWith(chrome.runtime.getURL('')) && !fromLinkedIn;
  (async () => {
    switch (msg?.type) {
      case 'capture':
        if (!fromLinkedIn || !Array.isArray(msg.items)) return { error: 'refused' };
        return capture(msg.items);
      case 'search': {
        if (!fromLinkedIn && !fromPage) return { error: 'refused' };
        const all = await items();
        const r = search(all, { q: String(msg.q || '').slice(0, 200), sort: msg.q ? 'relevance' : 'saved-new', limit: 30 });
        return { total: r.total, hits: r.hits.map(compact), coverage: coverage(all) };
      }
      case 'status': {
        const all = await items();
        return { coverage: coverage(all), capture: (await chrome.storage.local.get('capture')).capture !== false };
      }
      case 'opened':
        if (!fromLinkedIn && !fromPage) return { error: 'refused' };
        await db.update([String(msg.key)], (cur) => {
          const it = cur.get(String(msg.key));
          return { put: it ? [{ ...it, opens: (it.opens || 0) + 1, lastOpenedAt: new Date().toISOString() }] : [] };
        });
        invalidate();
        return { ok: true };
      case 'changed':
        if (fromPage) invalidate();
        return { ok: true };
      case 'openLibrary':
        await chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') + (msg.q ? `#q=${encodeURIComponent(String(msg.q).slice(0, 200))}` : '') });
        return { ok: true };
      default:
        return { error: 'unknown' };
    }
  })().then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('library/library.html') }));

// Tabs that were already open when the extension was installed, updated or re-enabled get the script now.
async function attachOpenTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  for (const tab of tabs) {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.__savedShelf?.version || null });
      if (r?.result === chrome.runtime.getManifest().version) continue;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content.js'] });
    } catch { /* tab discarded, crashed or not allowed */ }
  }
}
chrome.runtime.onInstalled.addListener(attachOpenTabs);
chrome.runtime.onStartup.addListener(attachOpenTabs);
// Re-enabling the extension doesn't fire onInstalled; the worker starting fresh does run this file.
attachOpenTabs();
