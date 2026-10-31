// Synthetic stand-ins for LinkedIn pages (structure only, neutral made-up content).
const POSTS = [
  ['ada-park', 'Ada Park', 'Design systems are a product, not a project. Treat the backlog like one and the adoption follows.'],
  ['ravi-menon', 'Ravi Menon', 'Hiring designers in 2026: portfolios matter less than how you explain one decision you regret.'],
  ['lena-ortiz', 'Lena Ortiz', 'Remote teams need rituals, not more meetings. Our Friday demo replaced three status calls.'],
  ['kiran-rao', 'Kiran Rao', 'डिज़ाइन सिस्टम पर एक छोटी पोस्ट: tokens first, components second.'],
  ['sam-hill', 'Sam Hill', 'Pricing page teardown: one plan, one button, one sentence about refunds. Conversions went up.'],
  ['mo-ali', 'Mo Ali', 'Accessibility is not a checklist. Watch one screen reader user try your checkout.'],
  ['noor-said', 'Noor Said', 'Prompting tip: give the model two worked examples instead of ten rules.'],
  ['eva-lund', 'Eva Lund', 'Our onboarding had 9 steps. We cut it to 3 and activation doubled.'],
  ['tom-reid', 'Tom Reid', 'Spreadsheet of 40 design leadership books, ranked by how often I reopen them.'],
  ['ina-berg', 'Ina Berg', '<img src=x onerror="window.__pwned=1"> markup in a post must stay text.'],
  ['joe-park', 'Joe Park', 'Writing a case study: start with the result, then the mess, then the decision.'],
  ['ama-osei', 'Ama Osei', 'Motion guidelines: ease out, never bounce, 200 ms for small things.'],
  ['li-wei', 'Li Wei', 'The best research question I know: tell me about the last time you did this.'],
  ['raj-iyer', 'Raj Iyer', 'Dark mode is a second product. Budget for it.'],
  ['zoe-kim', 'Zoe Kim', 'Figma variables in practice: modes for density, not only for themes.'],
];
const urn = (i) => `urn:li:activity:75204922198547865${String(i).padStart(2, '0')}`;

// Draws the Saved list into `main`, the way LinkedIn does after its own fetch.
function renderSaved(main) {
  main.innerHTML = `<div class="card"><h1>Saved Posts</h1>
  <div class="search-reusables__filter-list"><button aria-pressed="true">All</button><button aria-pressed="false">Articles</button></div>
  <div class="scaffold-finite-scroll"><div class="scaffold-finite-scroll__content"><ul id="ul"></ul></div>
  <button class="scaffold-finite-scroll__load-button" id="more">Show more results</button></div></div>`;
  let shown = 0;
  const card = (i) => {
    const [slug, name, text] = POSTS[i];
    const li = document.createElement('li');
    li.innerHTML = `<div><div data-view-name="search-entity-result-content-${i % 3 ? 'a' : 'b'}-template" data-chameleon-result-urn="${urn(i)}">
     <div class="entity-result__content-container"><div class="entity-result__content-actor">
       <a href="https://www.linkedin.com/in/${slug}?miniProfileUrn=x"><span><span class="n"></span><span class="visually-hidden">View profile</span></span></a>
       <div class="t-14 t-black t-normal">Designer at Example Co</div></div>
     <div class="entity-result__content-inner-container--right-padding"><div class="linked-area"><p class="entity-result__content-summary--3-lines entity-result__content-summary"></p></div>
     <a href="https://www.linkedin.com/feed/update/${urn(i)}/">2w</a></div></div></div></div>`;
    li.querySelector('.n').textContent = name;
    li.querySelector('p').textContent = text;
    return li;
  };
  const more = (n) => { for (let k = 0; k < n && shown < POSTS.length; k++) main.querySelector('#ul').append(card(shown++)); };
  setTimeout(() => more(10), 300);
  main.querySelector('#more').onclick = () => setTimeout(() => more(5), 200);
}
