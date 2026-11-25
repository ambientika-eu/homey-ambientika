'use strict';

/**
 * What is shown for a unit, worked out from its status packets.
 *
 * The same rules as in the Ambientika MQTT Bridge and in the integration
 * "Ambientika for Home Assistant", so all of them show the same values:
 *
 * - Temperature and humidity pass a plausibility check: a single impossible
 *   reading is held back, a saturated humidity sensor (above 100 %) reads 100 %.
 * - Averaged temperature and humidity: the unit reverses its airflow about every
 *   minute, so its sensor sees room air and incoming air in turn. The averaged
 *   values carry the time-weighted mean over a sliding window.
 *
 * This module does not use Homey.
 */

// Plausibility of the two measured values. Values outside the hard limits are
// never shown. A humidity reading below HUMIDITY_LOW_SUSPECT is shown only if
// dry air (below HUMIDITY_LOW_CONFIRM) was already seen: among the previous
// HUMIDITY_LOW_READINGS readings, or a shown dry reading within
// HUMIDITY_LOW_WINDOW_S. Meanwhile the last plausible value stands in, for at
// most PLAUSIBLE_HOLD_S; after that the value is unknown.
const HUMIDITY_PLAUSIBLE = [1, 100];
const HUMIDITY_SATURATED = 100;
const TEMPERATURE_PLAUSIBLE = [-40, 85];
const HUMIDITY_LOW_SUSPECT = 20;
const HUMIDITY_LOW_CONFIRM = 25;
const HUMIDITY_LOW_READINGS = 3;
const HUMIDITY_LOW_WINDOW_S = 3600;
const PLAUSIBLE_HOLD_S = 600;
// A status identical to the one read before is the same packet handed out again,
// unless it has been the same for longer than this.
const DUPLICATE_PACKET_MAX_S = 120;

// Averaged values.
const AVERAGE_WINDOW_S = 1800;
const AVERAGE_MIN_POLLS = 20;
const AVERAGE_MAX_GAP_POLLS = 2;
const AVERAGE_MIN_COVER_S = 120;

const FILTER_STATUS_NUM = { good: 0, medium: 1, bad: 2 };

/** Filter status as a number, 0 (good) to 2 (bad); null if unknown. */
function filterStatusNum(value) {
  if (typeof value !== 'string') return null;
  const n = FILTER_STATUS_NUM[value.trim().toLowerCase()];
  return n === undefined ? null : n;
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sameStatus(a, b) {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const x = a[k];
    const y = b[k];
    if (x !== y && !(typeof x === 'number' && typeof y === 'number' && Number.isNaN(x) && Number.isNaN(y))) return false;
  }
  return true;
}

class Measurements {
  /**
   * @param {{info: Function, debug: Function}} log
   * @param {number} pollIntervalS seconds between two readings
   */
  constructor(log, pollIntervalS) {
    this.log = log;
    this.pollInterval = Math.max(1, Number(pollIntervalS) || 30);
    this.windowS = AVERAGE_WINDOW_S;
    this.plausibleState = new Map(); // serial -> { temperature: st, humidity: st }
    this.lastStatus = new Map(); // serial -> [packet, time]
    this.avgBuf = new Map(); // serial -> { temperature: [[t, v]], humidity: [[t, v]] }
  }

  forget(serial) {
    this.plausibleState.delete(serial);
    this.lastStatus.delete(serial);
    this.avgBuf.delete(serial);
  }

  /** False if the status is the packet of the reading before. */
  isFresh(serial, status, now) {
    const prev = this.lastStatus.get(serial);
    const fresh = !prev || !sameStatus(status, prev[0]) || now - prev[1] > DUPLICATE_PACKET_MAX_S;
    if (fresh) this.lastStatus.set(serial, [{ ...status }, now]);
    return fresh;
  }

  /**
   * One status packet.
   *
   * @param {string} serial
   * @param {object} status packet of the cloud
   * @param {number} [now] seconds, monotonic
   * @returns {{temperature: number|null, humidity: number|null, temperatureAvg: number|null, humidityAvg: number|null}}
   */
  take(serial, status, now = Date.now() / 1000) {
    const fresh = this.isFresh(serial, status, now);
    const [temperature, temperatureAvg] = this.measured(serial, 'temperature', status.temperature, fresh, now);
    const [humidity, humidityAvg] = this.measured(serial, 'humidity', status.humidity, fresh, now);
    return { temperature, humidity, temperatureAvg, humidityAvg };
  }

  /** [shown value, averaged value] of one measured value. */
  measured(serial, key, value, fresh, now) {
    const shown = this.plausible(serial, key, value, fresh, now);
    const st = (this.plausibleState.get(serial) || {})[key];
    const held = !!st && st.bad > 0;
    return [shown, this.average(serial, key, held ? null : shown, now)];
  }

