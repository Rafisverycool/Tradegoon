import { subscribeByName, unsubscribeByName, callbacks, SYMBOLS } from './fetchPrice.js';
import { initChart, updateLiveTick, loadCandles, clearChart, setExtendedPrice } from './Chart.js';
import { fetchCandlesForSymbol, TIMEFRAME_CONFIG } from './fetchCandles.js';
import { getMarketState } from './marketState.js';

let activeSymbol     = null;
let activeTimeframe  = '1D';
let activeIntervalMs = TIMEFRAME_CONFIG['1D'].intervalMs;

// Per-symbol open price so we can compute live change from WS ticks
// without needing a REST quote for every tick.
let sessionOpen      = null;   // the open price of today's session
let sessionPrevClose = null;   // prev close for change % calculation

// ── Stock clicks ──────────────────────────────────────────────────────────────

document.querySelectorAll('.stock').forEach(el => {
  const name = el.textContent.trim();
  el.dataset.name = name;
  el.innerHTML = `<span class="market-dot"></span><span class="stock-label">${name}</span>`;

  el.addEventListener('click', async () => {
    if (!SYMBOLS[name]) return;

    if (activeSymbol && activeSymbol !== name) {
      unsubscribeByName(activeSymbol);
    }
    document.querySelectorAll('.stock').forEach(s => s.classList.remove('active'));

    activeSymbol     = name;
    sessionOpen      = null;
    sessionPrevClose = null;

    el.classList.add('active');
    setName(name);
    setPrice('—');
    setChange(null, null);
    setStats(null);
    setExtendedBadge(null, null);

    clearChart();
    activeIntervalMs = TIMEFRAME_CONFIG[activeTimeframe]?.intervalMs ?? 5 * 60_000;
    initChart(activeIntervalMs);

    loadCandlesFor(name, activeTimeframe);
    subscribeByName(name);
  });
});

// ── Timeframe buttons ─────────────────────────────────────────────────────────

document.querySelectorAll('.tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeTimeframe  = btn.dataset.tf;
    activeIntervalMs = TIMEFRAME_CONFIG[activeTimeframe]?.intervalMs ?? 5 * 60_000;

    if (activeSymbol) {
      clearChart();
      initChart(activeIntervalMs);
      loadCandlesFor(activeSymbol, activeTimeframe);
    }
  });
});

// ── Load candles helper ───────────────────────────────────────────────────────

async function loadCandlesFor(name, timeframe) {
  const result = await fetchCandlesForSymbol(name, timeframe);
  if (!result) return;
  activeIntervalMs = result.intervalMs;
  loadCandles(result.candles, result.intervalMs);
}

// ── Market state dots ─────────────────────────────────────────────────────────

function updateDots() {
  document.querySelectorAll('.stock').forEach(el => {
    const dot  = el.querySelector('.market-dot');
    const name = el.dataset.name;
    if (!dot || !name) return;
    const state   = getMarketState(name);
    dot.className = `market-dot ${state}`;
    dot.title     = { open: 'Market open', pre: 'Pre-market', post: 'After-hours', closed: 'Market closed' }[state] ?? '';
  });
}

updateDots();
setInterval(updateDots, 60_000);

// ── Finnhub callbacks ─────────────────────────────────────────────────────────

// Quote arrives for stocks only (crypto has no /quote on free tier).
// Use it to seed open/prevClose so we can compute change from live WS ticks.
callbacks.onQuoteUpdate = (name, quote) => {
  if (name !== activeSymbol) return;
  sessionOpen      = quote.open;
  sessionPrevClose = quote.prevClose;
  setPrice(formatPrice(quote.current));
  setChange(quote.change, quote.changePct);
  setStats(quote);
};

// WS tick — fires for both stocks and crypto. Always the freshest price.
callbacks.onPriceUpdate = (ticker, price) => {
  const entry = SYMBOLS[activeSymbol];
  if (!entry || entry.ticker !== ticker) return;

  setPrice(formatPrice(price));
  updateLiveTick(price, activeIntervalMs);

  // Compute and display live change if we have a reference price
  const ref = sessionPrevClose ?? sessionOpen;
  if (ref != null) {
    const change    = parseFloat((price - ref).toFixed(2));
    const changePct = parseFloat(((price - ref) / ref * 100).toFixed(2));
    setChange(change, changePct);
  }
};

callbacks.onExtendedPrice = (name, price, session) => {
  if (name !== activeSymbol) return;
  setExtendedPrice(price, session);
  setExtendedBadge(price, session);
};

// ── DOM helpers ───────────────────────────────────────────────────────────────

function setName(name)  { document.getElementById('main-name').textContent  = name; }
function setPrice(v)    { document.getElementById('main-price').textContent = v;    }

function setChange(change, pct) {
  const el = document.getElementById('main-change');
  if (change === null) { el.textContent = ''; el.className = 'main-change'; return; }
  const sign = change >= 0 ? '+' : '';
  el.textContent = `${sign}${change} (${sign}${pct}%)`;
  el.className   = `main-change ${change >= 0 ? 'up' : 'down'}`;
}

function setStats(quote) {
  const fields = {
    'stat-open':      quote ? formatPrice(quote.open)      : '—',
    'stat-high':      quote ? formatPrice(quote.high)      : '—',
    'stat-low':       quote ? formatPrice(quote.low)       : '—',
    'stat-prevclose': quote ? formatPrice(quote.prevClose) : '—',
  };
  for (const [id, val] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (el) el.querySelector('.stat-value').textContent = val;
  }
}

function setExtendedBadge(price, session) {
  let badge = document.getElementById('extended-badge');

  if (!session || session === 'regular' || price == null) {
    if (badge) badge.remove();
    return;
  }

  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'extended-badge';
    document.getElementById('main-change').insertAdjacentElement('afterend', badge);
  }

  const isPre  = session === 'pre';
  const color  = isPre ? '#f97316' : '#a855f7';
  badge.textContent = `${isPre ? 'PRE' : 'POST'} ${formatPrice(price)}`;
  badge.style.cssText = `
    font-size:12px; font-weight:700; color:${color};
    background:${color}22; border:1px solid ${color}55;
    border-radius:5px; padding:2px 7px; margin-left:8px; letter-spacing:0.03em;
  `;
}

function formatPrice(price) {
  if (price >= 10000) return `$${price.toFixed(0)}`;
  if (price >= 100)   return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}