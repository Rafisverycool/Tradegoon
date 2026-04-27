/**
 * Returns the market state for a given stock/commodity name.
 * 'open' | 'pre' | 'post' | 'closed'
 */
export function getMarketState(name) {
  const COMMODITIES = ['Gold', 'Silver', 'Copper', 'Crude Oil'];
  if (COMMODITIES.includes(name)) return forexState();
  if (name === 'ASML')            return euronextState();
  return usState();
}

/* ── Shared helper ── */

/** Returns { mins, day } localised to an IANA timezone. */
function zoneInfo(tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday:  'short',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).formatToParts(new Date());

  const get  = t => parts.find(p => p.type === t)?.value ?? '0';
  const day  = get('weekday');                                      // 'Mon'…'Sun'
  const mins = parseInt(get('hour')) * 60 + parseInt(get('minute'));
  return { mins, day };
}

/* ── Market rules ── */

/**
 * Forex / commodity (OANDA):
 *   Reference timezone: America/New_York
 *   Opens  Sunday  17:00 ET
 *   Closes Friday  17:00 ET
 *   Closed all Saturday + Sunday before 17:00 ET
 */
function forexState() {
  const { mins, day } = zoneInfo('America/New_York');
  if (day === 'Sat')                         return 'closed';
  if (day === 'Sun' && mins < 17 * 60)       return 'closed';
  if (day === 'Fri' && mins >= 17 * 60)      return 'closed';
  return 'open';
}

/**
 * Euronext Amsterdam (ASML):
 *   Regular  09:00 – 17:30 CET/CEST  (no pre/post market)
 */
function euronextState() {
  const { mins, day } = zoneInfo('Europe/Amsterdam');
  if (day === 'Sat' || day === 'Sun')            return 'closed';
  if (mins >= 9 * 60 && mins < 17 * 60 + 30)    return 'open';
  return 'closed';
}

/**
 * NYSE / NASDAQ (US stocks):
 *   Pre-market   04:00 – 09:30 ET
 *   Regular      09:30 – 16:00 ET
 *   After-hours  16:00 – 20:00 ET
 *   Closed otherwise + weekends
 */
function usState() {
  const { mins, day } = zoneInfo('America/New_York');
  if (day === 'Sat' || day === 'Sun')            return 'closed';
  if (mins >= 4 * 60  && mins < 9 * 60 + 30)    return 'pre';
  if (mins >= 9 * 60 + 30 && mins < 16 * 60)    return 'open';
  if (mins >= 16 * 60 && mins < 20 * 60)         return 'post';
  return 'closed';
}