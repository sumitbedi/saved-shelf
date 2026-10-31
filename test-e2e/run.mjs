// End-to-end check in real Chrome with the unpacked extension. Every linkedin.com request is answered
// from test-e2e/fixtures (synthetic pages); nothing reaches LinkedIn. Usage: npm run e2e [-- --headed]
import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const shots = path.join(root, 'test-e2e', 'shots');
mkdirSync(shots, { recursive: true });
const fx = (f) => readFileSync(path.join(here, 'fixtures', f), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

const browser = await puppeteer.launch({
  headless: !process.argv.includes('--headed'), pipe: true, enableExtensions: [root],
  defaultViewport: { width: 1280, height: 860 }, args: ['--window-size=1280,960'],
});
const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('src/bg.js'), { timeout: 10000 });
const extId = new URL(sw.url()).host;
const lib = `chrome-extension://${extId}/library/library.html`;

async function linkedInTab() {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('  page error:', e.message));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (u.host !== 'www.linkedin.com') return req.abort();
    if (u.pathname === '/__fixtures/common.js') return req.respond({ contentType: 'text/javascript', body: fx('common.js') });
    if (u.pathname.startsWith('/feed')) return req.respond({ contentType: 'text/html', body: fx('feed.html') });
    if (u.pathname.startsWith('/my-items/saved-posts')) return req.respond({ contentType: 'text/html', body: fx('saved.html') });
    if (u.pathname.startsWith('/preload')) return req.respond({ contentType: 'text/html', body: fx('preload.html') });
    return req.respond({ status: 204, body: '' });
  });
  return page;
}
const shadow = (page, host, sel) => page.evaluate((h, s) => {
  const el = document.querySelector(h)?.shadowRoot?.querySelector(s);
  return el ? el.textContent : null;
}, host, sel);

