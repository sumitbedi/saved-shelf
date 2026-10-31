import test from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../src/core.js';

test('urns stay exact strings', () => {
  assert.equal(c.urnFrom('https://www.linkedin.com/feed/update/urn%3Ali%3Aactivity%3A7520492219854786561/'), 'urn:li:activity:7520492219854786561');
  assert.equal(c.urnFrom('nothing here'), null);
});

test('unsafe urls are refused, tracking stripped', () => {
  assert.equal(c.safeUrl('javascript:alert(1)'), null);
  assert.equal(c.safeUrl('data:text/html,hi'), null);
  assert.equal(c.safeUrl('http://example.com'), null);
  assert.equal(c.safeUrl('https://www.linkedin.com/posts/x?utm_source=a&keep=1&trk=b'), 'https://www.linkedin.com/posts/x?keep=1');
});

test('feed fingerprint joins the Saved page copy', () => {
  const feed = c.sanitizeCapture({ source: 'save-click', authorHref: '/in/Jane-Doe/', authorName: 'Jane Doe', text: 'Design systems are a product, not a project. Here is why.' });
  assert.ok(feed.key.startsWith('fp:in/jane-doe:'));
  assert.ok(feed.observedSaveAt);
  const page = c.sanitizeCapture({ source: 'saved-page', urn: 'urn:li:activity:7520492219854786561', authorHref: 'https://www.linkedin.com/in/jane-doe?miniProfile=1', authorName: 'Jane Doe', text: 'Design systems are a product, not a project. Here is why. And the long rest of the post that the feed had cut off.' });
  assert.ok(c.sameByFingerprint(feed, page));
  const other = c.sanitizeCapture({ source: 'saved-page', urn: 'urn:li:activity:1111111111111111111', authorHref: '/in/jane-doe/', text: 'A completely different post by the same person, about hiring.' });
  assert.ok(!c.sameByFingerprint(feed, other));
});

test('merge keeps the first observed save and the longer text', () => {
  const a = c.mergeItem(null, { key: 'k', text: 'short', observedSaveAt: '2026-10-01T10:00:00.000Z', sources: ['save-click'] }, '2026-10-01T10:00:00.000Z');
  const b = c.mergeItem(a, { key: 'k', text: 'short but longer', observedSaveAt: '2026-10-05T10:00:00.000Z', sources: ['saved-page'] }, '2026-10-05T10:00:00.000Z');
  assert.equal(b.observedSaveAt, '2026-10-01T10:00:00.000Z');
  assert.equal(b.text, 'short but longer');
  assert.deepEqual(b.sources, ['save-click', 'saved-page']);
  assert.equal(b.firstSeenAt, '2026-10-01T10:00:00.000Z');
});

test('an old post saved today sorts by save date; unknown dates last both ways', () => {
  const items = [
    { key: 'a', importedSavedAt: '2026-10-27' },
    { key: 'b', importedSavedAt: '2024-01-02' },
    { key: 'c' },
    { key: 'd', observedSaveAt: '2025-06-01T00:00:00Z' },
  ];
  assert.deepEqual([...items].sort(c.compare('saved-new')).map((i) => i.key), ['a', 'd', 'b', 'c']);
  assert.deepEqual([...items].sort(c.compare('saved-old')).map((i) => i.key), ['b', 'd', 'a', 'c']);
});

test('search: AND terms, phrases, accents, Hindi, notes rank first', () => {
  const items = [
    { key: '1', text: 'Café culture and remote work', author: { name: 'A' } },
    { key: '2', text: 'remote teams need rituals', author: { name: 'B' }, note: 'culture deck idea' },
    { key: '3', text: 'डिज़ाइन सिस्टम पर एक पोस्ट', author: { name: 'C' } },
    { key: '4', text: 'nothing', author: { name: 'D' }, status: 'unsaved' },
  ];
  const keys = (r) => r.hits.map((x) => x.it.key);
  assert.deepEqual(keys(c.search(items, { q: 'cafe remote' })), ['1']);
  assert.deepEqual(keys(c.search(items, { q: '"remote work"' })), ['1']);
  assert.deepEqual(keys(c.search(items, { q: 'culture', sort: 'relevance' })), ['2', '1']);
  assert.deepEqual(keys(c.search(items, { q: 'सिस्टम' })), ['3']);
  assert.deepEqual(keys(c.search(items, { q: 'nothing' })), []);
  assert.deepEqual(keys(c.search(items, { q: 'nothing', shelf: 'unsaved' })), ['4']);
  assert.equal(c.search(items, {}).total, 3);
});

test('csv parser handles quotes, commas, newlines, BOM, CRLF', () => {
  const rows = c.parseCSV('﻿SavedItem,Date\r\n"https://a.com/x?a=1,2","2024-03-04 10:22:01 UTC"\r\n"line\nbreak ""q""",x\r\n');
  assert.deepEqual(rows, [['SavedItem', 'Date'], ['https://a.com/x?a=1,2', '2024-03-04 10:22:01 UTC'], ['line\nbreak "q"', 'x']]);
});

