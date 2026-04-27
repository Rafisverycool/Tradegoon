import { ALPACA_KEY, ALPACA_SECRET } from '../config.js';

// Timeframe config
//   alpacaStockTf  : Alpaca bar timeframe for stocks  (/v2/stocks/{symbol}/bars)
//   alpacaCryptoTf : Alpaca bar timeframe for crypto  (/v2/crypto/bars)
//   seconds        : how far back to fetch (from now)
//   intervalMs     : duration of each candle in ms (for the live-tick slot logic)

export const TIMEFRAME_CONFIG = {
  '1S':  { alpacaStockTf: '1Min',   alpacaCryptoTf: '1Min',   seconds: 100,                  intervalMs: 1_000                 },
  '1Min':{ alpacaStockTf: '1Min',   alpacaCryptoTf: '1Min',   seconds: 100  * 60,            intervalMs: 60_000                },
  '5Min':{ alpacaStockTf: '5Min',   alpacaCryptoTf: '5Min',   seconds: 100  * 5  * 60,       intervalMs: 5  * 60_000           },
  '1H':  { alpacaStockTf: '1Hour',  alpacaCryptoTf: '1Hour',  seconds: 100  * 60 * 60,       intervalMs: 60 * 60_000           },
  '1D':  { alpacaStockTf: '5Min',   alpacaCryptoTf: '5Min',   seconds: 1    * 24 * 3600,     intervalMs: 5  * 60_000           },
  '1W':  { alpacaStockTf: '1Day',   alpacaCryptoTf: '1Day',   seconds: 7    * 24 * 3600,     intervalMs: 24 * 60 * 60_000      },
  '1Mo': { alpacaStockTf: '1Day',   alpacaCryptoTf: '1Day',   seconds: 30   * 24 * 3600,     intervalMs: 24 * 60 * 60_000      },
  '3Mo': { alpacaStockTf: '1Day',   alpacaCryptoTf: '1Day',   seconds: 90   * 24 * 3600,     intervalMs: 24 * 60 * 60_000      },
  '1Y':  { alpacaStockTf: '1Week',  alpacaCryptoTf: '1Week',  seconds: 365  * 24 * 3600,     intervalMs: 7  * 24 * 60 * 60_000 },
  '5Y':  { alpacaStockTf: '1Month', alpacaCryptoTf: '1Month', seconds: 5 * 365 * 24 * 3600,  intervalMs: 30 * 24 * 60 * 60_000 },
};

// ticker      : used for Alpaca stocks and Finnhub WebSocket (crypto)
// cryptoTicker: used for Alpaca crypto bars API (format: "BTC/USD")
export const SYMBOLS = {
  'Sandisk':   { ticker: 'SNDK',             type: 'stock'  },
  'Apple':     { ticker: 'AAPL',             type: 'stock'  },
  'Micron':    { ticker: 'MU',               type: 'stock'  },
  'ASML':      { ticker: 'ASML',             type: 'stock'  },
  'Gold':      { ticker: 'GLD',              type: 'stock'  },
  'Silver':    { ticker: 'SLV',              type: 'stock'  },
  'Copper':    { ticker: 'CPER',             type: 'stock'  },
  'Crude Oil': { ticker: 'USO',              type: 'stock'  },
  'Bitcoin':   { ticker: 'BINANCE:BTCUSDT',  type: 'crypto', cryptoTicker: 'BTC/USD' },
  'Ethereum':  { ticker: 'BINANCE:ETHUSDT',  type: 'crypto', cryptoTicker: 'ETH/USD' },
  'Litecoin':  { ticker: 'BINANCE:LTCUSDT',  type: 'crypto', cryptoTicker: 'LTC/USD' },
  'Solana':    { ticker: 'BINANCE:SOLUSDT',  type: 'crypto', cryptoTicker: 'SOL/USD' },
  'Ripple':    { ticker: 'BINANCE:XRPUSDT',  type: 'crypto', cryptoTicker: 'XRP/USD' },
};

// Cache: Map of "SYMBOL:TIMEFRAME" -> { candles, intervalMs, fetchedAt }
const cache     = new Map();
const CACHE_TTL = 60_000;

const ALPACA_HEADERS = {
  'APCA-API-KEY-ID':     ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
};

