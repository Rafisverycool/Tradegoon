let canvas         = null;
let ctx            = null;
let candles        = [];        // historical candles (already-closed)
let currentCandle  = null;      // the live, still-open candle
let resizeObserver = null;
let extPrice       = null;      // { price, session } pre/post market line
let intervalMs     = 5 * 60_000;

// Layout constants
const PAD  = { top: 16, right: 80, bottom: 32, left: 8 };
const GAP  = 3;   // px gap between candles

// The chart always shows TOTAL_SLOTS columns.
// The live candle sits at LIVE_SLOT (0-indexed from left).
// Slots to the right of the live candle are blank — giving a "live edge" feel.
const TOTAL_SLOTS = 21;
const LIVE_SLOT   = 10;  // live candle is always in the middle column

let CW = 10; // candle body width, recalculated on resize

// ── Init ──────────────────────────────────────────────────────────────────────

export function initChart(intervalMsHint) {
  if (intervalMsHint != null) intervalMs = intervalMsHint;
  if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }

  const container = document.getElementById('chart-area');
  container.innerHTML = '';

  canvas = document.createElement('canvas');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  container.appendChild(canvas);
  ctx = canvas.getContext('2d');

  fitCanvas();
  drawEmpty('Select a stock to view chart');

  resizeObserver = new ResizeObserver(() => {
    if (!canvas || !canvas.isConnected) return;
    fitCanvas();
    (candles.length || currentCandle) ? draw() : drawEmpty('Select a stock to view chart');
  });
  resizeObserver.observe(container);
}

function fitCanvas() {
  if (!canvas || !canvas.parentElement) return;
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width  = r.width  || 600;
  canvas.height = r.height || 340;
  recalcCW();
}

