'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Measurements, filterStatusNum } = require('../lib/logic');

const quiet = { info: () => {}, debug: () => {} };
const dec = (v) => (v === 'inf' ? Infinity : v === '-inf' ? -Infinity : v === 'nan' ? NaN : v);

test('the same values as the reference implementation (Home Assistant integration / MQTT Bridge)', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'logic-vectors.json'), 'utf8'));
  let steps = 0;
  cases.forEach((c, ci) => {
    const m = new Measurements(quiet, c.poll);
    let last = null;
    let lastKey = '';
    c.steps.forEach((s, si) => {
      // The reference got the very same packet object for a repeated packet.
      const key = JSON.stringify(s.status);
      const status = key === lastKey ? last : Object.fromEntries(Object.entries(s.status).map(([k, v]) => [k, dec(v)]));
      last = status;
      lastKey = key;
      const got = m.take('X', status, s.now);
      const where = `case ${ci} step ${si} ${key}`;
      const [t, h, ta, ha] = s.want.map(dec);
      assert.equal(got.temperature, t === true ? null : t, `temperature ${where}`);
      assert.equal(got.humidity, h, `humidity ${where}`);
      for (const [g, w, name] of [[got.temperatureAvg, ta, 'temperatureAvg'], [got.humidityAvg, ha, 'humidityAvg']]) {
        if (w === null || g === null) assert.equal(g, w, `${name} ${where}`);
        else assert.ok(Math.abs(g - w) <= 0.1001, `${name} ${g} vs ${w} ${where}`);
      }
      steps++;
    });
  });
  assert.ok(steps > 5000);
});

test('plausibility: single impossible readings are held back, a saturated sensor reads 100 %', () => {
  const m = new Measurements(quiet, 30);
  let now = 0;
  const take = (temperature, humidity) => m.take('A', { temperature, humidity, n: now }, (now += 30));
  assert.deepEqual([take(21, 55).temperature, take(21, 55).humidity], [21, 55]);
  assert.equal(take(999, 55).temperature, 21, 'impossible temperature: the last plausible one stands in');
  assert.equal(take(21.5, 0).humidity, 55, '0 % held back');
  assert.equal(take(21.5, 130).humidity, 100, 'saturated');
  assert.equal(take(21.5, 12).humidity, 100, 'a lone dry reading is held back');
  assert.equal(take(21.5, 12).humidity, 12, 'dry air seen before: shown');
  // after the hold time without a plausible value: unknown
  for (let i = 0; i < 25; i++) take(999, 50);
  assert.equal(take(999, 50).temperature, null);
});

test('averaged values: time-weighted mean over the window, unknown until two minutes are covered', () => {
  const m = new Measurements(quiet, 30);
  let now = 0;
  const seen = [];
  for (let i = 0; i < 40; i++) seen.push(m.take('A', { temperature: i % 2 ? 24 : 18, humidity: i % 2 ? 40 : 60, i }, (now += 30)));
  assert.equal(seen[0].temperatureAvg, null);
  assert.equal(seen[2].temperatureAvg, null);
  assert.equal(seen[39].temperatureAvg, 21);
  assert.equal(seen[39].humidityAvg, 50);
});

test('filter status as a number', () => {
  assert.equal(filterStatusNum('Good'), 0);
  assert.equal(filterStatusNum('Medium'), 1);
  assert.equal(filterStatusNum(' bad '), 2);
  assert.equal(filterStatusNum('?'), null);
  assert.equal(filterStatusNum(undefined), null);
});
