'use strict';

/**
 * Stand-in for the Homey Apps SDK (module "homey") for the tests.
 *
 * It does what the app relies on and checks what Homey itself checks: a value
 * set on a capability must fit its definition in app.json (enum ids, types),
 * flow cards and capabilities must exist, translations must exist.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const APP = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
/** The system capabilities the app uses, as homey-lib defines them. */
const SYSTEM = {
  onoff: { type: 'boolean', setable: true },
  measure_temperature: { type: 'number', setable: false },
  measure_humidity: { type: 'number', setable: false },
  alarm_moisture: { type: 'boolean', setable: false },
  button: { type: 'boolean', setable: true },
};

function capabilityDef(id) {
  const base = id.split('.')[0];
  if (APP.capabilities && APP.capabilities[base]) return APP.capabilities[base];
  if (SYSTEM[base]) return SYSTEM[base];
  throw new Error(`unknown capability ${id}`);
}

function checkValue(id, value) {
  if (value === null) return;
  const def = capabilityDef(id);
  if (def.type === 'boolean' && typeof value !== 'boolean') throw new Error(`${id}: ${JSON.stringify(value)} is not a boolean`);
  if (def.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) throw new Error(`${id}: ${JSON.stringify(value)} is not a number`);
  if (def.type === 'enum' && !def.values.some((v) => v.id === value)) throw new Error(`${id}: ${JSON.stringify(value)} is not one of ${def.values.map((v) => v.id)}`);
}

function lookup(obj, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
}

/** One Homey with its settings, flow cards and translations. */
function createHomey(language = 'en') {
  const locale = JSON.parse(fs.readFileSync(path.join(ROOT, 'locales', `${language}.json`), 'utf8'));
  const settings = new Map();
  const flowIds = (kind) => new Set((APP.flow && APP.flow[kind] ? APP.flow[kind] : []).map((c) => c.id).concat(...(APP.drivers || []).map(() => [])));
  const driverCards = { triggers: new Set(), conditions: new Set(), actions: new Set() };
  for (const kind of Object.keys(driverCards)) for (const c of (APP.flow && APP.flow[kind]) || []) driverCards[kind].add(c.id);
  const triggered = [];
  const runListeners = {};
  const homey = {
    settings: {
      get: (k) => (settings.has(k) ? JSON.parse(settings.get(k)) : null),
      set: (k, v) => settings.set(k, JSON.stringify(v)),
    },
    __(key, tokens) {
      const text = lookup(locale, key);
      if (typeof text !== 'string') throw new Error(`missing translation ${key} (${language})`);
      return text.replace(/__(\w+)__/g, (m, k) => (tokens && tokens[k] !== undefined ? tokens[k] : m));
    },
    flow: {
      getDeviceTriggerCard(id) {
        if (!driverCards.triggers.has(id)) throw new Error(`unknown trigger card ${id}`);
        const card = APP.flow.triggers.find((c) => c.id === id);
        return {
          async trigger(device, tokens = {}, state = {}) {
            for (const t of card.tokens || []) {
              if (typeof tokens[t.name] !== t.type) throw new Error(`trigger ${id}: token ${t.name} missing or wrong type`);
            }
            triggered.push({ id, device: device.getData().id, tokens, state });
          },
        };
      },
      getConditionCard(id) {
        if (!driverCards.conditions.has(id)) throw new Error(`unknown condition card ${id}`);
        return { registerRunListener: (fn) => (runListeners[`conditions.${id}`] = fn) };
      },
      getActionCard(id) {
        if (!driverCards.actions.has(id)) throw new Error(`unknown action card ${id}`);
        return { registerRunListener: (fn) => (runListeners[`actions.${id}`] = fn) };
      },
    },
    drivers: {
      list: {},
      getDrivers() {
        return this.list;
      },
    },
    app: null,
    // for the tests
    triggered,
    runListeners,
    flowIds,
  };
  return homey;
}

class SimpleClass {
  constructor() {
    this.logs = [];
    this.errors = [];
    this.log = (...a) => this.logs.push(a.map(String).join(' '));
    this.error = (...a) => this.errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
  }
}

