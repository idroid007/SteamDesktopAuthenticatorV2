/**
 * Builds docs/preview.html from the stylesheet the app actually ships.
 *
 * The preview exists so someone can look at the interface before installing
 * anything. It pulls fonts from Google because it runs on the open web; the
 * app itself carries its own copies and asks Google for nothing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const css = await readFile('packages/ui/src/app.css', 'utf8');

const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@500;600;700&family=Sora:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

const confirmation = ({ kind, glyph, headline, summary, when, rep }) => `        <article class="conf">
          <div class="conf__icon conf__icon--glyph">${glyph}</div>
          <div class="conf__body">
            <div class="conf__headline">${headline}</div>
            <div class="conf__summary">${summary}</div>
            <div class="conf__meta">
              <span class="tag tag--${kind}">${kind}</span>
              <span class="conf__when">${when}</span>${
                rep
                  ? `
              <a class="conf__rep" href="https://nohax.club" target="_blank" rel="noreferrer">Check this trader</a>`
                  : ''
              }
            </div>
          </div>
          <div class="conf__actions">
            <button class="btn btn--danger btn--sm">Deny</button>
            <button class="btn btn--primary btn--sm">Accept</button>
          </div>
        </article>`;

const confirmations = [
  {
    kind: 'trade',
    glyph: 'tra',
    headline: 'kopke_trades',
    summary: 'You give AK-47 | Redline (Field-Tested) &middot; You receive 2 items',
    when: '3 min ago',
    rep: true,
  },
  {
    kind: 'market',
    glyph: 'mar',
    headline: 'Sell &mdash; AWP | Asiimov (Battle-Scarred)',
    summary: 'You receive 41.28 USD &middot; Buyer pays 47.50 USD',
    when: '12 min ago',
  },
  {
    kind: 'market',
    glyph: 'mar',
    headline: 'Sell &mdash; Glove Case Key',
    summary: 'You receive 2.05 USD &middot; Buyer pays 2.35 USD',
    when: '1 hr ago',
  },
]
  .map(confirmation)
  .join('\n');

const account = ({ name, sub, code, selected, badge }) => `          <li><button class="account" aria-selected="${selected}">
            <span><span class="account__name">${name}</span><span class="account__sub">${sub}</span></span>
            <span>${badge ? `<span class="badge">${badge}</span>` : `<span class="account__code">${code}</span>`}</span>
          </button></li>`;

const accounts = [
  { name: 'ishu_trades', sub: '76561198042318806', code: '7K4MB', selected: true, badge: 3 },
  { name: 'bot_alpha', sub: '76561198112233445', code: 'QC9NV', selected: false },
  { name: 'bot_bravo', sub: '76561198556677889', code: 'MW2TX', selected: false },
  { name: 'storage_acct', sub: 'signed out', code: 'D6HJF', selected: false },
]
  .map(account)
  .join('\n');

const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SDA V2 Interface</title>
    ${FONTS}
    <style>
${css}

/* Preview shell only. The real app fills the whole window. */
body { overflow: auto; }
.preview { max-width: 1180px; margin: 0 auto; padding: 28px 16px 56px; }
.preview__head { margin-bottom: 18px; }
.preview__title {
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 0.02em;
  margin: 0 0 6px;
}
.preview__sub { color: var(--bone-2); font-size: 13px; margin: 0; max-width: 64ch; line-height: 1.6; }
.frame {
  height: 680px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  overflow: hidden;
  box-shadow: 0 30px 80px -40px #000;
}
.frame .app { height: 100%; }
@media (max-width: 820px) { .frame { height: 780px; } }
    </style>
  </head>
  <body>
    <div class="preview">
      <div class="preview__head">
        <h1 class="preview__title">Steam Desktop Authenticator V2</h1>
        <p class="preview__sub">
          The interface, drawn with the stylesheet the app ships. Electron loads this on Windows,
          macOS and Linux, and the same page opens in a phone browser when you run the daemon.
          Narrow the window to watch it fold into one column.
        </p>
      </div>

      <div class="frame">
        <div class="app">
          <header class="topbar">
            <div class="brand">
              <span class="brand__mark" aria-hidden="true"></span>
              <span class="brand__name">Authenticator</span>
            </div>
            <div class="topbar__right">
              <span class="clock">clock synced</span>
              <button class="icon-btn" title="Check for new confirmations" aria-label="Refresh">
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 1.5V5H10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
              </button>
              <button class="icon-btn" title="Lock the vault" aria-label="Lock">
                <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V4.8a2.5 2.5 0 0 1 5 0V7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
              </button>
            </div>
          </header>

          <div class="layout">
            <aside class="sidebar">
              <div class="sidebar__head">
                <span class="sidebar__title">Accounts</span>
                <span class="pill">4</span>
              </div>
              <ul class="accounts">
${accounts}
              </ul>
              <a class="sidebar__foot" href="https://nohax.club" target="_blank" rel="noreferrer">
                <span class="sidebar__foot-label">Check a trader before you deal</span>
                <span class="sidebar__foot-link">nohax.club</span>
              </a>
            </aside>

            <main class="main">
              <section class="code-panel">
                <div class="code-panel__meta">
                  <h1 class="code-panel__name">ishu_trades</h1>
                  <span class="code-panel__id">76561198042318806</span>
                </div>
                <div class="code-face">
                  <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
                    <circle class="ring__track" cx="60" cy="60" r="54" />
                    <circle class="ring__fill" cx="60" cy="60" r="54" style="stroke-dashoffset: 96" />
                  </svg>
                  <button class="code" title="Click to copy"><span class="code__value">7K4MB</span></button>
                </div>
                <div class="code-panel__actions">
                  <span class="countdown">21s left</span>
                  <button class="btn btn--ghost">Copy code</button>
                </div>
              </section>

              <section class="confirms">
                <div class="confirms__head">
                  <h2 class="confirms__title">Waiting on you</h2>
                  <div class="confirms__bulk">
                    <button class="btn btn--ghost btn--sm">Deny all</button>
                    <button class="btn btn--primary btn--sm">Accept all</button>
                  </div>
                </div>
                <div class="confirms__body">
${confirmations}
                </div>
              </section>
            </main>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>
`;

await mkdir('docs', { recursive: true });
await writeFile('docs/preview.html', html);
console.log(`docs/preview.html written (${html.length} bytes)`);
