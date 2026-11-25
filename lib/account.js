'use strict';

/**
 * One Ambientika account: signs in, reads all units of the account at a fixed
 * interval and sends the commands of the Homey devices.
 *
 * All devices of the same account share one Account, so the cloud is asked once
 * per interval for each unit, however many devices Homey shows. The logic is the
 * one of the Matterbridge plugin and the ioBroker adapter of Südwind.
 *
 * Events, per unit (serial):
 *   listener.onStatus(status)        a new status packet
 *   listener.onReachable(boolean)    the unit answers / does not answer
 *   listener.onUnit(unit)            the unit as the cloud lists it (name, role, room)
 *   listener.onRemoved()             the unit is no longer in the account
 * and for the account:
 *   account.on('rejected', message)  the cloud does not accept e-mail address and password
 */

const { EventEmitter } = require('events');
const {
  AmbientikaCloud,
  CloudError,
  OPERATING_MODES,
  FAN_SPEEDS,
  HUMIDITY_LEVELS,
  LIGHT_SENSOR_LEVELS,
} = require('./cloud');

/** Times in seconds. An object, so that the tests can shorten them. */
const TIMING = {
  /** between two readings of all units */
  pollS: 30,
  /** between two readings of the list of units (new units, new names) */
  unitsIntervalS: 600,
  /** until the next try after the cloud could not be reached: first, and longest */
  retryFirstS: 15,
  retryMaxS: 300,
  /** until the next sign-in after the cloud did not accept e-mail address and password */
  retryRejectedS: 1800,
  /** after a command until the unit is read again; the unit needs that long to report */
  afterCommandS: 4,
  /** after a filter reset until the unit is read again */
  afterResetS: 6,
  /** the app waits that long for one answer of the cloud */
  requestS: 20,
};
/** How many units are asked for their status at the same time. */
const REQUESTS_AT_ONCE = 10;
/** Readings without a status in a row after which a unit is shown as not reachable. */
const OFFLINE_AFTER = 3;
const SLAVE_ROLES = new Set(['SlaveEqualMaster', 'SlaveOppositeMaster']);

function isSlave(role) {
  return SLAVE_ROLES.has(role);
}

function messageOf(e) {
  return e instanceof Error ? e.message : String(e);
}

class Account extends EventEmitter {
  /**
   * @param {{username: string, password: string, host?: string, log?: Function, error?: Function}} options
   */
  constructor(options) {
    super();
    this.username = options.username;
    this.password = options.password;
    this.host = options.host;
    this.log = options.log || (() => {});
    this.error = options.error || this.log;
    this.cloud = null;
    /** serial -> state */
    this.units = new Map();
    /** serial -> listener of the Homey device */
    this.listeners = new Map();
    this.list = [];
    this.timer = null;
    this.timers = new Set();
    this.unitsReadAt = 0;
    this.retryS = TIMING.retryFirstS;
    this.signedIn = false;
    this.started = false;
    this.stopped = false;
    /** message of the last refusal of the sign-in, null while it is accepted */
    this.rejected = null;
    this.polling = false;
    /** serials with a Homey device that are no longer in the account; not read until they come back */
    this.removed = new Set();
  }

  // ---------------------------------------------------------------- lifecycle

  start() {
    if (this.started || this.stopped) return;
    this.started = true;
    this.cloud = new AmbientikaCloud({ username: this.username, password: this.password, host: this.host, timeoutS: TIMING.requestS });
    this.log(`Signing in to the Ambientika cloud as ${this.username}, reading the units every ${TIMING.pollS} seconds`);
    this.connect().catch((e) => this.error('connect', e));
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    if (this.cloud) this.cloud.close();
  }

  /** New password (repair): signs in again at once. */
  setPassword(password) {
    this.password = password;
    this.rejected = null;
    if (!this.started || this.stopped) return;
    if (this.cloud) this.cloud.close();
    this.cloud = new AmbientikaCloud({ username: this.username, password, host: this.host, timeoutS: TIMING.requestS });
    this.retryS = TIMING.retryFirstS;
    this.schedule(() => this.connect(), 0);
  }

  /**
   * A Homey device of this account. Gets what is known at once.
   *
   * @param {string} serial
   * @param {object} listener onStatus, onReachable, onUnit, onRemoved
   */
  register(serial, listener) {
    this.listeners.set(serial, listener);
    if (this.removed.has(serial)) {
      this.call(serial, 'onRemoved');
      return;
    }
    const state = this.stateOf(serial);
    if (state.unit) this.call(serial, 'onUnit', state.unit);
    if (state.status) this.call(serial, 'onStatus', state.status);
    if (state.reachable !== undefined) this.call(serial, 'onReachable', state.reachable, state.why);
    // A unit that was not in the account yet: read soon.
    if (this.signedIn && !state.status) this.schedule(() => this.poll(), 1);
  }