/**
 * Fetch (or return cached) candles for a symbol + timeframe.
 * Returns { candles, intervalMs } or null on failure.
 *
 * Routing:
 *   stocks -> Alpaca /v2/stocks/{symbol}/bars
 *   crypto -> Alpaca /v2/crypto/bars  (Finnhub REST is paywalled; WS prices still use Finnhub)
 */
export async function fetchCandlesForSymbol(name, timeframe) {
  const entry = SYMBOLS[name];
  if (!entry) return null;

  const cacheKey = `${name}:${timeframe}`;
  const cached   = cache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    console.log(`[Candles] Cache hit: ${cacheKey}`);
    return { candles: cached.candles, intervalMs: cached.intervalMs };
  }

  const cfg = TIMEFRAME_CONFIG[timeframe] ?? TIMEFRAME_CONFIG['1D'];

  return entry.type === 'stock'
    ? fetchAlpacaStockCandles(name, entry.ticker, cfg, cacheKey)
    : fetchAlpacaCryptoCandles(name, entry.cryptoTicker, cfg, cacheKey);
}

/** Invalidate the cache for a specific symbol (all timeframes). */
export function invalidateCache(name) {
  for (const key of cache.keys()) {
    if (key.startsWith(`${name}:`)) cache.delete(key);
  }
}

// ── Alpaca stocks ─────────────────────────────────────────────────────────────

async function fetchAlpacaStockCandles(name, ticker, cfg, cacheKey) {
  const to   = new Date();
  const from = new Date(to.getTime() - cfg.seconds * 1000);
  const url  = `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars`
             + `?timeframe=${cfg.alpacaStockTf}`
             + `&start=${from.toISOString()}`
             + `&end=${to.toISOString()}`
             + `&limit=200`;

  console.log(`[Candles] Alpaca stock fetch ${name} (${ticker}) @ ${cfg.alpacaStockTf}`);

  try {
    const res = await fetch(url, { headers: ALPACA_HEADERS });

    if (!res.ok) {
      console.warn(`[Candles] Alpaca stock HTTP ${res.status} for ${name}`);
      return fetchAlpacaStockFallback(name, ticker, cfg);
    }

    const d = await res.json();
    if (!d.bars?.length) {
      console.warn(`[Candles] Alpaca stock returned no bars for ${name}`);
      return fetchAlpacaStockFallback(name, ticker, cfg);
    }

    const candles = barsToCandles(d.bars);
    cache.set(cacheKey, { candles, intervalMs: cfg.intervalMs, fetchedAt: Date.now() });
    return { candles, intervalMs: cfg.intervalMs };

  } catch (err) {
    console.error(`[Candles] Alpaca stock fetch failed for ${name}:`, err);
    return fetchAlpacaStockFallback(name, ticker, cfg);
  }
}

async function fetchAlpacaStockFallback(name, ticker, cfg) {
  console.warn(`[Candles] Using Alpaca stock snapshot fallback for ${name}`);
  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/snapshot`,
      { headers: ALPACA_HEADERS }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const snap = await res.json();

    const close     = snap.latestTrade?.p ?? snap.dailyBar?.c;
    const prevClose = snap.prevDailyBar?.c ?? close;
    const open      = snap.dailyBar?.o    ?? prevClose;
    const high      = snap.dailyBar?.h    ?? close * 1.01;
    const low       = snap.dailyBar?.l    ?? close * 0.99;

    if (!close) throw new Error('No price in snapshot');
    const candles = generateSyntheticCandles({ close, prevClose, high, low, open, slots: 20, intervalMs: cfg.intervalMs });
    return { candles, intervalMs: cfg.intervalMs };
  } catch (err) {
    console.error(`[Candles] Alpaca stock fallback failed for ${name}:`, err);
    return null;
  }
}

// ── Alpaca crypto ─────────────────────────────────────────────────────────────

async function fetchAlpacaCryptoCandles(name, cryptoTicker, cfg, cacheKey) {
  const to   = new Date();
  const from = new Date(to.getTime() - cfg.seconds * 1000);
  const url  = `https://data.alpaca.markets/v2/crypto/bars`
             + `?symbols=${encodeURIComponent(cryptoTicker)}`
             + `&timeframe=${cfg.alpacaCryptoTf}`
             + `&start=${from.toISOString()}`
             + `&end=${to.toISOString()}`
             + `&limit=200`;

  console.log(`[Candles] Alpaca crypto fetch ${name} (${cryptoTicker}) @ ${cfg.alpacaCryptoTf}`);

  try {
    const res = await fetch(url, { headers: ALPACA_HEADERS });

    if (!res.ok) {
      console.warn(`[Candles] Alpaca crypto HTTP ${res.status} for ${name}`);
      return fetchAlpacaCryptoFallback(name, cryptoTicker, cfg);
    }

    const d    = await res.json();
    const bars = d.bars?.[cryptoTicker];

    if (!bars?.length) {
      console.warn(`[Candles] Alpaca crypto returned no bars for ${name}`);
      return fetchAlpacaCryptoFallback(name, cryptoTicker, cfg);
    }

    const candles = barsToCandles(bars);
    cache.set(cacheKey, { candles, intervalMs: cfg.intervalMs, fetchedAt: Date.now() });
    return { candles, intervalMs: cfg.intervalMs };

  } catch (err) {
    console.error(`[Candles] Alpaca crypto fetch failed for ${name}:`, err);
    return fetchAlpacaCryptoFallback(name, cryptoTicker, cfg);
  }
}

