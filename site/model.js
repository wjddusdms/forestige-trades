// @ts-check
/** @typedef {'sale'|'lease'|'rent'} Kind */
/** @typedef {{kind:Kind, amount:number, monthly:number, cancelled:boolean, cancelDate:string|null, method:string, date:string, complex:number, area:string, floor:number|null}} Trade */
/** @typedef {{version:number, updatedAt:string|null, fullAt:string|null, fromMonth:string|null, throughMonth:string|null, buckets:Record<string,{trades:Trade[],pending:number}>}} Snapshot */

/** @param {number} amount */
export function won(amount) {
  const major = Math.floor(amount / 10000);
  const remainder = amount % 10000;
  const formatted = remainder.toLocaleString('ko-KR');
  return major ? (remainder ? `${major}억 ${formatted}만원` : `${major}억원`) : `${formatted}만원`;
}

/** @param {Date} [now] */
export function todayInSeoul(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Seoul'}).format(now);
}

/** @param {string} today @param {number} months */
export function monthsBefore(today, months) {
  const [year, month, day] = today.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 - months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(lastDay, day));
  return target.toISOString().slice(0, 10);
}

/** @param {Trade} trade */
export function areaGroup(trade) { return String(Math.floor(Number(trade.area))); }

/** @param {Trade[]} trades @param {{kind:string,complex:string,area:string,from:string,to:string}} filter */
export function selectTrades(trades, {kind, complex, area, from, to}) {
  return trades.filter(trade => trade.kind === kind
    && (!complex || String(trade.complex) === complex)
    && (!area || areaGroup(trade) === area)
    && (!from || trade.date >= from)
    && (!to || trade.date <= to)).sort((a, b) => b.date.localeCompare(a.date));
}

/** @param {Trade[]} selected */
export function summarize(selected) {
  const active = selected.filter(trade => !trade.cancelled);
  return {active, latest: active.filter(trade => trade.date === active[0]?.date),
    cancelled: selected.length - active.length};
}

/** @param {Trade[]} trades @param {string} complex @param {string} exactArea */
export function chartTrades(trades, complex, exactArea) {
  return trades.filter(trade => !trade.cancelled && String(trade.complex) === complex
    && Number(trade.area) === Number(exactArea));
}