class App extends SimpleClass {}

class Driver extends SimpleClass {
  getDevices() {
    return this.devices || [];
  }
}

class Device extends SimpleClass {
  /**
   * @param {object} homey
   * @param {object} driver
   * @param {object} pairing the device object the driver returned in list_devices
   */
  constructor(homey, driver, pairing) {
    super();
    this.homey = homey;
    this.driver = driver;
    this.data = pairing.data;
    this.store = { ...pairing.store };
    this.settings = { ...(pairing.settings || {}) };
    const caps = pairing.capabilities || APP.drivers.find((d) => d.id === 'ventilation').capabilities;
    this.capOptions = JSON.parse(JSON.stringify(pairing.capabilitiesOptions || APP.drivers.find((d) => d.id === 'ventilation').capabilitiesOptions || {}));
    this.values = new Map(caps.map((c) => [c, null]));
    for (const c of caps) capabilityDef(c);
    this.available = true;
    this.unavailableMessage = null;
    this.listeners = new Map();
    this.multi = [];
    this.name = pairing.name;
  }

  getData() {
    return this.data;
  }
  getName() {
    return this.name;
  }
  getStore() {
    return { ...this.store };
  }
  async setStoreValue(k, v) {
    this.store[k] = v;
  }
  getSettings() {
    return { ...this.settings };
  }
  async setSettings(s) {
    Object.assign(this.settings, s);
  }
  hasCapability(c) {
    return this.values.has(c);
  }
  getCapabilityValue(c) {
    if (!this.values.has(c)) throw new Error(`no capability ${c}`);
    return this.values.get(c);
  }
  async setCapabilityValue(c, v) {
    if (!this.values.has(c)) throw new Error(`no capability ${c}`);
    checkValue(c, v);
    this.values.set(c, v);
  }
  async addCapability(c) {
    capabilityDef(c);
    if (!this.values.has(c)) this.values.set(c, null);
  }
  async setCapabilityOptions(c, o) {
    if (!this.values.has(c)) throw new Error(`no capability ${c}`);
    this.capOptions[c] = { ...(this.capOptions[c] || {}), ...o };
  }
  registerCapabilityListener(c, fn) {
    if (!this.values.has(c)) throw new Error(`listener for missing capability ${c}`);
    if (this.listeners.has(c)) throw new Error(`second listener for ${c}`);
    this.listeners.set(c, fn);
  }
  registerMultipleCapabilityListener(caps, fn, timeout) {
    for (const c of caps) {
      if (!this.values.has(c)) throw new Error(`listener for missing capability ${c}`);
      if (this.listeners.has(c)) throw new Error(`second listener for ${c}`);
      this.listeners.set(c, (value) => fn({ [c]: value }, {}));
    }
    this.multi.push({ caps, fn, timeout });
  }
  async setAvailable() {
    this.available = true;
    this.unavailableMessage = null;
  }
  async setUnavailable(message) {
    this.available = false;
    this.unavailableMessage = message;
  }

  // ------------------------------------------------- what the user does in the Homey app
  /** Sets a capability as the device view does: listener first, value only when it succeeds. */
  async userSets(c, value) {
    if (!this.values.has(c)) throw new Error(`no capability ${c}`);
    const opts = this.capOptions[c] || {};
    const def = capabilityDef(c);
    if ((opts.setable === false || def.setable === false) && !c.startsWith('button.')) throw new Error(`${c} is not setable`);
    checkValue(c, value);
    const fn = this.listeners.get(c);
    if (!fn) throw new Error(`no listener for ${c}`);
    await fn(value);
    if (!c.startsWith('button.')) this.values.set(c, value);
  }
  /** Several capabilities at once, as one call of the multiple listener. */
  async userSetsMany(values) {
    const entry = this.multi.find((m) => Object.keys(values).every((c) => m.caps.includes(c)));
    if (!entry) throw new Error('no multiple listener for these capabilities');
    await entry.fn(values, {});
  }
}

module.exports = { App, Driver, Device, SimpleClass, createHomey, APP, capabilityDef };
