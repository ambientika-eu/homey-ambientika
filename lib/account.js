'use strict';

/**
 * One Ambientika account: signs in, reads all units of the account at a fixed
 * interval and sends the commands of the Homey devices.
 *
 * All devices of the same account share one Account, so the cloud is asked once
 * per interval for each unit, however many devices Homey shows. The rules are
 * the ones of the Ambientika MQTT Bridge, the integration "Ambientika for Home
 * Assistant" and the ioBroker adapter of Südwind:
 *
 * - A Slave runs with the Master of its zone: its operating mode is shown as the
 *   Master's, its own field is kept in operatingModeOwn.
 * - Temperature and humidity pass the plausibility check and are averaged (lib/logic.js).
 * - A command is shown as sent until the unit reports it, for at most TIMING.confirmS.
 * - The filter reset goes to the unit and to the Master of its zone and is checked
 *   against the status the unit reports afterwards.
 *
 * Events, per unit (serial):
 *   listener.onStatus(view)          what to show (see view())
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
const { Measurements, filterStatusNum } = require('./logic');

/** Times in seconds. An object, so that the tests can shorten them. */
const TIMING = {
  /** between two readings of all units */
  pollS: 30,
  /** between two readings of the list of units (new units, new names) */
  unitsIntervalS: 600,
  /** until the next try after the cloud could not be reached: first, and longest */
  retryFirstS: 15,
  retryMaxS: 300,
  /** until the next sign-in after the cloud did not accept e-mail address and password: first, and longest */
  retryRejectedFirstS: 60,
  retryRejectedMaxS: 1800,
  /** after a command until the unit is read again for the first time */
  afterCommandS: 4,
  /** after a command Homey shows what was sent until the unit reports it, at most that long */
  confirmS: 120,
  /** while the unit has not reported a command yet, it is read again that often */
  confirmEveryS: 15,
  /** after a filter reset until the status is checked, up to three times */
  resetVerifyS: 12,
  /** a Slave shows the mode of its Master while the Master was read within that time */
  masterModeMaxAgeS: 300,
  /** the app waits that long for one answer of the cloud */
  requestS: 20,
};
/** How many units are asked for their status at the same time. */
const REQUESTS_AT_ONCE = 10;
/** Readings without a status in a row after which a unit is shown as not reachable. */
const OFFLINE_AFTER = 3;
/** Operating modes in which the unit chooses the fan speed itself. */
const UNIT_CHOOSES_FAN = new Set(['Smart', 'Auto', 'Night', 'AwayHome', 'Surveillance']);
const SETTING_NAMES = { operatingMode: 'operating mode', fanSpeed: 'fan speed', humidityLevel: 'humidity level', lightSensorLevel: 'light sensor level' };

