import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chartTrades, monthsBefore, selectTrades, summarize, todayInSeoul, won} from '../site/model.js';

const a = {kind:'sale', date:'2026-10-01', complex:1, area:'84.9849', amount:90000, floor:8, cancelled:false};
const b = {...a, amount:91000};
const otherArea = {...a, area:'84.9900'};
const cancelled = {...a, date:'2026-11-01', cancelled:true};
const trades = [a,b,otherArea,cancelled,{...a,complex:2},
  {...a,kind:'lease',complex:3}, {...a,kind:'rent',complex:3,monthly:110}];
const filters = {kind:'sale', complex:'1', area:'84', from:'2026-10-01', to:'2026-10-31'};

test('filters transaction kind, complex, nominal area and inclusive dates', () => {
  assert.deepEqual(selectTrades(trades, filters), [a,b,otherArea]);
  assert.equal(selectTrades(trades, {...filters,kind:'lease',complex:'3'}).length, 1);
  assert.equal(selectTrades(trades, {...filters,kind:'rent',complex:'3'})[0].monthly, 110);
  assert.deepEqual(selectTrades(trades, {...filters,area:'59'}), []);
  assert.deepEqual(selectTrades(trades, {...filters,from:'2026-10-02'}), []);
});

test('latest day keeps each valid transaction and excludes cancellations', () => {
  const selected = selectTrades(trades, {...filters,to:''});
  const summary = summarize(selected);
  assert.deepEqual(summary.latest, [a,b,otherArea]);
  assert.equal(summary.cancelled, 1);
  assert.deepEqual(chartTrades(selected, '1', '84.9849'), [a,b]);
});

test('Korea date boundaries, calendar ranges and amounts', () => {
  assert.equal(todayInSeoul(new Date('2026-10-31T15:00:00Z')), '2026-11-01');
  assert.equal(monthsBefore('2026-05-31', 3), '2026-02-28');
  assert.equal(monthsBefore('2024-05-31', 3), '2024-02-29');
  assert.equal(won(97500), '9억 7,500만원');
});
