// @ts-check
import {areaGroup, chartTrades, monthsBefore, selectTrades, summarize, todayInSeoul, won} from './model.js';

/** @param {string} id */
function el(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(id);
  return node;
}

/** @param {string} id */
function control(id) {
  const node = el(id);
  if (!(node instanceof HTMLSelectElement || node instanceof HTMLInputElement)) throw new Error(id);
  return node;
}

/** @param {string} id @param {string} value */
function put(id, value) { el(id).textContent = value; }

/** @param {string} id @param {string[]} values @param {(value:string)=>string} label @param {string|null} [empty] */
function options(id, values, label, empty = null) {
  const select = control(id);
  const current = select.value;
  select.replaceChildren(...(empty === null ? [] : [new Option(empty, '')]),
    ...values.map(value => new Option(label(value), value)));
  if (values.includes(current) || (empty !== null && !current)) select.value = current;
  select.disabled = !values.length;
}

/** @param {string[]} values */
const unique = values => [...new Set(values)].sort((a, b) => Number(a) - Number(b));
/** @typedef {import('./model.js').Trade} Trade */
/** @type {import('./model.js').Snapshot|null} */
let snapshot = null;
/** @type {{state:string,attemptAt:string|null}|null} */
let status = null;
let kind = 'sale';
let visible = 30;

/** @param {Trade} trade */
function price(trade) {
  if (trade.kind === 'rent') return `보증금 ${won(trade.amount)} · 월 ${won(trade.monthly)}`;
  return won(trade.amount);
}

/** @param {Trade} trade */
function floorLabel(trade) { return trade.floor === null ? '층 미공개' : `${trade.floor}층`; }

/** @param {Trade} trade */
function detail(trade) {
  return `${trade.date} · ${trade.complex}단지 · ${trade.area}㎡ · ${floorLabel(trade)} · ${price(trade)}`;
}

/** @param {string} value */
function timestamp(value) {
  return new Intl.DateTimeFormat('ko-KR', {dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(value));
}

/** @param {Trade[]} rows @param {'amount'|'monthly'} metric @param {string} heading */
function graph(rows, metric, heading) {
  const title = document.createElement('h3');
  title.textContent = heading;
  const plot = document.createElement('div');
  plot.className = 'chart-box';
  plot.setAttribute('role', 'group');
  plot.setAttribute('aria-label', heading);
  const values = rows.map(trade => trade[metric]);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const pad = Math.max(2, (maximum - minimum) * .12);
  const lo = Math.max(0, Math.floor(minimum - pad));
  const hi = Math.ceil(maximum + pad);
  for (const fraction of [0, .25, .5, .75, 1]) {
    const tick = document.createElement('div');
    tick.className = 'chart-tick';
    tick.style.top = `${fraction * 100}%`;
    tick.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.textContent = won(Math.round(hi - fraction * (hi - lo)));
    tick.append(label);
    plot.append(tick);
  }
  const earliest = Date.parse(rows.at(-1)?.date ?? '');
  const latest = Date.parse(rows[0].date);
  for (const trade of [...rows].reverse()) {
    const point = document.createElement('button');
    point.type = 'button';
    point.className = 'chart-point';
    point.style.left = `${earliest === latest ? 50 : 3 + 94 * (Date.parse(trade.date) - earliest) / (latest - earliest)}%`;
    point.style.top = `${100 * (hi - trade[metric]) / (hi - lo)}%`;
    point.title = detail(trade);
    point.setAttribute('aria-label', point.title);
    for (const event of ['pointerenter', 'focus', 'click']) {
      point.addEventListener(event, () => put('point', point.title));
    }
    plot.append(point);
  }
  const dates = document.createElement('div');
  dates.className = 'chart-dates';
  dates.textContent = rows.at(-1)?.date ?? '';
  if (earliest !== latest) {
    const end = document.createElement('span');
    end.textContent = rows[0].date;
    dates.append(end);
  }
  plot.append(dates);
  return [title, plot];
}

/** @param {Trade[]} rows */
function renderChart(rows) {
  const complexes = unique(rows.map(trade => String(trade.complex)));
  options('chart-complex', complexes, value => `${value}단지`);
  const complex = control('chart-complex').value;
  const exactAreas = unique(rows.filter(trade => String(trade.complex) === complex).map(trade => String(Number(trade.area))));
  options('chart-area', exactAreas, value => `${value}㎡`);
  const series = chartTrades(rows, complex, control('chart-area').value);
  el('chart').replaceChildren();
  put('point', '');
  if (!series.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = snapshot?.updatedAt ? '표시할 유효 거래가 없습니다.' : '데이터 갱신 후 그래프가 표시됩니다.';
    el('chart').append(empty);
    return;
  }
  el('chart').append(...graph(series, 'amount', kind === 'sale' ? '매매금액' : '보증금'));
  if (kind === 'rent') el('chart').append(...graph(series, 'monthly', '월세'));
}

/** @param {Trade[]} rows */
function renderTable(rows) {
  const headings = ['계약일', '단지', '전용면적', '층'];
  headings.push(...(kind === 'sale' ? ['거래금액', '거래 유형', '해제 여부'] : ['보증금']));
  if (kind === 'rent') headings.push('월세');
  const header = document.createElement('tr');
  for (const text of headings) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = text;
    header.append(cell);
  }
  el('head').replaceChildren(header);
  el('body').replaceChildren(...rows.slice(0, visible).map(trade => {
    const row = document.createElement('tr');
    const values = [trade.date, `${trade.complex}단지`, `${trade.area}㎡`, floorLabel(trade), won(trade.amount)];
    if (kind === 'sale') values.push(trade.method || '미공개', trade.cancelled ? `해제 · ${trade.cancelDate ?? '해제일 미공개'}` : '유효');
    if (kind === 'rent') values.push(won(trade.monthly));
    if (trade.cancelled) row.className = 'cancelled';
    for (const value of values) row.insertCell().textContent = value;
    return row;
  }));
  el('table-wrap').hidden = !rows.length;
  el('more').hidden = visible >= rows.length;
}

