'use strict';

/** "homey" resolves to the stand-in; the times of the Account are shortened. */
const Module = require('module');
const path = require('path');

const original = Module._resolveFilename;
Module._resolveFilename = function resolve(request, ...rest) {
  if (request === 'homey') return path.join(__dirname, 'fake-homey.js');
  return original.call(this, request, ...rest);
};

const { TIMING } = require('../lib/account');

Object.assign(TIMING, {
  pollS: 0.3,
  unitsIntervalS: 600,
  retryFirstS: 0.2,
  retryMaxS: 0.8,
  retryRejectedS: 0.6,
  afterCommandS: 0.25,
  afterResetS: 0.25,
  requestS: 0.8,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Waits until fn() is true; fails after the time limit. */
async function until(fn, ms = 4000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

module.exports = { TIMING, sleep, until };