test('dates: exact, local, date-only, ambiguous, impossible', () => {
  assert.deepEqual(c.parseDate('2024-03-04 10:22:01 UTC'), { iso: '2024-03-04T10:22:01.000Z', precision: 'instant' });
  assert.equal(c.parseDate('2024-03-04 10:22').precision, 'local');
  assert.deepEqual(c.parseDate('2024-03-04'), { iso: '2024-03-04', precision: 'date' });
  assert.deepEqual(c.parseDate('03/04/2026'), { ambiguous: true });
  assert.deepEqual(c.parseDate('03/04/2026', 'dmy'), { iso: '2026-04-03', precision: 'date' });
  assert.deepEqual(c.parseDate('13/04/2026'), { iso: '2026-04-13', precision: 'date' });
  assert.equal(c.parseDate('2026-02-30'), null);
});

test('import guesses columns from values and is idempotent', () => {
  const csv = 'When,Thing\n2024-03-04 10:22:01 UTC,https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001\n2024-03-05 08:00:00 UTC,https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001\n2024-03-06,https://www.linkedin.com/pulse/some-article\nbad,javascript:alert(1)\n';
  const rows = c.parseCSV(csv);
  const g = c.guessColumns(rows);
  assert.equal(g.url, 1); assert.equal(g.date, 0);
  const r = c.importRows(rows, g);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].key, 'urn:li:activity:7000000000000000001');
  assert.equal(r.items[1].kind, 'article');
  assert.deepEqual(r.errors.map((e) => e.row), [5]);
});

test('page content is data: html stays text, bad links dropped', () => {
  const it = c.sanitizeCapture({ source: 'saved-page', urn: 'urn:li:activity:7520492219854786561', text: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', authorHref: 'javascript:void(0)' });
  assert.equal(it.text, '<img src=x onerror=alert(1)>');
  assert.equal(it.url, 'https://www.linkedin.com/feed/update/urn:li:activity:7520492219854786561/');
  assert.equal(it.author.slug, undefined);
  assert.equal(c.sanitizeCapture({ source: 'save-click', text: 'too short' }), null);
});

test('resurface skips opened, dismissed, recent and unsaved', () => {
  const old = '2026-01-01T00:00:00Z';
  const items = [
    { key: 'a', text: 'x', observedSaveAt: old },
    { key: 'b', text: 'x', observedSaveAt: old, opens: 1 },
    { key: 'c', text: 'x', observedSaveAt: '2026-10-26T00:00:00Z' },
    { key: 'd', text: 'x', observedSaveAt: old, status: 'unsaved' },
    { key: 'e', text: 'x', observedSaveAt: old, dismissedAt: old },
  ];
  assert.deepEqual(c.resurface(items, 3, new Date('2026-10-27T00:00:00Z')).map((i) => i.key), ['a']);
});

test('imported article links get a readable title', () => {
  assert.equal(c.titleFromUrl('https://www.linkedin.com/pulse/a-made-up-article-title-jane-doe-abc1x/'), 'A made up article title jane doe');
});

test('same opening, different endings: separate records; ambiguous joins refused', () => {
  const intro = 'Weekly design notes, issue forty two. Here is what caught my eye this week in product: ';
  const a = c.sanitizeCapture({ source: 'save-click', authorHref: '/in/jo/', text: intro + 'motion.' });
  const b = c.sanitizeCapture({ source: 'save-click', authorHref: '/in/jo/', text: intro + 'pricing.' });
  assert.notEqual(a.key, b.key);
  const page = c.sanitizeCapture({ source: 'saved-page', urn: 'urn:li:activity:7000000000000000009', authorHref: '/in/jo/', text: intro });
  assert.equal(c.uniqueMatch([a, b], page), null);          // two candidates: keep apart
  const page2 = c.sanitizeCapture({ source: 'saved-page', urn: 'urn:li:activity:7000000000000000010', authorHref: '/in/jo/', text: intro + 'motion. And more.' });
  assert.equal(c.uniqueMatch([a, b], page2), a);
});

test('absorb keeps notes, collections and history from both', () => {
  const dst = { key: 'urn:li:activity:1000000', tags: ['A'], note: '', opens: 1, firstSeenAt: '2026-10-02T00:00:00Z', sources: ['import'] };
  const src = { key: 'fp:x', tags: ['B'], note: 'why', opens: 2, firstSeenAt: '2026-10-01T00:00:00Z', observedSaveAt: '2026-10-01T00:00:00Z', sources: ['save-click'] };
  const m = c.absorb(dst, src, '2026-10-05T00:00:00Z');
  assert.deepEqual(m.tags, ['A', 'B']);
  assert.equal(m.note, 'why');
  assert.equal(m.opens, 3);
  assert.equal(m.firstSeenAt, '2026-10-01T00:00:00Z');
  assert.equal(m.observedSaveAt, '2026-10-01T00:00:00Z');
  assert.equal(m.key, 'urn:li:activity:1000000');
});

test('saving again after unsaving brings it back', () => {
  const urn = 'urn:li:activity:7000000000000000011';
  const one = c.mergeItem(null, c.sanitizeCapture({ source: 'save-click', urn, text: 'x'.repeat(30) }));
  const two = c.mergeItem(one, c.sanitizeCapture({ source: 'unsave-click', urn, text: 'x'.repeat(30) }));
  assert.equal(two.status, 'unsaved');
  const three = c.mergeItem(two, c.sanitizeCapture({ source: 'save-click', urn, text: 'x'.repeat(30) }));
  assert.equal(three.status, 'saved');
});