  unregister(serial) {
    this.listeners.delete(serial);
  }

  get deviceCount() {
    return this.listeners.size;
  }

  // ---------------------------------------------------------------- helpers

  stateOf(serial) {
    let state = this.units.get(serial);
    if (!state) {
      state = { serial, unit: null, status: null, failures: 0, reachable: undefined, lastFan: undefined, lastLight: undefined, holdUntil: 0, queue: Promise.resolve() };
      this.units.set(serial, state);
    }
    return state;
  }

  call(serial, name, ...args) {
    const l = this.listeners.get(serial);
    if (!l || typeof l[name] !== 'function') return;
    try {
      const r = l[name](...args);
      if (r && typeof r.catch === 'function') r.catch((e) => this.error(`${name} ${serial}`, e));
    } catch (e) {
      this.error(`${name} ${serial}`, e);
    }
  }

  later(fn, seconds) {
    if (this.stopped) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, seconds * 1000);
    this.timers.add(t);
  }

  schedule(fn, seconds) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      Promise.resolve()
        .then(fn)
        .catch((e) => {
          if (this.stopped) return;
          this.error('Unexpected error, trying again in a minute:', e);
          this.schedule(fn, 60);
        });
    }, seconds * 1000);
  }

  // ---------------------------------------------------------------- reading

  async connect() {
    if (!this.cloud || this.stopped) return;
    try {
      await this.cloud.signIn();
      await this.readUnits();
    } catch (e) {
      if (this.stopped) return;
      this.lost(e);
      return;
    }
    this.retryS = TIMING.retryFirstS;
    this.signedIn = true;
    this.rejected = null;
    this.log(`Signed in to the Ambientika cloud, ${this.list.length} unit${this.list.length === 1 ? '' : 's'}`);
    await this.poll();
  }

  /** The cloud is not available: everything not reachable, next try later. */
  lost(error) {
    const message = messageOf(error);
    const rejected = error instanceof CloudError && error.kind === 'auth';
    const wait = rejected ? TIMING.retryRejectedS : this.retryS;
    if (rejected) {
      this.error(`${message}. Next try in ${Math.max(1, Math.round(wait / 60))} minutes.`);
      this.rejected = message;
      this.emit('rejected', message);
    } else {
      this.log(`Ambientika cloud: ${message}. Next try in ${wait} seconds.`);
      this.retryS = Math.min(TIMING.retryMaxS, this.retryS * 2);
    }
    this.signedIn = false;
    for (const state of this.units.values()) this.showReachable(state, false, rejected ? 'rejected' : 'cloud');
    if (this.cloud) this.cloud.token = null;
    this.schedule(() => this.connect(), wait);
  }

  async readUnits() {
    if (!this.cloud) return;
    const list = await this.cloud.units();
    this.unitsReadAt = Date.now();
    this.list = list;
    const seen = new Set();
    for (const unit of list) {
      seen.add(unit.serial);
      if (this.removed.delete(unit.serial)) this.log(`Unit ${unit.serial} is in the Ambientika account again`);
      const state = this.stateOf(unit.serial);
      state.unit = unit;
      this.call(unit.serial, 'onUnit', unit);
    }
    for (const [serial, state] of this.units) {
      if (seen.has(serial)) continue;
      if (state.unit || this.listeners.has(serial)) {
        this.log(`Unit ${serial} is no longer in the Ambientika account`);
        this.removed.add(serial);
        this.call(serial, 'onRemoved');
      }
      this.units.delete(serial);
    }
    // A device of a unit that was never in this list (added under another login, or removed while Homey was off).
    for (const serial of this.listeners.keys()) {
      if (seen.has(serial) || this.removed.has(serial)) continue;
      this.log(`Unit ${serial} is not in the Ambientika account`);
      this.removed.add(serial);
      this.units.delete(serial);
      this.call(serial, 'onRemoved');
    }
  }

  showReachable(state, reachable, why) {
    if (this.stopped) return;
    // A new reason (cloud away -> login refused) is shown as well.
    const changed = state.reachable !== reachable || (!reachable && state.why !== why);
    state.reachable = reachable;
    state.why = reachable ? undefined : why;
    if (changed) this.call(state.serial, 'onReachable', reachable, why);
  }

  take(state, status) {
    if (this.stopped) return;
    state.status = status;
    if (FAN_SPEEDS.includes(status.fanSpeed)) state.lastFan = status.fanSpeed;
    // A unit that is switched off reports a default light sensor level, not the one it was set to.
    if (status.operatingMode !== 'Off' && LIGHT_SENSOR_LEVELS.includes(status.lightSensorLevel)) state.lastLight = status.lightSensorLevel;
    this.call(state.serial, 'onStatus', status);
  }

  async readUnit(state) {
    if (!this.cloud) return { state, ok: false };
    try {
      const status = await this.cloud.status(state.serial);
      // A command sent while this reading was under way: the reading shows the state before.
      if (state.holdUntil <= Date.now()) this.take(state, status);
      return { state, ok: true };
    } catch (e) {
      return { state, ok: false, error: e };
    }
  }

  /** One reading of the units that have a Homey device, then the next one is scheduled. */
  async poll() {
    if (this.stopped || !this.signedIn || this.polling) return;
    this.polling = true;
    try {
      await this.pollOnce();
    } finally {
      this.polling = false;
    }
  }

  async pollOnce() {
    const started = Date.now();
    if (started - this.unitsReadAt > TIMING.unitsIntervalS * 1000) {
      try {
        await this.readUnits();
      } catch (e) {
        if (e instanceof CloudError && e.kind === 'auth') {
          this.lost(e);
          return;
        }
        this.unitsReadAt = Date.now() - (TIMING.unitsIntervalS - 60) * 1000; // again in a minute
        this.log(`List of units not read: ${messageOf(e)}`);
      }
    }
    const due = [...this.listeners.keys()].filter((s) => !this.removed.has(s)).map((s) => this.stateOf(s)).filter((s) => s.holdUntil <= Date.now());
    const results = [];
    let next = 0;
    const worker = async () => {
      while (next < due.length && !this.stopped) results.push(await this.readUnit(due[next++]));
    };
    await Promise.all(Array.from({ length: Math.min(REQUESTS_AT_ONCE, due.length) }, worker));
    if (this.stopped) return;

    const rejected = results.find((r) => r.error instanceof CloudError && r.error.kind === 'auth');
    if (rejected) {
      this.lost(rejected.error);
      return;
    }
    this.judge(results);
    const used = (Date.now() - started) / 1000;
    this.schedule(() => this.poll(), Math.max(Math.min(1, TIMING.pollS), TIMING.pollS - used));
  }

  /** Shows units reachable or not after a reading. */
  judge(results) {
    // Every unit without an answer and no answer of the cloud itself (5xx, no connection, time limit): the cloud, not the units.
    const serverSide = (e) => !(e instanceof CloudError) || e.status === null || e.status >= 500;
    const cloudDown = results.length > 0 && results.every((r) => !r.ok && serverSide(r.error));
    for (const r of results) {
      const state = r.state;
      if (r.ok) {
        state.failures = 0;
        if (state.status) {
          if (state.reachable === false) this.log(`Unit ${state.serial} answers again`);
          this.showReachable(state, true);
        }
        continue;
      }
      state.failures++;
      // Not reachable after a few readings in a row; at once when nothing was ever read.
      if ((state.failures >= OFFLINE_AFTER || !state.status) && state.reachable !== false) {
        this.log(`No status from unit ${state.serial}: ${messageOf(r.error)}`);
        this.showReachable(state, false, cloudDown ? 'cloud' : 'unit');
      }
    }
  }

  // ---------------------------------------------------------------- commands

  /**
   * Sends one command; several settings asked for at the same time are sent together.
   * Resolves when the cloud has accepted it.
   *
   * @param {string} serial
   * @param {{operatingMode?: string, power?: boolean, fanSpeed?: string, humidityLevel?: string, lightSensorLevel?: string}} wanted
   * @returns {Promise<{operatingMode: string, fanSpeed: string, humidityLevel: string, lightSensorLevel?: string}>} what was sent
   */
  command(serial, wanted) {
    const state = this.stateOf(serial);
    const run = state.queue.then(() => this.send(state, wanted));
    state.queue = run.catch(() => {});
    return run;
  }

  async send(state, wanted) {
    if (this.stopped) throw new Error('stopped');
    if (!this.cloud || !this.signedIn) throw new CloudError('not signed in to the Ambientika cloud', { kind: this.rejected ? 'auth' : 'network' });
    const serial = state.serial;
    let base = state.status;
    if (!base) {
      base = await this.cloud.status(serial);
      this.take(state, base);
    }
    const mode = planCommand(base, wanted, { lastFan: state.lastFan, lastLight: state.lastLight });

    state.holdUntil = Date.now() + TIMING.afterCommandS * 1000;
    try {
      await this.cloud.changeMode(serial, mode);
    } catch (e) {
      state.holdUntil = 0;
      throw e;
    }
    this.log(`${serial}: set to ${mode.operatingMode}, fan ${mode.fanSpeed}, humidity ${mode.humidityLevel}${mode.lightSensorLevel ? `, light sensor ${mode.lightSensorLevel}` : ''}`);
    if (this.stopped) return mode;
    // The next command builds on these values, and Homey shows them until the unit reports.
    const assumed = { ...base, ...mode };
    if (mode.operatingMode !== base.operatingMode) assumed.lastOperatingMode = base.operatingMode;
    state.holdUntil = Date.now() + TIMING.afterCommandS * 1000;
    this.take(state, assumed);
    this.later(() => {
      if (this.stopped || state.holdUntil > Date.now()) return;
      this.readUnit(state).then((r) => (r.ok ? this.judge([r]) : undefined));
    }, TIMING.afterCommandS + 0.2);
    return mode;
  }

  /** Filter counter back to zero (Master). Resolves when the cloud has accepted it. */
  resetFilter(serial) {
    const state = this.stateOf(serial);
    const run = state.queue.then(async () => {
      if (!this.cloud || !this.signedIn) throw new CloudError('not signed in to the Ambientika cloud', { kind: this.rejected ? 'auth' : 'network' });
      await this.cloud.resetFilter(serial);
      this.log(`${serial}: filter reset sent`);
      this.later(() => {
        if (this.stopped || state.holdUntil > Date.now()) return;
        this.readUnit(state).then((r) => (r.ok ? this.judge([r]) : undefined));
      }, TIMING.afterResetS);
    });
    state.queue = run.catch(() => {});
    return run;
  }
}

