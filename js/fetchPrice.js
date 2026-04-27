import { FINNHUB_KEY, ALPACA_KEY, ALPACA_SECRET, ALPACA_FEED } from '../config.js';

let lastWsTradeAt = new Map(); // ticker -> Date.now() ms

export const callbacks = {
  onPriceUpdate:   (symbol, price) => {},
  onQuoteUpdate:   (symbol, quote) => {},
  onExtendedPrice: (symbol, price, session) => {},
};

// Stocks route to Alpaca; crypto stays on Finnhub.
export const SYMBOLS = {
  'Sandisk':   { ticker: 'SNDK',             type: 'stock'  },
  'Apple':     { ticker: 'AAPL',             type: 'stock'  },
  'Micron':    { ticker: 'MU',               type: 'stock'  },
  'ASML':      { ticker: 'ASML',             type: 'stock'  },
  'Gold':      { ticker: 'GLD',              type: 'stock'  },
  'Silver':    { ticker: 'SLV',              type: 'stock'  },
  'Copper':    { ticker: 'CPER',             type: 'stock'  },
  'Crude Oil': { ticker: 'USO',              type: 'stock'  },
  'Bitcoin':   { ticker: 'BINANCE:BTCUSDT',  type: 'crypto' },
  'Ethereum':  { ticker: 'BINANCE:ETHUSDT',  type: 'crypto' },
  'Litecoin':  { ticker: 'BINANCE:LTCUSDT',  type: 'crypto' },
  'Solana':    { ticker: 'BINANCE:SOLUSDT',  type: 'crypto' },
  'Ripple':    { ticker: 'BINANCE:XRPUSDT',  type: 'crypto' },
};

// ── Alpaca WebSocket (stocks) ─────────────────────────────────────────────────

let alpacaSocket       = null;
let alpacaConnecting   = false;
let alpacaReconnTimer  = null;
let alpacaAuthed       = false;
const alpacaSubscribed = new Set(); // stock tickers

function connectAlpaca() {
  if (alpacaConnecting) return;
  alpacaConnecting = true;
  clearTimeout(alpacaReconnTimer);

  alpacaSocket = new WebSocket(`wss://stream.data.alpaca.markets/v2/${ALPACA_FEED}`);

  alpacaSocket.addEventListener('open', () => {
    console.log('[Alpaca] WebSocket connected — authenticating...');
    alpacaSocket.send(JSON.stringify({ action: 'auth', key: ALPACA_KEY, secret: ALPACA_SECRET }));
  });

  alpacaSocket.addEventListener('message', (event) => {
    const messages = JSON.parse(event.data);
    for (const msg of messages) {
      switch (msg.T) {
        case 'success':
          if (msg.msg === 'authenticated') {
            console.log('[Alpaca] Authenticated');
            alpacaConnecting = false;
            alpacaAuthed     = true;
            // Re-subscribe to all tracked stocks
            if (alpacaSubscribed.size > 0) {
              alpacaSocket.send(JSON.stringify({ action: 'subscribe', trades: [...alpacaSubscribed] }));
            }
          }
          break;

        case 'error':
          console.error('[Alpaca] WS error message:', msg.msg, msg.code);
          break;

        case 't': // trade
          lastWsTradeAt.set(msg.S, Date.now());
          callbacks.onPriceUpdate(msg.S, msg.p);
          break;

        default:
          break;
      }
    }
  });

  alpacaSocket.addEventListener('close', () => {
    console.warn('[Alpaca] WebSocket closed — reconnecting in 1.5s...');
    alpacaConnecting = false;
    alpacaAuthed     = false;
    alpacaReconnTimer = setTimeout(connectAlpaca, 1_500);
  });

  alpacaSocket.addEventListener('error', () => {
    alpacaSocket.close(); // let 'close' handle the reconnect
  });
}

function alpacaSubscribe(ticker) {
  alpacaSubscribed.add(ticker);
  if (alpacaAuthed && alpacaSocket?.readyState === WebSocket.OPEN) {
    alpacaSocket.send(JSON.stringify({ action: 'subscribe', trades: [ticker] }));
  }
}

function alpacaUnsubscribe(ticker) {
  alpacaSubscribed.delete(ticker);
  if (alpacaSocket?.readyState === WebSocket.OPEN) {
    alpacaSocket.send(JSON.stringify({ action: 'unsubscribe', trades: [ticker] }));
  }
}

// ── Finnhub WebSocket (crypto only) ──────────────────────────────────────────

let finnhubSocket      = null;
let finnhubConnecting  = false;
let finnhubReconnTimer = null;
let finnhubHeartbeat   = null;
const finnhubSubscribed = new Set(); // crypto tickers