function isSlave(role) {
  return typeof role === 'string' && role.toLowerCase().startsWith('slave');
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
    this.rejectedS = TIMING.retryRejectedFirstS;
    this.signedIn = false;
    this.started = false;
    this.stopped = false;
    /** message of the last refusal of the sign-in, null while it is accepted */
    this.rejected = null;
    this.polling = false;
    /** serials with a Homey device that are no longer in the account; not read until they come back */
    this.removed = new Set();
    this.measurements = new Measurements({ info: (t) => this.log(t), debug: () => {} }, TIMING.pollS);
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
    for (const state of this.units.values()) {
      if (state.check) clearTimeout(state.check);
      state.check = null;
    }
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
    this.rejectedS = TIMING.retryRejectedFirstS;
    this.signedIn = false;
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
    if (state.raw) this.call(serial, 'onStatus', this.view(state));
    if (state.reachable !== undefined) this.call(serial, 'onReachable', state.reachable, state.why);
    // A unit that was not read yet: read soon.
    if (this.signedIn && !state.raw) this.schedule(() => this.poll(), 1);
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
      state = {
        serial,
        unit: null,
        /** the status packet as read */
        raw: null,
        rawAt: 0,
        /** the status packet with the settings that were sent and not reported yet */
        shown: null,
        measured: { temperature: null, humidity: null, temperatureAvg: null, humidityAvg: null },
        liveRole: null,
        failures: 0,
        reachable: undefined,
        why: undefined,
        lastFan: undefined,
        lastLight: undefined,
        holdUntil: 0,
        expected: null,
        check: null,
        lastModeShown: undefined,
        modeNote: undefined,
        queue: Promise.resolve(),
      };
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

  wait(seconds) {
    return new Promise((resolve) => this.later(resolve, seconds));
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

  label(state) {
    return state.unit && state.unit.name ? `${state.unit.name} (${state.serial})` : state.serial;
  }

  // ---------------------------------------------------------------- zones

  /**
   * Current role: the unit's own report from its last status, else the role of the
   * list of units. The list goes stale when units are coupled again in the app.
   */
  roleOf(state) {
    return state.liveRole || (state.unit && state.unit.role) || '';
  }

  /**
   * The Master of the zone of a Slave, or null. zoneIndex is only unique within
   * one house, so the Master must be in the same house.
   */
  zoneMaster(state) {
    if (!isSlave(this.roleOf(state)) || !state.unit || state.unit.zone === null) return null;
    for (const other of this.units.values()) {
      if (other === state || !other.unit) continue;
      if (other.unit.zone === state.unit.zone && other.unit.houseId === state.unit.houseId && this.roleOf(other).toLowerCase() === 'master') return other;
    }
    return null;
  }

  /** The Slaves that run with this Master. */
  slavesOf(master) {
    return [...this.units.values()].filter((s) => s !== master && this.zoneMaster(s) === master);
  }

  /**
   * What to show for a unit.
   *
   * @returns {object} the status packet, with
   *   operatingMode     the mode the unit runs in: the zone Master's for a Slave
   *   operatingModeOwn  the unit's own field
   *   temperature, humidity        after the plausibility check
   *   temperatureAvg, humidityAvg  averaged
   *   role, slave, zoneMaster      current role, and the serial of the zone Master of a Slave
   */
  view(state) {
    const shown = state.shown || state.raw;
    const own = shown.operatingMode;
    const master = this.zoneMaster(state);
    let mode = own;
    if (master && master.raw) {
      const maxAge = Math.max(TIMING.masterModeMaxAgeS, 2 * TIMING.pollS + 60) * 1000;
      if (Date.now() - master.rawAt <= maxAge) mode = (master.shown || master.raw).operatingMode;
    }
    const role = this.roleOf(state);
    return {
      ...shown,
      operatingMode: mode,
      operatingModeOwn: own,
      ...state.measured,
      role,
      slave: isSlave(role),
      zoneMaster: master ? master.serial : null,
    };
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
    this.rejectedS = TIMING.retryRejectedFirstS;
    this.signedIn = true;
    this.rejected = null;
    this.log(`Signed in to the Ambientika cloud, ${this.list.length} unit${this.list.length === 1 ? '' : 's'}`);
    await this.poll();
  }

  /** The cloud is not available: everything not reachable, next try later. */
  lost(error) {
    const message = messageOf(error);
    const rejected = error instanceof CloudError && error.kind === 'auth';
    let wait;
    if (rejected) {
      // Not at every reading: a password that is no longer right would be sent again and again.
      wait = this.rejectedS;
      this.rejectedS = Math.min(TIMING.retryRejectedMaxS, this.rejectedS * 2);
      this.error(`${message}. If the password of the Ambientika app was changed, repair the device in Homey. Next try in ${wait < 120 ? `${Math.round(wait)} seconds` : `${Math.round(wait / 60)} minutes`}.`);
      this.rejected = message;
      this.emit('rejected', message);
    } else {
      wait = this.retryS;
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
        if (this.listeners.has(serial)) this.removed.add(serial);
        this.call(serial, 'onRemoved');
      }
      this.forget(state);
    }
    // A device of a unit that was never in this list (added under another login, or removed while Homey was off).
    for (const serial of this.listeners.keys()) {
      if (seen.has(serial) || this.removed.has(serial)) continue;
      this.log(`Unit ${serial} is not in the Ambientika account`);
      this.removed.add(serial);
      this.call(serial, 'onRemoved');
    }
  }

  forget(state) {
    if (state.check) clearTimeout(state.check);
    state.check = null;
    this.units.delete(state.serial);
    this.measurements.forget(state.serial);
  }

  showReachable(state, reachable, why) {
    if (this.stopped) return;
    // A new reason (cloud away -> login refused) is shown as well.
    const changed = state.reachable !== reachable || (!reachable && state.why !== why);
    state.reachable = reachable;
    state.why = reachable ? undefined : why;
    if (changed) this.call(state.serial, 'onReachable', reachable, why);
  }

  /**
   * The status to show: a setting that was sent and that the unit has not reported
   * yet is shown as sent, for at most TIMING.confirmS. A reading that has all of
   * them ends the wait; after that time the unit's own values count and the log
   * says which setting the unit did not take over.
   */
  withExpected(state, packet) {
    const e = state.expected;
    if (!e) return packet;
    const missing = Object.keys(e.settings).filter((k) => packet[k] !== e.settings[k]);
    if (missing.length === 0) {
      state.expected = null;
      return packet;
    }
    if (Date.now() < e.until) {
      const shown = { ...packet, ...e.settings };
      if ('operatingMode' in e.settings && packet.operatingMode !== e.settings.operatingMode) shown.lastOperatingMode = e.lastOperatingMode;
      return shown;
    }
    state.expected = null;
    const what = missing.map((k) => `${SETTING_NAMES[k]} ${packet[k]} instead of ${e.settings[k]}`).join(', ');
    const slave = isSlave(this.roleOf(state)) ? ' This unit is a Slave and runs with the Master of its zone; please set it at the Master.' : '';
    this.log(`${this.label(state)}: the cloud accepted the command, but the unit still reports ${what} after ${Math.round(TIMING.confirmS)} seconds. The cloud confirms the call, not its execution on the unit.${slave}`);
    return packet;
  }

  /**
   * Takes a status packet read from the cloud and shows it.
   *
   * @param {object} state
   * @param {object} packet status packet
   */
  take(state, packet) {
    if (this.stopped) return;
    state.raw = packet;
    state.rawAt = Date.now();
    if (typeof packet.deviceRole === 'string' && packet.deviceRole !== '') state.liveRole = packet.deviceRole;
    state.measured = this.measurements.take(state.serial, packet);
    if (FAN_SPEEDS.includes(packet.fanSpeed)) state.lastFan = packet.fanSpeed;
    // A unit that is switched off reports a default light sensor level, not the one it was set to.
    if (packet.operatingMode !== 'Off' && LIGHT_SENSOR_LEVELS.includes(packet.lightSensorLevel)) state.lastLight = packet.lightSensorLevel;
    this.show(state);
  }

  /** Works out what to show and tells the Homey device; the Slaves of a Master follow. */
  show(state) {
    if (!state.raw || this.stopped) return;
    state.shown = this.withExpected(state, state.raw);
    // A Slave waits for the first reading of its Master: it would show its own mode for a moment otherwise.
    const waitsFor = this.zoneMaster(state);
    if (waitsFor && !waitsFor.raw && waitsFor.failures === 0 && state.lastModeShown === undefined) return;
    const view = this.view(state);
    if (view.slave && view.zoneMaster && view.operatingMode !== view.operatingModeOwn) {
      const note = `${view.operatingModeOwn}>${view.operatingMode}`;
      if (state.modeNote !== note) {
        state.modeNote = note;
        this.log(`Operating mode of ${this.label(state)}: the unit reports ${view.operatingModeOwn}, shown as ${view.operatingMode} - it is a Slave and runs with its zone Master ${view.zoneMaster}`);
      }
    }
    this.call(state.serial, 'onStatus', view);
    const changed = state.lastModeShown !== view.operatingMode;
    state.lastModeShown = view.operatingMode;
    if (changed && !view.slave) {
      for (const slave of this.slavesOf(state)) {
        if (slave.raw) this.call(slave.serial, 'onStatus', this.view(slave));
      }
    }
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

  /** The units to read: those with a Homey device, and the zone Masters of the Slaves among them. */
  due() {
    const set = new Set();
    for (const serial of this.listeners.keys()) {
      if (this.removed.has(serial)) continue;
      const state = this.stateOf(serial);
      set.add(state);
      const master = this.zoneMaster(state);
      if (master) set.add(master);
    }
    return [...set].filter((s) => s.holdUntil <= Date.now());
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
    const due = this.due();
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
        if (state.raw) {
          if (state.reachable === false) this.log(`Unit ${this.label(state)} answers again`);
          this.showReachable(state, true);
        }
        continue;
      }
      state.failures++;
      // A Slave that waited for this unit as its Master shows its own mode now.
      for (const slave of this.slavesOf(state)) {
        if (slave.raw && slave.lastModeShown === undefined) this.show(slave);
      }
      // Not reachable after a few readings in a row; at once when nothing was ever read.
      if ((state.failures >= OFFLINE_AFTER || !state.raw) && state.reachable !== false) {
        this.log(`No status from unit ${this.label(state)}: ${messageOf(r.error)}`);
        this.showReachable(state, false, cloudDown ? 'cloud' : 'unit');
      }
    }
  }

  /**
   * Reads one unit a few seconds after a command, without waiting for the next
   * reading of all units, and again every few seconds while the unit has not
   * reported what was sent.
   */
  readSoon(state, seconds = TIMING.afterCommandS) {
    if (this.stopped) return;
    if (state.check) clearTimeout(state.check);
    const timer = setTimeout(() => {
      if (state.check === timer) state.check = null;
      if (this.stopped || !this.units.has(state.serial) || state.holdUntil > Date.now()) return;
      this.readUnit(state)
        .then((r) => {
          if (r.ok) this.judge([r]);
        })
        .catch(() => {})
        .then(() => {
          if (!this.stopped && state.expected && !state.check) this.readSoon(state, TIMING.confirmEveryS);
        });
    }, seconds * 1000 + 200);
    state.check = timer;
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

  notSignedIn() {
    return new CloudError('not signed in to the Ambientika cloud', { kind: this.rejected ? 'auth' : 'network' });
  }

  async send(state, wanted) {
    if (this.stopped) throw new Error('stopped');
    if (!this.cloud || !this.signedIn) throw this.notSignedIn();
    const serial = state.serial;
    if (!state.raw) this.take(state, await this.cloud.status(serial));
    // The next command builds on what was sent before, also while the unit has not reported it yet.
    const base = state.shown || state.raw;
    const mode = planCommand(base, wanted, { lastFan: state.lastFan, lastLight: state.lastLight });

    // What the unit is expected to report after this command.
    const settings = {};
    if (mode.operatingMode !== base.operatingMode || wanted.operatingMode !== undefined || wanted.power !== undefined) settings.operatingMode = mode.operatingMode;
    if (wanted.fanSpeed !== undefined && !UNIT_CHOOSES_FAN.has(mode.operatingMode) && mode.operatingMode !== 'Off') settings.fanSpeed = mode.fanSpeed;
    if (wanted.humidityLevel !== undefined) settings.humidityLevel = mode.humidityLevel;
    if (wanted.lightSensorLevel !== undefined && mode.operatingMode !== 'Off' && mode.lightSensorLevel !== undefined) settings.lightSensorLevel = mode.lightSensorLevel;

    state.holdUntil = Date.now() + TIMING.afterCommandS * 1000;
    try {
      await this.cloud.changeMode(serial, mode);
    } catch (e) {
      state.holdUntil = 0;
      throw e;
    }
    this.log(`${this.label(state)}: sent ${mode.operatingMode}, fan ${mode.fanSpeed}, humidity ${mode.humidityLevel}${mode.lightSensorLevel ? `, light sensor ${mode.lightSensorLevel}` : ''}`);
    if (this.stopped) return mode;

    const before = state.expected;
    const pending = before ? { ...before.settings } : {};
    if (UNIT_CHOOSES_FAN.has(mode.operatingMode) || mode.operatingMode === 'Off') delete pending.fanSpeed;
    if (mode.operatingMode === 'Off') delete pending.lightSensorLevel; // a unit that is off reports a default level
    Object.assign(pending, settings);
    if (Object.keys(pending).length > 0) {
      state.expected = {
        settings: pending,
        until: Date.now() + TIMING.confirmS * 1000,
        lastOperatingMode: before && 'operatingMode' in before.settings ? before.lastOperatingMode : state.raw.operatingMode,
      };
    } else {
      state.expected = null;
    }
    state.holdUntil = Date.now() + TIMING.afterCommandS * 1000;
    // take() remembers the light level only while the unit runs; a level that was set counts always.
    if (wanted.lightSensorLevel !== undefined && mode.lightSensorLevel !== undefined) state.lastLight = mode.lightSensorLevel;
    this.show(state);
    this.readSoon(state);
    return mode;
  }

  /**
   * Filter counter back to zero. The documented reset goes to the unit and to the
   * Master of its zone: the units reset filters per zone through the Master, a
   * Slave keeps its own counter. Resolves when the cloud has accepted it; the
   * status the unit reports afterwards is checked in the background.
   *
   * @returns {Promise<'nothing'|'sent'>} 'nothing' when the filter status is Good already
   */
  resetFilter(serial) {
    const state = this.stateOf(serial);
    const run = state.queue.then(async () => {
      if (this.stopped) throw new Error('stopped');
      if (!this.cloud || !this.signedIn) throw this.notSignedIn();
      if (!state.raw) this.take(state, await this.cloud.status(serial));
      const before = filterStatusNum(state.raw.filtersStatus);
      // Only a counter that is positively Good has nothing to reset.
      if (before === 0) {
        this.log(`Filter reset for ${this.label(state)}: filter status is already ${state.raw.filtersStatus} - nothing to do`);
        return 'nothing';
      }
      const master = this.zoneMaster(state);
      const targets = [[serial, 'unit']];
      if (master) targets.push([master.serial, `zone Master ${master.serial}`]);
      let accepted = false;
      let failure;
      for (const [target, label] of targets) {
        try {
          await this.cloud.resetFilter(target);
          accepted = true;
          this.log(`Filter reset [${label}] ${target}: sent`);
        } catch (e) {
          failure = e;
          this.log(`Filter reset [${label}] ${target}: ${messageOf(e)}`);
        }
      }
      if (!accepted) throw failure;
      this.verifyReset(state, before, master).catch((e) => this.error('filter reset check', e));
      return 'sent';
    });
    state.queue = run.catch(() => {});
    return run;
  }

  /** Checks the filter status the unit reports after a reset and says in the log what really happened. */
  async verifyReset(state, before, master) {
    const attempts = master ? 1 : 3;
    for (let i = 0; i < attempts; i++) {
      await this.wait(TIMING.resetVerifyS);
      if (this.stopped || !this.units.has(state.serial)) return;
      const r = await this.readUnit(state);
      if (r.ok) this.judge([r]);
      if (master && this.units.has(master.serial)) {
        const rm = await this.readUnit(master);
        if (rm.ok) this.judge([rm]);
      }
      const after = state.raw ? filterStatusNum(state.raw.filtersStatus) : null;
      // Confirmed only when the counter really improved.
      if (after !== null && (after === 0 || (before !== null && after < before))) {
        this.log(`Filter reset for ${this.label(state)}: confirmed - filter status ${state.raw.filtersStatus}`);
        return;
      }
    }
    if (master) {
      this.log(`Filter reset for ${this.label(state)}: this is a Slave - its filter counter cannot be cleared remotely. The reset clears the counter of the zone Master; a Slave keeps its own until the unit is reset to factory settings and set up again in the Ambientika app.`);
    } else {
      this.log(`Filter reset for ${this.label(state)}: sent; the unit still reports filter ${state.raw ? state.raw.filtersStatus : '?'} after ${attempts} checks. If the unit applies it, the change appears with a later reading.`);
    }
  }
}

/**
 * The complete settings of one command, from the status of the unit and what is asked for.
 * Pure function, so that it can be tested on its own.
 *
 * - power false: mode Off. power true on a unit that is off: its last mode, Smart when there is none.
 * - A fixed fan step out of a mode in which the unit chooses its step (Smart, Auto, Night,
 *   Away, Surveillance) switches to manual heat recovery; a unit that is off runs in its
 *   last manual mode again.
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
    if (wanted.operatingMode === undefined && wanted.power !== false) {
      if (UNIT_CHOOSES_FAN.has(mode.operatingMode)) mode.operatingMode = 'ManualHeatRecovery';
      else if (mode.operatingMode === 'Off') mode.operatingMode = usable && !UNIT_CHOOSES_FAN.has(previous) ? previous : 'ManualHeatRecovery';
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

module.exports = { Account, TIMING, planCommand, isSlave, UNIT_CHOOSES_FAN };