async function fetchAlpacaCryptoFallback(name, cryptoTicker, cfg) {
  console.warn(`[Candles] Using Alpaca crypto snapshot fallback for ${name}`);
  try {
    // Fetch the latest daily bar as a reference price for synthetic candles
    const to   = new Date();
    const from = new Date(to.getTime() - 2 * 24 * 3600 * 1000);
    const url  = `https://data.alpaca.markets/v2/crypto/bars`
               + `?symbols=${encodeURIComponent(cryptoTicker)}`
               + `&timeframe=1Day`
               + `&start=${from.toISOString()}`
               + `&end=${to.toISOString()}`
               + `&limit=2`;

    const res = await fetch(url, { headers: ALPACA_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d    = await res.json();
    const bars = d.bars?.[cryptoTicker];
    if (!bars?.length) throw new Error('No bars in fallback response');

    const last      = bars[bars.length - 1];
    const prev      = bars.length > 1 ? bars[bars.length - 2] : null;
    const candles   = generateSyntheticCandles({
      close:     last.c,
      prevClose: prev?.c ?? last.o,
      high:      last.h,
      low:       last.l,
      open:      last.o,
      slots:     20,
      intervalMs: cfg.intervalMs,
    });
    return { candles, intervalMs: cfg.intervalMs };
  } catch (err) {
    console.error(`[Candles] Alpaca crypto fallback failed for ${name}:`, err);
    return null;
  }
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Convert an Alpaca bars array to the { time, open, high, low, close } shape the chart expects. */
function barsToCandles(bars) {
  return bars.map(bar => ({
    time:  Math.floor(new Date(bar.t).getTime() / 1000),
    open:  bar.o,
    high:  bar.h,
    low:   bar.l,
    close: bar.c,
  }));
}

function generateSyntheticCandles({ close, prevClose, high, low, open, slots, intervalMs }) {
  let seed = Math.round(close * 1000);
  const rand = () => {
    seed ^= seed << 13; seed ^= seed >> 17; seed ^= seed << 5;
    return (seed >>> 0) / 0xFFFFFFFF;
  };

  const nowSec    = Math.floor(Date.now() / 1000);
  const slotSec   = Math.floor(intervalMs / 1000);
  const startTime = nowSec - slotSec * (slots - 1);
  const range     = Math.max(high - low, close * 0.005);
  const vol       = range / slots * 1.5;

  const candles = [];
  let   price   = open;

  for (let i = 0; i < slots; i++) {
    const progress = i / (slots - 1);
    const target   = open + (close - open) * progress;
    const drift    = (target - price) * 0.25;
    const move     = drift + (rand() - 0.48) * vol;
    const o        = price;
    const c        = Math.max(close * 0.5, price + move);
    const spike    = vol * (0.3 + rand() * 0.7);
    const h        = Math.max(o, c) + spike * rand();
    const l        = Math.min(o, c) - spike * rand();

    candles.push({
      time:  startTime + i * slotSec,
      open:  parseFloat(o.toFixed(4)),
      high:  parseFloat(h.toFixed(4)),
      low:   parseFloat(l.toFixed(4)),
      close: parseFloat(c.toFixed(4)),
    });
    price = c;
  }

  const last = candles[candles.length - 1];
  last.close = close;
  last.high  = Math.max(last.high, high);
  last.low   = Math.min(last.low,  low);
  last.open  = candles.length > 1 ? candles[candles.length - 2].close : open;

  return candles;
}