try {
  // ---------- 1. save from the feed ----------
  const page = await linkedInTab();
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'load' });
  await page.waitForFunction(() => !!globalThis.document.querySelector('.ctl'));
  await wait(400);
  const ctl = (await page.$$('.ctl'))[1];   // second post: Lena Ortiz (POSTS[2])
  await ctl.click(); await wait(150);
  await page.click('.menu .save'); await wait(700);
  const t1 = await shadow(page, 'saved-shelf-toast', 'div');
  check('Save click in the feed is kept', t1 === 'Kept on your shelf', t1);
  check('LinkedIn’s own click still happened', await page.evaluate(() => window.__savedClicks === 1));
  await page.screenshot({ path: path.join(shots, '1-feed-save.png') });

  // keyboard: Enter on the Save item of another post
  await (await page.$$('.ctl'))[0].click(); await wait(150);
  await page.focus('.menu .save'); await page.keyboard.press('Enter'); await wait(700);
  const t2 = await shadow(page, 'saved-shelf-toast', 'div');
  check('Keyboard Save is kept too', t2 === 'Kept on your shelf', t2);

  // a repost: keep the reposter's own words, not the embedded post's id or text
  await (await page.$$('.ctl'))[2].click(); await wait(150);
  await page.click('.menu .save'); await wait(700);

  // clicking Copy link must not keep anything
  await (await page.$$('.ctl'))[0].click(); await wait(150);
  await page.click('.menu [role=menuitem]:not(.save)'); await wait(500);

  // ---------- 2. single-page navigation to Saved ----------
  await page.evaluate(() => window.goSaved());
  await page.waitForFunction(() => document.querySelector('saved-shelf-search'), { timeout: 8000 }).catch(() => {});
  await wait(1200);
  const mounted = await page.$('saved-shelf-search');
  check('Search box appears on Saved after in-app navigation', !!mounted);
  const scope1 = await shadow(page, 'saved-shelf-search', '.scope');
  check('Saved page cards are indexed, feed copies merged (10 + 0 duplicates)', /^Searching in 10 posts$/.test(scope1 || ''), scope1);
  const hosts = await page.evaluate(() => document.querySelectorAll('saved-shelf-search').length);
  check('Exactly one search box', hosts === 1, String(hosts));

  // user loads more with LinkedIn's own button
  await page.click('#more'); await wait(1400);
  const scope2 = await shadow(page, 'saved-shelf-search', '.scope');
  check('Cards loaded by “Show more” are added', /^Searching in 15 posts$/.test(scope2 || ''), scope2);
  const nativeCards = await page.evaluate(() => document.querySelectorAll('#ul li').length);
  check('LinkedIn’s cards untouched', nativeCards === 15, String(nativeCards));

  // search on the Saved page
  const input = await page.evaluateHandle(() => document.querySelector('saved-shelf-search').shadowRoot.querySelector('input'));
  await input.type('design systems'); await wait(500);
  const hits = await page.evaluate(() => [...document.querySelector('saved-shelf-search').shadowRoot.querySelectorAll('li a .who')].map((x) => x.textContent));
  check('Search on Saved finds the post', hits.length === 1 && hits[0].startsWith('Ada Park'), hits.join(' | '));
  await page.screenshot({ path: path.join(shots, '2-saved-search.png') });
  await input.click({ clickCount: 3 }); await input.type('सिस्टम'); await wait(500);
  const hindi = await page.evaluate(() => document.querySelector('saved-shelf-search').shadowRoot.querySelectorAll('li a').length);
  check('Hindi search works', hindi === 1, String(hindi));
  check('Typing in our box doesn’t trigger LinkedIn shortcuts (focus stays)', await page.evaluate(() => document.activeElement?.tagName === 'SAVED-SHELF-SEARCH'));

  // ---------- 3. the library ----------
  const lp = await browser.newPage();
  lp.on('pageerror', (e) => console.log('  library error:', e.message));
  await lp.goto(lib, { waitUntil: 'load' }); await wait(600);
  const scopeL = await lp.$eval('#scope', (e) => e.textContent);
  check('Library counts: 15 saves, 3 with a save date', scopeL === '15 saves · 15 with text · 3 with a save date', scopeL);
  const repost = await lp.evaluate(() => [...document.querySelectorAll('.item')].map((li) => li.dataset.key + '|' + li.querySelector('.body')?.textContent));
  check('Repost kept as the reposter’s post, embedded id ignored', !repost.some((r) => r.includes('86599') || r.includes('embedded original')) && repost.some((r) => r.includes('Pricing page teardown')), '');
  const firstWho = await lp.$eval('#list .item .who', (e) => e.textContent);
  check('Newest saved first: the last post saved leads', firstWho === 'Sam Hill', firstWho);
  const badges = await lp.$$eval('.badge', (b) => b.map((x) => x.textContent));
  check('Feed copies joined LinkedIn’s (no “kept from feed” left)', !badges.includes('kept from feed'), badges.join(','));
  check('Post markup stays text, never runs', await lp.evaluate(() => window.__pwned === undefined && [...document.querySelectorAll('.body')].some((p) => p.textContent.includes('<img src=x'))));
  await lp.screenshot({ path: path.join(shots, '3-library.png'), fullPage: false });

  // collection + note
  await lp.type('#new-tag input', 'Hiring'); await lp.keyboard.press('Enter'); await wait(300);
  await lp.click('[data-shelf="all"]'); await wait(200);
  await lp.type('#q', 'portfolios'); await wait(300);
  await lp.evaluate(() => [...document.querySelectorAll('.row-acts button')].find((b) => b.textContent === 'Collections').click()); await wait(200);
  await lp.evaluate(() => [...document.querySelectorAll('.picker button')].find((b) => b.textContent === 'Hiring').click()); await wait(300);
  await lp.evaluate(() => [...document.querySelectorAll('.row-acts button')].find((b) => b.textContent === 'Add a note').click()); await wait(200);
  await lp.keyboard.type('Use for the design lead job post'); await lp.keyboard.press('Enter'); await wait(400);
  await lp.click('#q', { clickCount: 3 }); await lp.keyboard.press('Backspace');
  await lp.type('#q', 'job post'); await wait(300);
  const byNote = await lp.$$eval('#list .item .who', (e) => e.map((x) => x.textContent));
  check('Notes are searchable', byNote.length === 1 && byNote[0] === 'Ravi Menon', byNote.join(','));
  await lp.click('[data-shelf="tag:Hiring"]'); await wait(200);
  await lp.click('#q', { clickCount: 3 }); await lp.keyboard.press('Backspace'); await wait(300);
  const inTag = await lp.$$eval('#list .item', (e) => e.length);
  check('Collection holds the filed post', inTag === 1, String(inTag));
  await lp.click('[data-shelf="all"]'); await wait(200);

  // import: dates for old saves, one brand-new link, one bad row
  const csv = ['Date,Link', `2024-03-04 10:22:01 UTC,https://www.linkedin.com/feed/update/urn:li:activity:7520492219854786509`,
    '2023-11-20 08:00:00 UTC,https://www.linkedin.com/pulse/a-made-up-article-title', 'nope,javascript:alert(1)'].join('\n');
  const tmp = path.join(shots, 'import.csv');
  (await import('node:fs')).writeFileSync(tmp, csv);
  await lp.click('#open-import'); await wait(150);
  const [fileInput] = await lp.$$('#file');
  await fileInput.uploadFile(tmp); await wait(600);
  const sum = await lp.$eval('#mapping .sum', (e) => e.textContent);
  check('Import preview explains what will happen', /2 saves found: 1 new, 1 already on your shelf.*1 rows skipped \(rows 4\)/.test(sum), sum);
  await lp.screenshot({ path: path.join(shots, '4-import.png') });
  await lp.click('#mapping .btn'); await wait(700);
  const scopeI = await lp.$eval('#scope', (e) => e.textContent);
  check('After import: 16 saves, 5 with a save date', scopeI === '16 saves · 15 with text · 5 with a save date', scopeI);
  await lp.select('#sort', 'saved-old'); await wait(300);
  const oldest = await lp.$eval('#list .item .date', (e) => e.textContent);
  check('Oldest saved first uses the export date', /2023/.test(oldest), oldest);

  // re-import is idempotent
  await lp.click('#open-import'); await wait(150);
  await (await lp.$('#file')).uploadFile(tmp); await wait(500);
  await lp.click('#mapping .btn'); await wait(600);
  check('Importing the same file twice adds nothing', (await lp.$eval('#scope', (e) => e.textContent)).startsWith('16 saves'));

  // ---------- 4. the service worker restarting doesn't lose anything ----------
  const cdp = await page.target().createCDPSession();
  await cdp.send('ServiceWorker.enable').catch(() => {});
  const stopped = await cdp.send('ServiceWorker.stopAllWorkers').then(() => true, () => false);
  console.log('  worker stopped:', stopped);
  await page.reload({ waitUntil: 'load' }); await wait(1800);
  const scope3 = await shadow(page, 'saved-shelf-search', '.scope');
  check('After a worker restart the shelf is intact', /^Searching in 16 posts$/.test(scope3 || ''), scope3);

  // ---------- 4b. Saved reached from the home page: LinkedIn draws it inside the /preload/ frame ----------
  const fp = await linkedInTab();
  await fp.goto('https://www.linkedin.com/feed/', { waitUntil: 'load' }); await wait(1000);
  await fp.evaluate(() => window.goSavedInFrame()); await wait(1600);
  const inFrame = () => fp.evaluate(() => {
    const d = document.getElementById('preload').contentDocument;
    return { hosts: d.querySelectorAll('saved-shelf-search').length, top: document.querySelectorAll('saved-shelf-search').length,
      scope: d.querySelector('saved-shelf-search')?.shadowRoot?.querySelector('.scope')?.textContent || null };
  });
  const f1 = await inFrame();
  check('Search box appears when Saved is drawn in the preload frame', f1.hosts === 1 && f1.top === 0, JSON.stringify(f1));
  check('The count shows there too', /^Searching in 16 posts$/.test(f1.scope || ''), f1.scope);
  await fp.evaluate(() => history.pushState({}, '', '/feed/')); await wait(1000);
  const f2 = await inFrame();
  check('Leaving Saved removes it from the frame', f2.hosts === 0, JSON.stringify(f2));
  await fp.close();

  // ---------- 5. switch off ----------
  await lp.bringToFront(); await lp.click('#capture'); await wait(400);
  await page.bringToFront(); await wait(1000);
  check('Turning it off removes the search box at once', !(await page.$('saved-shelf-search')));
  // paused before the page loads: nothing is read, no box appears
  await page.reload({ waitUntil: 'load' }); await wait(1800);
  check('Paused at page load: no search box, nothing read', !(await page.$('saved-shelf-search')));
  await lp.bringToFront(); await lp.click('#capture'); await wait(300);
  await lp.select('#sort', 'saved-new'); await lp.reload(); await wait(700);
  await lp.screenshot({ path: path.join(shots, '5-library-final.png') });
} catch (e) {
  check('run finished without crashing', false, e.stack.split('\n').slice(0, 3).join(' '));
} finally {
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  await browser.close();
  process.exit(failed ? 1 : 0);
}
