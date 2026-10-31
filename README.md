# Shelf for LinkedIn saves

LinkedIn's Saved page has no search, no folders and no save dates. Shelf keeps a private copy of what you save,
so you can find it again. Fan-made and not affiliated with LinkedIn.

## How it works

| Source | What it adds | Save date? |
|---|---|---|
| **You click Save** on any post (feed, profile, post page) | the post's text, author and, once it shows up on Saved, its link | yes, the moment you clicked (this computer's clock) |
| **You open your Saved page** | every card LinkedIn has shown you there, plus a search box at the top | no (LinkedIn doesn't show it) |
| **You import LinkedIn's data export** (Settings → Data privacy → Get a copy of your data → Saved items) | the link and save date of every save, ever | yes, from LinkedIn |

A post saved from the feed has no id on the new feed, so it's kept under a fingerprint (author + opening words)
and joined to LinkedIn's copy the first time it appears on your Saved page.

The library page (click the toolbar icon) has search across text, people, notes and collections; sorting by
when you saved; collections; a one-line "why I saved it" note; "Worth another look" (older saves you never
reopened); backup and restore. Press `/` to search.

## What it never does

No crawling, no automatic "Show more" clicks, no save/unsave/like/post, no hiding or moving LinkedIn's cards,
no cookies or private LinkedIn APIs, no network calls at all from the extension's pages, no telemetry, no AI.
Everything is in this Chrome profile's IndexedDB. Removing a post from Shelf doesn't unsave it on LinkedIn.

**Know this:** LinkedIn's terms prohibit extensions that scrape or modify its site. Shelf reads only what
LinkedIn already shows you and adds one search box, but that is still a terms risk to your account, not an
approved integration. The "Keep posts automatically" switch in the library turns all LinkedIn reading off.

## Install

Not on the Chrome Web Store. Works in Chrome and Arc (any Chromium browser should do).

1. Clone or download this repo.
2. `chrome://extensions` (`arc://extensions` in Arc) → turn on **Developer mode** → **Load unpacked** → pick this folder.
3. Pin the icon. Click it to open your shelf.
4. Already-open LinkedIn tabs pick it up without a reload.

## Tests

- `npm test`: core logic (identity, merge, dates, CSV import, search, sort, safety). 15 tests.
- `npm run e2e` (`-- --headed` to watch): real Chrome with the unpacked extension against synthetic
  LinkedIn-like pages in `test-e2e/fixtures` (nothing reaches LinkedIn). 28 checks: feed Save by click and
  keyboard, a repost, in-app navigation to Saved, Saved drawn in LinkedIn's `/preload/` frame, one search box, "Show more" pickup, Hindi search, feed/Saved
  merge, markup stays text, notes, collections, import preview, re-import, worker restart, off switch, paused at load.

## Checked against the real site (27 Oct 2026, read-only)

- Saved page: `[data-chameleon-result-urn]` cards, `p.entity-result__content-summary` body, actor link and
  `/feed/update/<urn>` permalink all present. No save timestamps on the page.
- Saved page reached by a link from the home page: LinkedIn draws it inside a same-origin `/preload/` iframe
  while the address bar says `/my-items/saved-posts/`. After a refresh it is in the main document.
- Feed (new 2026 layout): posts are `[role="listitem"]` with no post id; text in
  `[data-testid="expandable-text-box"]`; the post menu is drawn outside the post and its Save item carries the
  icon `bookmark-outline-medium` (language-independent).

## Known limits

A Save that fails on LinkedIn's side is still kept, marked "kept from feed" until LinkedIn's Saved page confirms it. An Unsave
moves a post to "Unsaved on LinkedIn" and it comes back if it shows up on Saved again. An Unsave made after arriving at Saved
from the home page isn't noticed, because that page is in the `/preload/` frame.

## Not yet proven

- A real Save on the live feed (needs a real click on your account).
- LinkedIn's actual export file (the importer guesses columns from the values and shows a preview first).
- Re-enabling the extension in an already-open tab, other languages, reposts, mobile saves.
- One library per Chrome profile; switching LinkedIn accounts in the same profile mixes them.

## License

MIT (`LICENSE`). The bundled Geist font is under the SIL Open Font License (`library/Geist-LICENSE.txt`).