/** @param {Trade[]} rows */
function renderSummary(rows) {
  const {active, latest, cancelled} = summarize(rows);
  put('count', snapshot?.updatedAt ? `${active.length.toLocaleString('ko-KR')}건` : '—');
  put('cancelled', cancelled ? `해제 ${cancelled}건 별도 표시` : '');
  put('latest', '—');
  if (!latest.length) return;
  put('latest', latest.length > 1 ? `${latest[0].date} 계약 ${latest.length}건` : '');
  const list = document.createElement(latest.length > 1 ? 'ul' : 'div');
  for (const trade of latest) {
    const item = document.createElement(latest.length > 1 ? 'li' : 'div');
    const amount = document.createElement('strong');
    if (latest.length === 1) amount.className = 'amount';
    amount.textContent = price(trade);
    const context = document.createElement('div');
    context.className = 'muted';
    context.textContent = `${trade.date} · ${trade.complex}단지 · ${trade.area}㎡ · ${floorLabel(trade)}`;
    item.append(amount, context);
    list.append(item);
  }
  el('latest').append(list);
}

function render() {
  const buckets = Object.values(snapshot?.buckets ?? {});
  const trades = buckets.flatMap(bucket => bucket.trades);
  const pending = buckets.reduce((sum, bucket) => sum + bucket.pending, 0);
  const period = control('period').value;
  const today = todayInSeoul();
  el('dates').hidden = period !== 'custom';
  const from = period === 'custom' ? control('from').value : period ? monthsBefore(today, Number(period)) : '';
  const to = period === 'custom' ? control('to').value : today;
  const complex = control('complex').value;
  options('area', unique(trades.filter(trade => trade.kind === kind
    && (!complex || String(trade.complex) === complex)).map(areaGroup)), value => `${value}㎡`, '전체');
  const invalid = Boolean(from && to && from > to);
  const rows = invalid ? [] : selectTrades(trades, {kind, complex, area:control('area').value, from, to});
  const failed = status?.state === 'failed';
  const stale = Boolean(snapshot?.updatedAt && Date.now() - Date.parse(snapshot.updatedAt) > 48 * 3600000);
  el('notice').classList.toggle('warning', failed || stale || !status || invalid || (!trades.length && pending > 0));
  const message = failed
    ? (snapshot?.updatedAt ? '자동 갱신에 실패해 마지막 정상 데이터를 표시합니다.' : '자동 갱신에 실패했습니다. 공개할 정상 데이터가 아직 없습니다.')
    : !status ? '갱신 상태를 불러오지 못했습니다.'
    : !snapshot?.updatedAt ? '첫 정상 갱신을 기다리고 있습니다.'
    : stale ? '48시간 넘게 정상 갱신이 확인되지 않아 마지막 정상 데이터를 표시합니다.'
    : pending ? '단지 식별 검증 대상 거래는 공개 집계에서 제외했습니다.'
    : '국토교통부 아파트 매매·전월세 신고 자료';
  put('notice', invalid ? `시작일은 종료일 이전이어야 합니다. ${message}` : message);
  put('updated', snapshot?.updatedAt
    ? `마지막 정상 갱신 ${timestamp(snapshot.updatedAt)} (한국시간) · 계약월 ${snapshot.fromMonth}–${snapshot.throughMonth} · 전체 재검증 ${snapshot.fullAt ? timestamp(snapshot.fullAt) : '—'}`
    : '마지막 정상 갱신 기록 없음');
  el('review').hidden = pending === 0;
  put('review-count', `${pending.toLocaleString('ko-KR')}건`);
  put('list-empty', rows.length ? '' : invalid ? '조회 기간을 다시 선택해 주세요.'
    : !snapshot?.updatedAt ? '정상 데이터가 연결되면 실거래 내역이 표시됩니다.'
    : pending && !trades.length ? '단지 식별을 마친 공개 거래가 아직 없습니다.'
    : '선택한 조건에 해당하는 공개 거래가 없습니다.');
  renderSummary(rows);
  renderChart(rows.filter(trade => !trade.cancelled));
  renderTable(rows);
}

document.querySelectorAll('button[data-kind]').forEach(button => {
  button.addEventListener('click', () => {
    kind = button.getAttribute('data-kind') ?? 'sale';
    for (const tab of document.querySelectorAll('button[data-kind]')) tab.setAttribute('aria-pressed', String(tab === button));
    visible = 30;
    render();
  });
});
for (const id of ['complex','area','period','from','to']) el(id).addEventListener('change', () => { visible = 30; render(); });
for (const id of ['chart-complex','chart-area']) el(id).addEventListener('change', render);
el('more').addEventListener('click', () => { visible += 30; render(); });

/** @param {string} filename */
async function json(filename) {
  const response = await fetch(new URL(`./data/${filename}.json`, import.meta.url), {cache:'no-cache'});
  if (!response.ok) throw new Error('공개 파일 응답 오류');
  return response.json();
}

const [dataResult, statusResult] = await Promise.allSettled([json('snapshot'), json('status')]);
if (dataResult.status === 'fulfilled' && dataResult.value?.version === 1) snapshot = dataResult.value;
if (statusResult.status === 'fulfilled' && statusResult.value?.state) status = statusResult.value;
render();
if (!snapshot) {
  el('notice').classList.add('warning');
  put('notice', '공개 데이터 파일을 불러오지 못했습니다. 잠시 후 다시 확인해 주세요.');
}