function connectFinnhub() {
  if (finnhubConnecting) return;
  finnhubConnecting = true;
  clearTimeout(finnhubReconnTimer);
  clearInterval(finnhubHeartbeat);

  finnhubSocket = new WebSocket(`wss://ws.finnhub.io?token=${FINNHUB_KEY}`);

  finnhubSocket.addEventListener('open', () => {
    console.log('[Finnhub] WebSocket connected');
    finnhubConnecting = false;
    finnhubSubscribed.forEach(ticker => finnhubSend('subscribe', ticker));

    // Finnhub silently drops idle connections after ~60s
    finnhubHeartbeat = setInterval(() => {
      if (finnhubSocket?.readyState === WebSocket.OPEN)
        finnhubSocket.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);
  });

  finnhubSocket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type !== 'trade' || !data.data?.length) return;

    const latest = data.data.reduce((best, trade) =>
      trade.t > best.t ? trade : best
    );
    lastWsTradeAt.set(latest.s, Date.now());
    callbacks.onPriceUpdate(latest.s, latest.p);
  });

  finnhubSocket.addEventListener('close', () => {
    console.warn('[Finnhub] WebSocket closed — reconnecting in 1.5s...');
    clearInterval(finnhubHeartbeat);
    finnhubConnecting = false;
    finnhubReconnTimer = setTimeout(connectFinnhub, 1_500);
  });

  finnhubSocket.addEventListener('error', () => {
    finnhubSocket.close();
  });
}

function finnhubSend(type, ticker) {
  if (finnhubSocket?.readyState === WebSocket.OPEN)
    finnhubSocket.send(JSON.stringify({ type, symbol: ticker }));
}

// ── Public API ────────────────────────────────────────────────────────────────

export function subscribeByName(name) {
  const entry = SYMBOLS[name];
  if (!entry) return;
  const { ticker, type } = entry;

  if (type === 'stock') {
    alpacaSubscribe(ticker);
    fetchQuoteByName(name); // seed price + stats via REST snapshot
  } else {
    if (!finnhubSubscribed.has(ticker)) {
      finnhubSubscribed.add(ticker);
      finnhubSend('subscribe', ticker);
    }
  }
}

export function unsubscribeByName(name) {
  const entry = SYMBOLS[name];
  if (!entry) return;
  const { ticker, type } = entry;

  if (type === 'stock') {
    alpacaUnsubscribe(ticker);
  } else {
    finnhubSubscribed.delete(ticker);
    finnhubSend('unsubscribe', ticker);
  }
}

/**
 * Fetch a full quote snapshot from Alpaca for stocks.
 * Crypto has no equivalent REST endpoint — the WS price is the only source.
 */
export async function fetchQuoteByName(name) {
  const entry = SYMBOLS[name];
  if (!entry || entry.type === 'crypto') return null;
  const { ticker } = entry;

  try {
    const res = await fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/snapshot?feed=${ALPACA_FEED}`,
      {
        headers: {
          'APCA-API-KEY-ID':     ALPACA_KEY,
          'APCA-API-SECRET-KEY': ALPACA_SECRET,
        },
      }
    );

    if (!res.ok) {
      console.warn(`[Alpaca] HTTP ${res.status} fetching snapshot for ${name}`);
      return null;
    }

    const snap = await res.json();

    const current   = snap.latestTrade?.p ?? snap.dailyBar?.c;
    const prevClose = snap.prevDailyBar?.c ?? current;
    const open      = snap.dailyBar?.o    ?? current;
    const high      = snap.dailyBar?.h    ?? current;
    const low       = snap.dailyBar?.l    ?? current;

    if (current == null) {
      console.warn(`[Alpaca] Snapshot has no price for ${name}`);
      return null;
    }

    const change    = parseFloat((current - prevClose).toFixed(2));
    const changePct = prevClose ? parseFloat(((current - prevClose) / prevClose * 100).toFixed(2)) : 0;

    const quote = { name, ticker, current, prevClose, open, high, low, change, changePct };
    callbacks.onQuoteUpdate(name, quote);

    // Only push a price update from REST if the WS hasn't sent anything fresher.
    const wsAge = Date.now() - (lastWsTradeAt.get(ticker) ?? 0);
    if (wsAge > 5_000) callbacks.onPriceUpdate(ticker, current);

    determineExtendedSession(name, current);
    return quote;

  } catch (err) {
    console.error(`[Alpaca] Failed to fetch snapshot for ${name}:`, err);
    return null;
  }
}

/**
 * Determine whether we're in pre / regular / post market and fire
 * onExtendedPrice accordingly — mirrors the logic that was in Finnhub's
 * fetchExtendedPrice() but based on the current wall-clock time rather
 * than a quote timestamp.
 */
function determineExtendedSession(name, price) {
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date());

  const get  = t => etParts.find(p => p.type === t)?.value ?? '0';
  const day  = get('weekday');
  const mins = parseInt(get('hour')) * 60 + parseInt(get('minute'));

  if (['Sat', 'Sun'].includes(day)) return;

  const isPre     = mins >= 4 * 60 && mins < 9 * 60 + 30;
  const isRegular = mins >= 9 * 60 + 30 && mins < 16 * 60;
  const isPost    = mins >= 16 * 60 && mins < 20 * 60;

  if (isPre)     callbacks.onExtendedPrice(name, price, 'pre');
  if (isPost)    callbacks.onExtendedPrice(name, price, 'post');
  if (isRegular) callbacks.onExtendedPrice(name, price, 'regular');
}

// ── Boot both sockets ─────────────────────────────────────────────────────────

connectAlpaca();
connectFinnhub();