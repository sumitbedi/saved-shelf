// Runs on www.linkedin.com. Two jobs, both passive:
//  1. When you click Save (or Unsave) on a post, keep that post's text, author and link.
//  2. On your Saved page, remember the cards LinkedIn has already shown and add a search box.
// It never clicks anything, never loads more results, never hides or moves LinkedIn's own cards.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const prev = globalThis.__savedShelf;
  if (prev && prev.version === VERSION && prev.alive()) return;
  try { prev?.stop(); } catch {}

  const ADAPTER = 'saved-v1+feed-v1';
  let alive = true;
  const cleanups = [];
  const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); cleanups.push(() => el.removeEventListener(ev, fn, opt)); };

  function stop() {
    alive = false;
    cleanups.splice(0).forEach((f) => { try { f(); } catch {} });
    unmountSaved();
  }
  globalThis.__savedShelf = { version: VERSION, stop, alive: () => alive };

  // A disabled/updated extension leaves this script behind with a dead connection: stop quietly.
  async function send(msg) {
    if (!alive) return null;
    try { return await chrome.runtime.sendMessage(msg); }
    catch (e) { if (/context invalidated|Receiving end/i.test(String(e))) stop(); return null; }
  }

  // The library's "Keep posts automatically" switch.
  let enabled = false;   // until we know the switch is on
  chrome.storage.local.get('capture').then((r) => { enabled = r.capture !== false; route(); }, () => {});
  const onStore = (c) => { if (c.capture) { enabled = c.capture.newValue !== false; route(); } };
  chrome.storage.onChanged.addListener(onStore);
  cleanups.push(() => chrome.storage.onChanged.removeListener(onStore));

  // ---------- reading a post ----------

  const URN_RE = /urn:li:(activity|ugcPost|share):\d{6,25}/;
  const text = (el) => (el ? readText(el) : '');

  // Text of the delivered nodes, with line breaks, minus buttons and screen-reader duplicates.
  function readText(el) {
    const c = el.cloneNode(true);
    c.querySelectorAll('button, .visually-hidden, [aria-hidden="true"].visually-hidden, script, style').forEach((n) => n.remove());
    c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    c.querySelectorAll('p, div, li').forEach((b) => b.append('\n'));
    return c.textContent.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').trim();
  }

  // Only elements that belong to `card` itself, not to a post embedded inside it (a repost).
  const own = (card, sel) => [...card.querySelectorAll(sel)].filter((el) => el.closest(CARD) === card);

  function urnOf(card) {
    for (const el of [card, ...own(card, '[data-urn], [data-id], [data-chameleon-result-urn]')].slice(0, 30)) {
      for (const a of ['data-urn', 'data-id', 'data-chameleon-result-urn']) {
        const m = (el.getAttribute?.(a) || '').match(URN_RE);
        if (m) return m[0];
      }
    }
    const ids = new Set(own(card, 'a[href*="urn:li:"]').map((a) => (decodeURIComponent(a.getAttribute('href') || '').match(URN_RE) || [])[0]).filter(Boolean));
    return ids.size === 1 ? [...ids][0] : null;   // two different ids in one post: don't guess
  }

  function authorOf(card) {
    for (const a of own(card, 'a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]')) {
      const name = a.querySelector('span[aria-hidden="true"]')?.textContent.trim() ||
        [...a.querySelectorAll('span')].map((s) => s.textContent.trim()).find((t) => t && t.length < 100) ||
        a.textContent.trim().split('\n')[0];
      if (name && !a.querySelector('img:only-child')) return { authorName: name.replace(/\s+/g, ' ').slice(0, 120), authorHref: a.getAttribute('href') };
    }
    return {};
  }

  const BODY = [
    '[data-testid="expandable-text-box"]',          // 2026 feed
    '.update-components-text', '.feed-shared-inline-show-more-text', '.feed-shared-update-v2__description',
    'p.entity-result__content-summary',              // a card on the Saved page itself
  ];

  function readPost(card, source) {
    const body = BODY.map((s) => own(card, s)[0]).find(Boolean);
    const urn = urnOf(card);
    return { source, urn, url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : undefined, text: text(body), ...authorOf(card) };
  }

  // ---------- 1. save-time capture ----------

  const CARD = '[data-urn], [data-id^="urn:li:"], [role="listitem"], article, .feed-shared-update-v2, li:has([data-chameleon-result-urn])';
  let lastTrigger = null;   // { card, at }
  let lastSent = { key: '', at: 0 };

  const iconId = (el) => el.getAttribute('id') || el.getAttribute('data-test-icon') || el.getAttribute('type') || '';
  function menuAction(path) {
    const item = path.find((n) => n.getAttribute?.('role') === 'menuitem' || n.matches?.('.artdeco-dropdown__item, [role="menu"] li'));
    if (!item) return null;
    const icon = item.querySelector('svg[id], [data-test-icon], li-icon[type]');
    const id = icon ? iconId(icon) : '';
    if (/^bookmark-outline/.test(id)) return 'save';
    if (/^bookmark-fill/.test(id)) return 'unsave';
    return null;
  }

  function ownerCard() {
    // The menu is drawn elsewhere in the page. Its owner is the post whose menu button is open now;
    // if more than one is open we can't tell, so we keep nothing.
    const open = [...document.querySelectorAll('button[aria-expanded="true"]')]
      .map((b) => b.closest(CARD)).filter((c) => c && !c.closest('header, nav'));
    const cards = [...new Set(open)];
    if (cards.length === 1) return cards[0];
    if (cards.length > 1) return null;
    // Some menus mark the button closed before the click lands: accept only the menu opened
    // moments ago, on this same page, whose post is still there.
    const t = lastTrigger;
    if (t && Date.now() - t.at < 8000 && t.href === location.href && t.card.isConnected) return t.card;
    return null;
  }

  async function onActivate(e) {
    if (!e.isTrusted || !alive || !enabled) return;
    const path = e.composedPath().filter((n) => n.nodeType === 1);
    const trigger = path.find((n) => n.tagName === 'BUTTON' && n.hasAttribute('aria-expanded'));
    if (trigger) { const card = trigger.closest(CARD); lastTrigger = card ? { card, at: Date.now(), href: location.href } : null; }
    const act = menuAction(path);
    if (!act) return;
    const card = ownerCard();
    if (!card) return toast('Saved on LinkedIn. Shelf couldn’t tell which post, so it wasn’t kept.');
    const raw = readPost(card, act === 'save' ? 'save-click' : 'unsave-click');
    const sig = act + (raw.urn || raw.authorHref + raw.text.slice(0, 60));
    if (sig === lastSent.key && Date.now() - lastSent.at < 2000) return;   // keyboard + click double fire
    lastSent = { key: sig, at: Date.now() };
    if (act === 'save' && !raw.urn && raw.text.length < 20) return toast('Saved on LinkedIn. This post has no text Shelf can read.');
    lastTrigger = null;
    const r = await send({ type: 'capture', items: [raw] });
    if (act === 'save') toast(r?.keys?.length ? 'Kept on your shelf' : 'Shelf couldn’t keep this one. It’s still saved on LinkedIn.');
  }
  on(document, 'click', onActivate, true);
  // keyboard: only when the focused element is itself the menu item
  on(document, 'keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target?.getAttribute?.('role') === 'menuitem') onActivate(e); }, true);

  // ---------- small toast, our own element, gone in 2.4 s ----------

  let toastHost = null, toastTimer = 0;
  function toast(msg) {
    if (!alive) return;
    if (!toastHost) {
      toastHost = document.createElement('saved-shelf-toast');
      const sh = toastHost.attachShadow({ mode: 'open' });
      sh.innerHTML = `<style>
        div{position:fixed;left:24px;bottom:24px;z-index:2147483000;font:500 13px/1.3 -apple-system,system-ui,sans-serif;
        color:#f6f6f4;background:#1d1d1f;padding:10px 14px;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.18);
        opacity:0;transform:translateY(6px);transition:opacity .2s,transform .2s;pointer-events:none;max-width:360px}
        div.on{opacity:1;transform:none}</style><div role="status" aria-live="polite"></div>`;
      document.documentElement.append(toastHost);
      cleanups.push(() => toastHost?.remove());
    }
    const d = toastHost.shadowRoot.querySelector('div');
    d.textContent = msg;
    requestAnimationFrame(() => d.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => d.classList.remove('on'), 2400);
  }

  // ---------- 2. the Saved page ----------

  const isSaved = () => /^\/my-items\/saved-posts\/?$/.test(location.pathname);
  let saved = null;   // { host, observer, sent: Map, session }

  // A refresh draws Saved in this document. Arriving by a link from the home page draws it in LinkedIn's
  // same-origin /preload/ frame instead, while the address bar still says /my-items/saved-posts/.
  function savedRoot() {
    const docs = [document, ...[...document.querySelectorAll('iframe[src^="/preload/"]')].map((f) => f.contentDocument)];
    for (const d of docs) {
      const root = d?.querySelector('main .scaffold-finite-scroll__content');
      if (root) return root;
    }
    return null;
  }

  function scope() {
    const t = new URLSearchParams(location.search).get('savedPostType');
    return t ? t.toUpperCase() : 'ALL';
  }

  function parseSavedCard(card) {
    const urn = card.getAttribute('data-chameleon-result-urn') || '';
    if (!URN_RE.test(urn)) return null;
    const li = card.closest('li') || card;
    const actor = li.querySelector('.entity-result__content-actor');
    const link = actor?.querySelector('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]');
    const nameEl = link && ([...link.querySelectorAll('span')].find((s) => !s.classList.contains('visually-hidden') && !s.querySelector('span') && s.textContent.trim()));
    const headline = actor?.querySelector('.t-14.t-normal, .entity-result__primary-subtitle');
    const body = li.querySelector('p.entity-result__content-summary') ||
      li.querySelector('.entity-result__content-inner-container--right-padding .linked-area > p');
    const pTitle = li.querySelector('.entity-result__embedded-object-title');
    const pSub = li.querySelector('.entity-result__embedded-object-sub-title');
    const perma = [...li.querySelectorAll('a[href*="/feed/update/"]')].find((a) => decodeURIComponent(a.href).includes(urn));
    return {
      source: 'saved-page', urn: urn.match(URN_RE)[0],
      url: perma ? perma.href : undefined,
      text: text(body),
      authorName: nameEl?.textContent.trim(), authorHref: link?.getAttribute('href'),
      authorHeadline: headline?.textContent.trim(),
      previewTitle: pTitle?.textContent.trim() || undefined, previewDomain: pSub?.textContent.trim() || undefined,
      kind: pTitle ? (scope() === 'ARTICLES' ? 'article' : 'link') : 'post',
    };
  }

  function scanSaved() {
    if (!saved) return;
    const root = savedRoot();
    const cards = root ? [...root.querySelectorAll('[data-chameleon-result-urn]')] : [];
    const batch = [], order = [];
    for (const c of cards) {
      const p = parseSavedCard(c);
      if (!p || order.includes(p.urn)) continue;
      order.push(p.urn);
      if (scope() === 'ALL') { p.listRank = order.length - 1; p.rankSession = saved.session; }
      p.sig = `${p.text.length}|${p.authorName}|${p.previewTitle}|${p.listRank}`;
      if (saved.sent.get(p.urn) === p.sig || saved.pending.has(p.urn)) continue;
      batch.push(p);
    }
    saved.seen = order.length;
    if (!batch.length) return refreshStatus();
    const mine = saved;
    for (let i = 0; i < batch.length; i += 50) {
      const chunk = batch.slice(i, i + 50);
      chunk.forEach((p) => mine.pending.add(p.urn));
      send({ type: 'capture', items: chunk.map(({ sig, ...rest }) => rest) }).then((r) => {
        chunk.forEach((p) => mine.pending.delete(p.urn));
        const ok = new Set(r?.keys || []);
        chunk.forEach((p) => ok.has(p.urn) && mine.sent.set(p.urn, p.sig));
        if (r?.error && r.error !== 'paused') mine.failed = true;   // retried on the next change or tick
        refreshStatus();
      });
    }
  }

  function mountSaved() {
    if (saved || !isSaved()) return;
    const root = savedRoot();
    if (!root) return false;
    saved = { sent: new Map(), pending: new Set(), session: `${Date.now().toString(36)}`, seen: 0, root };
    const scroller = root.closest('.scaffold-finite-scroll') || root;
    const host = document.createElement('saved-shelf-search');
    saved.host = host;
    buildSearch(host);
    scroller.parentElement.insertBefore(host, scroller);
    let t = 0;
    saved.observer = new MutationObserver((muts) => {
      if (muts.every((m) => host.contains(m.target))) return;
      clearTimeout(t); t = setTimeout(scanSaved, 350);
    });
    saved.observer.observe(root, { childList: true, subtree: true, characterData: true });
    scanSaved();
    return true;
  }

  function unmountSaved() {
    if (!saved) return;
    saved.observer?.disconnect();
    saved.host?.remove();
    saved = null;
  }

  // LinkedIn is a single-page app: watch the address, not just page loads. Mounting is a cheap
  // querySelector, so we simply retry while on Saved until LinkedIn has drawn the list.
  let lastHref = '';
  function route() {
    if (!alive) return;
    if (location.href !== lastHref) { lastHref = location.href; unmountSaved(); }
    if (!enabled) { unmountSaved(); return; }
    if (saved && (!saved.host.isConnected || !saved.root.isConnected ||
      saved.root !== savedRoot())) unmountSaved();
    if (saved?.failed) { saved.failed = false; scanSaved(); }
    if (isSaved() && !saved) mountSaved();
  }
  const tick = setInterval(route, 700);
  cleanups.push(() => clearInterval(tick));
  on(window, 'pageshow', route);

  // ---------- the search box on the Saved page ----------

  const CSS = `
  :host{all:initial;display:block;margin:0 0 12px;font:14px/1.45 -apple-system,system-ui,"Segoe UI",sans-serif;color:#1d1d1f}
  .box{background:#fff;border:1px solid #e3e3e0;border-radius:12px;padding:12px 14px}
  .row{display:flex;gap:10px;align-items:center}
  input{flex:1;min-width:0;font:inherit;font-size:15px;padding:9px 12px;border:1px solid #d6d6d2;border-radius:9px;outline:none;background:#fafaf8;color:inherit}
  input:focus{border-color:#1d1d1f;background:#fff;box-shadow:0 0 0 3px rgba(29,29,31,.08)}
  button{font:inherit;font-size:13px;border:0;background:none;color:#5f5f5b;cursor:pointer;padding:6px 8px;border-radius:7px;white-space:nowrap}
  button:hover,button:focus-visible{background:#f0f0ed;color:#1d1d1f;outline:none}
  .scope{margin:6px 2px 0;font-size:11px;line-height:1.3;color:#7a7a75}
  ol{list-style:none;margin:10px 0 0;padding:0;display:grid;gap:2px}
  li a{display:block;padding:9px 10px;border-radius:9px;color:inherit;text-decoration:none}
  li a:hover,li a:focus-visible{background:#f4f4f1;outline:none}
  .who{font-weight:600;font-size:13px}
  .when{color:#8a8a85;font-weight:400;margin-left:6px}
  .snip{color:#44443f;font-size:13.5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  mark{background:#fff1a8;color:inherit;border-radius:2px}
  .empty{padding:10px;color:#7a7a75;font-size:13px}`;

  function buildSearch(host) {
    const sh = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style'); style.textContent = CSS;
    const box = document.createElement('div'); box.className = 'box';
    box.innerHTML = `<div class="row">
        <input type="search" aria-label="Search your saved posts" placeholder="Search your saved posts" autocomplete="off" spellcheck="false">
        <button type="button" class="lib">Open library</button>
      </div>
      <p class="scope" aria-live="polite"></p><ol hidden></ol>`;
    sh.append(style, box);
    const input = box.querySelector('input'), list = box.querySelector('ol'), sc = box.querySelector('.scope');
    box.querySelector('.lib').onclick = () => send({ type: 'openLibrary', q: input.value });
    let gen = 0, t = 0;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 90); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; run(); }
      if (e.key === 'ArrowDown') { list.querySelector('a')?.focus(); e.preventDefault(); }
      e.stopPropagation();   // keep LinkedIn's own shortcuts out of our input
    });
    list.addEventListener('keydown', (e) => {
      const links = [...list.querySelectorAll('a')], i = links.indexOf(sh.activeElement);
      if (e.key === 'ArrowDown') { links[i + 1]?.focus(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { (links[i - 1] || input).focus(); e.preventDefault(); }
      e.stopPropagation();
    });
    async function run() {
      const my = ++gen, q = input.value.trim();
      if (!q) { list.hidden = true; list.replaceChildren(); refreshStatus(); return; }
      const r = await send({ type: 'search', q });
      if (my !== gen || !r || r.error) return;   // a newer keystroke won
      list.hidden = false;
      list.replaceChildren(...(r.hits.length ? r.hits.slice(0, 8).map((h) => resultRow(h, q)) : [emptyRow()]));
      sc.textContent = `${r.total} ${r.total === 1 ? 'match' : 'matches'} in ${postCount(r.coverage.items)}` +
        (r.total > 8 ? ' · Open library for all' : '');
    }
    host.refresh = (cov) => {
      if (input.value.trim()) return;
      sc.textContent = cov ? `Searching in ${postCount(cov.items)}` : '';
    };
  }

  const postCount = (n) => `${n} ${n === 1 ? 'post' : 'posts'}`;

  function emptyRow() {
    const li = document.createElement('li'); li.className = 'empty';
    li.textContent = 'No matches in the posts on your shelf yet.';
    return li;
  }

  function highlight(el, s, q) {
    const words = q.toLowerCase().replace(/"/g, '').split(/\s+/).filter((w) => w.length > 1);
    const lower = s.toLowerCase();
    let i = 0, first = -1;
    for (const w of words) { const j = lower.indexOf(w); if (j >= 0 && (first < 0 || j < first)) first = j; }
    const start = first > 80 ? s.lastIndexOf(' ', first - 40) + 1 : 0;
    const part = (start ? '… ' : '') + s.slice(start, start + 240);
    const pl = part.toLowerCase();
    const marks = [];
    for (const w of words) { let j = pl.indexOf(w); while (j >= 0) { marks.push([j, j + w.length]); j = pl.indexOf(w, j + w.length); } }
    marks.sort((a, b) => a[0] - b[0]);
    for (const [a, b] of marks) {
      if (a < i) continue;
      el.append(part.slice(i, a));
      const m = document.createElement('mark'); m.textContent = part.slice(a, b); el.append(m);
      i = b;
    }
    el.append(part.slice(i));
  }

  function resultRow(h, q) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = /^https:\/\/www\.linkedin\.com\//.test(h.url || '') ? h.url : '#';
    a.target = '_blank'; a.rel = 'noopener';
    const who = document.createElement('div'); who.className = 'who'; who.textContent = h.author || 'Unknown author';
    if (h.savedAt) { const w = document.createElement('span'); w.className = 'when'; w.textContent = 'saved ' + new Date(h.savedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); who.append(w); }
    const snip = document.createElement('div'); snip.className = 'snip';
    highlight(snip, h.note ? `Note: ${h.note} · ${h.title || h.text}` : h.title ? `${h.title} · ${h.text}` : h.text || '(no text)', q);
    a.append(who, snip);
    a.addEventListener('click', () => send({ type: 'opened', key: h.key }));
    li.append(a);
    return li;
  }

  async function refreshStatus() {
    if (!saved?.host?.refresh) return;
    const r = await send({ type: 'status' });
    saved?.host?.refresh(r?.coverage);
  }

  route();   // last, so everything above (styles included) exists before the first mount
})();