/**
 * The complete settings of one command, from the status of the unit and what is asked for.
 * Pure function, so that it can be tested on its own.
 *
 * - power false: mode Off. power true on a unit that is off: its last mode, Smart when there is none.
 * - A fixed fan step out of Smart or Auto (the unit chooses its step there) switches to manual heat recovery.
 * - Night and Turbo are steps the unit chooses itself: the cloud does not take them, the last fixed step is sent.
 */
function planCommand(base, wanted, memory = {}) {
  const mode = {
    operatingMode: base.operatingMode,
    fanSpeed: base.fanSpeed || '',
    humidityLevel: base.humidityLevel || '',
    lightSensorLevel: memory.lastLight || base.lightSensorLevel,
  };
  const previous = base.lastOperatingMode;
  const usable = typeof previous === 'string' && previous !== 'Off' && OPERATING_MODES.includes(previous);

  if (wanted.operatingMode !== undefined) {
    mode.operatingMode = wanted.operatingMode;
  } else if (wanted.power === false) {
    mode.operatingMode = 'Off';
  } else if (wanted.power === true && mode.operatingMode === 'Off') {
    mode.operatingMode = usable ? previous : 'Smart';
  }
  if (wanted.fanSpeed !== undefined) {
    mode.fanSpeed = wanted.fanSpeed;
    if (wanted.operatingMode === undefined) {
      if (mode.operatingMode === 'Smart' || mode.operatingMode === 'Auto') mode.operatingMode = 'ManualHeatRecovery';
      else if (mode.operatingMode === 'Off' && wanted.power !== false) {
        mode.operatingMode = usable && previous !== 'Smart' && previous !== 'Auto' ? previous : 'ManualHeatRecovery';
      }
    }
  }
  if (wanted.humidityLevel !== undefined) mode.humidityLevel = wanted.humidityLevel;
  if (wanted.lightSensorLevel !== undefined) mode.lightSensorLevel = wanted.lightSensorLevel;

  if (!OPERATING_MODES.includes(mode.operatingMode)) {
    throw new CloudError(`the unit reports the operating mode ${JSON.stringify(mode.operatingMode)}, which cannot be sent back - please choose an operating mode first`, { kind: 'format' });
  }
  if (!FAN_SPEEDS.includes(mode.fanSpeed)) {
    mode.fanSpeed = memory.lastFan || (mode.fanSpeed === 'Night' ? 'Low' : mode.fanSpeed === 'Turbo' ? 'High' : 'Medium');
  }
  if (!HUMIDITY_LEVELS.includes(mode.humidityLevel)) mode.humidityLevel = 'Normal';
  if (!LIGHT_SENSOR_LEVELS.includes(mode.lightSensorLevel)) delete mode.lightSensorLevel; // the unit keeps its own
  return mode;
}

module.exports = { Account, TIMING, planCommand, isSlave };