function recalcCW() {
  if (!canvas) return;
  const chartW = canvas.width - PAD.left - PAD.right;
  const ideal  = Math.floor((chartW - GAP * (TOTAL_SLOTS - 1)) / TOTAL_SLOTS);
  CW = Math.max(4, ideal);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Seed with historical candle array (already-closed candles). */
export function loadCandles(data, intervalMsHint) {
  if (intervalMsHint != null) intervalMs = intervalMsHint;
  const all = data ?? [];
  // Keep up to LIVE_SLOT historical candles (the slots left of the live candle)
  candles       = all.slice(-LIVE_SLOT);
  currentCandle = candles.pop() ?? null; // last fetched candle becomes the live one
  recalcCW();
  draw();
}

/**
 * Live WebSocket tick.
 * Opens a new candle when the current time slot advances, otherwise updates.
 */
export function updateLiveTick(price, intervalMsOverride) {
  const ms      = intervalMsOverride ?? intervalMs;
  const slotSec = Math.max(1, Math.floor(ms / 1000));
  const slotTime = Math.floor(Date.now() / 1000 / slotSec) * slotSec;

  if (!currentCandle || currentCandle.time < slotTime) {
    // Current candle closed — push it to history, open new one
    if (currentCandle) {
      candles.push({ ...currentCandle });
      if (candles.length > LIVE_SLOT) candles.shift();
    }
    const open    = currentCandle ? currentCandle.close : price;
    currentCandle = { time: slotTime, open, high: price, low: price, close: price };
  } else {
    currentCandle.high  = Math.max(currentCandle.high,  price);
    currentCandle.low   = Math.min(currentCandle.low,   price);
    currentCandle.close = price;
  }

  draw();
}

/** Pre/post-market reference line. session: 'pre'|'post'|'regular' */
export function setExtendedPrice(price, session) {
  extPrice = session === 'regular' ? null : { price, session };
  if (candles.length || currentCandle) draw();
}

export function clearChart() {
  candles       = [];
  currentCandle = null;
  extPrice      = null;
  if (ctx && canvas) { fitCanvas(); drawEmpty('Loading...'); }
}

// ── Draw ──────────────────────────────────────────────────────────────────────

function drawEmpty(msg = 'Waiting for data...') {
  if (!ctx || !canvas) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle    = '#aaa';
  ctx.font         = '13px Segoe UI,Tahoma,sans-serif';
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
  ctx.textBaseline = 'alphabetic';
}

function draw() {
  if (!ctx || !canvas || !canvas.isConnected) return;
  if (!candles.length && !currentCandle) { drawEmpty('Waiting for data...'); return; }

  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  // Build the slot array: indices 0..(LIVE_SLOT-1) = history, LIVE_SLOT = live, rest = null
  const slots = new Array(TOTAL_SLOTS).fill(null);
  const histStart = LIVE_SLOT - candles.length;
  candles.forEach((c, i) => { slots[histStart + i] = c; });
  slots[LIVE_SLOT] = currentCandle;

  // Price range across all non-null slots
  let lo = Infinity, hi = -Infinity;
  for (const c of slots) {
    if (!c) continue;
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  if (extPrice) { lo = Math.min(lo, extPrice.price); hi = Math.max(hi, extPrice.price); }
  if (!isFinite(lo)) return;

  // ── Vertical scaling ───────────────────────────────────────────────────────
  // Pad by a fraction of the actual data range so candles always fill the chart,
  // regardless of timeframe. A floor prevents collapse on perfectly flat data.
  const mid       = (lo + hi) / 2;
  const dataRange = Math.max(hi - lo, mid * 0.0002); // floor: 0.02% of price
  const pad       = dataRange * 0.22;                // 22% breathing room each side
  const pMin      = lo - pad;
  const pMax      = hi + pad;
  const pRange    = pMax - pMin;
  const py        = p => PAD.top + chartH * (1 - (p - pMin) / pRange);

  // ── Grid lines + right-axis labels ────────────────────────────────────────
  // Pick a "nice" step so we always get ~5-7 evenly-spaced grid lines.
  const step       = niceStep(pRange, 6);
  const firstTick  = Math.ceil(pMin / step) * step;

  ctx.font      = '10px Segoe UI,Tahoma,sans-serif';
  ctx.textAlign = 'left';

  for (let p = firstTick; p <= pMax + step * 0.01; p += step) {
    const y = py(p);
    if (y < PAD.top - 1 || y > H - PAD.bottom + 1) continue;

    ctx.strokeStyle = 'rgba(0,0,0,0.07)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#888';
    ctx.fillText(fmtPrice(p), W - PAD.right + 5, y + 3.5);
  }

  // ── Candles ────────────────────────────────────────────────────────────────
  slots.forEach((c, i) => {
    if (!c) return;
    const cx     = PAD.left + i * (CW + GAP) + CW / 2;
    const isUp   = c.close >= c.open;
    const isLive = i === LIVE_SLOT;
    const color  = isUp ? '#16a34a' : '#dc2626';

    const bodyTop = py(Math.max(c.open, c.close));
    const bodyBot = py(Math.min(c.open, c.close));
    const bodyH   = Math.max(1, bodyBot - bodyTop);

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(cx, py(c.high));
    ctx.lineTo(cx, py(c.low));
    ctx.stroke();

    // Body — live candle gets a subtle glow border
    if (isLive) {
      ctx.fillStyle = color + '33';
      ctx.fillRect(cx - CW / 2 - 1, bodyTop - 1, CW + 2, bodyH + 2);
    }
    ctx.fillStyle = color;
    ctx.fillRect(cx - CW / 2, bodyTop, CW, bodyH);
  });

  // ── Pre/post market line ───────────────────────────────────────────────────
  if (extPrice) {
    const y         = py(extPrice.price);
    const isPre     = extPrice.session === 'pre';
    const lineColor = isPre ? '#f97316' : '#a855f7';
    const label     = isPre ? 'PRE' : 'POST';

    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth   = 1.5;
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(W - PAD.right, y); ctx.stroke();
    ctx.restore();

    // Pill tag
    const tagText = fmtPrice(extPrice.price);
    ctx.font      = 'bold 10px Segoe UI,Tahoma,sans-serif';
    const tw      = ctx.measureText(tagText).width;
    const tagW    = tw + 10, tagH = 16;
    const tagX    = W - PAD.right + 2;
    ctx.fillStyle = lineColor;
    roundRect(ctx, tagX, y - tagH / 2, tagW, tagH, 4); ctx.fill();
    ctx.fillStyle = 'white'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(tagText, tagX + 5, y);
    ctx.textBaseline = 'alphabetic';

    ctx.font = 'bold 9px Segoe UI,Tahoma,sans-serif';
    ctx.fillStyle = lineColor; ctx.textAlign = 'left'; ctx.globalAlpha = 0.9;
    ctx.fillText(label, PAD.left + 4, y - 4);
    ctx.globalAlpha = 1;
  }

  // ── Time axis ──────────────────────────────────────────────────────────────
  ctx.fillStyle = '#888'; ctx.textAlign = 'center';
  ctx.font = '10px Segoe UI,Tahoma,sans-serif';
  const labelEvery = Math.max(1, Math.ceil(TOTAL_SLOTS / Math.floor(chartW / 72)));
  slots.forEach((c, i) => {
    if (!c || i % labelEvery !== 0) return;
    const x = PAD.left + i * (CW + GAP) + CW / 2;
    const allTimes = slots.filter(Boolean).map(s => s.time);
    const span = allTimes.length > 1 ? allTimes[allTimes.length - 1] - allTimes[0] : 1;
    ctx.fillText(fmtTime(new Date(c.time * 1000), span), x, H - PAD.bottom + 14);
  });

  // ── Axis border lines ──────────────────────────────────────────────────────
  ctx.strokeStyle = 'rgba(0,0,0,0.1)'; ctx.lineWidth = 1; ctx.setLineDash([]);
  ctx.beginPath(); ctx.moveTo(PAD.left, H - PAD.bottom); ctx.lineTo(W - PAD.right, H - PAD.bottom); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(W - PAD.right, PAD.top);   ctx.lineTo(W - PAD.right, H - PAD.bottom); ctx.stroke();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Returns a "nice" round step size that produces approximately `targetLines`
 * grid lines across `range`. Snaps to 1 / 2 / 5 multiples of the magnitude.
 */
function niceStep(range, targetLines = 6) {
  const raw  = range / targetLines;
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)));
  const n    = raw / mag;
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return nice * mag;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function fmtPrice(p) {
  if (p >= 10000) return `$${p.toFixed(0)}`;
  if (p >= 100)   return `$${p.toFixed(2)}`;
  return `$${p.toFixed(4)}`;
}

function fmtTime(date, spanSec) {
  if (spanSec < 86400 * 2)  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (spanSec < 86400 * 60) return date.toLocaleDateString([],  { month: 'short', day: 'numeric' });
  return date.toLocaleDateString([], { month: 'short', year: '2-digit' });
}