  /** The value to show for a measured value. */
  plausible(serial, key, value, fresh, now) {
    if (value === null || value === undefined) return null;
    let unit = this.plausibleState.get(serial);
    if (!unit) {
      unit = {};
      this.plausibleState.set(serial, unit);
    }
    if (!unit[key]) {
      unit[key] = { last: null, t: 0, bad: 0, dry: [], dryT: null, gone: false, out: null, logT: null, loud: true, sat: false, satLogT: null };
    }
    const st = unit[key];
    if (st.bad === 0) st.loud = st.logT === null || now - st.logT >= 3600;
    const note = (text) => (st.loud ? this.log.info(text) : this.log.debug(text));
    const expired = st.last !== null && now - st.t > PLAUSIBLE_HOLD_S;
    const same = (a, b) => a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b));
    if (!fresh && st.out !== null && same(st.out[1], value)) {
      // The same packet as last time: the decision is repeated.
      if (st.bad === 0 || !expired) return st.out[0];
      if (!st.gone) note(`${key} of ${serial}: no plausible value for ${Math.round(PLAUSIBLE_HOLD_S / 60)} min - shown as unknown`);
      st.gone = true;
      st.out = [null, value];
      return null;
    }
    const [low, high] = key === 'humidity' ? HUMIDITY_PLAUSIBLE : TEMPERATURE_PLAUSIBLE;
    let v = finite(value);
    let shownValue = v;
    if (key === 'humidity' && v !== null && v > high) {
      if (!st.sat) {
        const loud = st.satLogT === null || now - st.satLogT >= 3600;
        const text = `${key} ${value} from ${serial} above ${high} % - sensor saturated, shown as ${HUMIDITY_SATURATED} %`;
        if (loud) {
          this.log.info(text);
          st.satLogT = now;
        } else {
          this.log.debug(text);
        }
      }
      st.sat = true;
      v = HUMIDITY_SATURATED;
      shownValue = HUMIDITY_SATURATED;
    } else if (v !== null) {
      st.sat = false;
    }
    let ok = v !== null && v >= low && v <= high;
    let why = `outside ${low}..${high}`;
    if (ok && key === 'humidity') {
      const window = Math.max(HUMIDITY_LOW_WINDOW_S, 6 * this.pollInterval);
      const seenDry = st.dry.some(Boolean) || (st.dryT !== null && now - st.dryT <= window);
      if (v < HUMIDITY_LOW_SUSPECT && !seenDry) {
        ok = false;
        why = `below ${HUMIDITY_LOW_SUSPECT} % without dry air in the last ${HUMIDITY_LOW_READINGS} readings or ${Math.round(window / 60)} min`;
      }
      st.dry.push(v < HUMIDITY_LOW_CONFIRM);
      while (st.dry.length > HUMIDITY_LOW_READINGS) st.dry.shift();
      if (ok && v < HUMIDITY_LOW_CONFIRM) st.dryT = now;
    }
    if (ok) {
      if (st.bad) note(`${key} of ${serial} plausible again (${value}) after ${st.bad} held-back value(s)`);
      Object.assign(st, { last: shownValue, t: now, bad: 0, gone: false, out: [shownValue, value] });
      return shownValue;
    }
    if (st.bad === 0) {
      note(`${key} ${JSON.stringify(value)} from ${serial} held back (${why}) - showing the last plausible value ${st.last} meanwhile`);
      if (st.loud) st.logT = now;
    }
    st.bad += 1;
    if (st.last !== null && !expired) {
      st.out = [st.last, value];
      return st.last;
    }
    if (!st.gone && st.last !== null) note(`${key} of ${serial}: no plausible value for ${Math.round(PLAUSIBLE_HOLD_S / 60)} min - shown as unknown`);
    st.gone = true;
    st.out = [null, value];
    return null;
  }

  /** Records a reading and returns the time-weighted mean (null: unknown). */
  average(serial, key, value, now) {
    const interval = this.pollInterval;
    const window = Math.max(this.windowS, AVERAGE_MIN_POLLS * interval);
    const cap = AVERAGE_MAX_GAP_POLLS * interval;
    const start = now - window;
    let unit = this.avgBuf.get(serial);
    if (!unit) {
      unit = {};
      this.avgBuf.set(serial, unit);
    }
    if (!unit[key]) unit[key] = [];
    const buf = unit[key];
    buf.push([now, finite(value)]);
    // One record before the window stays as the anchor of the first inside.
    while (buf.length > 1 && buf[1][0] <= start) buf.shift();
    let num = 0;
    let den = 0;
    let count = 0;
    let prevT = null;
    let lastOk = null;
    for (const [t, x] of buf) {
      const span = Math.min(cap, prevT === null ? interval : t - prevT);
      prevT = t;
      const weight = t - Math.max(t - span, start);
      if (x === null || weight <= 0) continue;
      num += x * weight;
      den += weight;
      count += 1;
      lastOk = t;
    }
    if (count < 2 || den < Math.min(AVERAGE_MIN_COVER_S, window) || den <= 0) return null;
    if (now - lastOk > Math.max(PLAUSIBLE_HOLD_S, AVERAGE_MAX_GAP_POLLS * interval)) return null;
    return Math.round((num / den) * 10) / 10;
  }
}

module.exports = {
  Measurements,
  filterStatusNum,
  HUMIDITY_PLAUSIBLE,
  HUMIDITY_SATURATED,
  TEMPERATURE_PLAUSIBLE,
  HUMIDITY_LOW_SUSPECT,
  HUMIDITY_LOW_CONFIRM,
  PLAUSIBLE_HOLD_S,
  DUPLICATE_PACKET_MAX_S,
  AVERAGE_WINDOW_S,
};
