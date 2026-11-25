'use strict';

/**
 * Client for the Ambientika cloud, the same one the Ambientika app uses.
 *
 *   POST /users/authenticate          { username, password } -> { id, jwtToken }
 *   GET  /house/houses-info           -> [{ houseId }]
 *   GET  /house/house-complete-info   ?houseId=  -> house with rooms and units
 *   GET  /device/device-status        ?deviceSerialNumber=  -> status packet
 *   POST /device/change-mode          { deviceSerialNumber, operatingMode, fanSpeed, humidityLevel, lightSensorLevel }
 *   GET  /device/reset-filter         ?deviceSerialNumber=
 *
 * Same behaviour as the Home Assistant integration, the ioBroker adapter and the
 * Matterbridge plugin of Südwind. Written with the http/https modules of Node.js
 * only, so it runs on every Homey without further packages.
 *
 * Every request has a time limit: a request the cloud accepts and never answers
 * must not hold up the reading of the other units.
 */

const http = require('http');
const https = require('https');

const DEFAULT_HOST = 'https://app.ambientika.eu:4521';
/** Seconds the app waits for one answer of the cloud. */
const REQUEST_TIMEOUT_S = 20;
/** Longest answer that is still read (a status packet has a few hundred bytes). */
const MAX_BODY = 512 * 1024;
/** Redirects followed per request. */
const MAX_REDIRECTS = 3;

const OPERATING_MODES = [
  'Smart',
  'Auto',
  'ManualHeatRecovery',
  'Night',
  'AwayHome',
  'Surveillance',
  'TimedExpulsion',
  'Expulsion',
  'Intake',
  'MasterSlaveFlow',
  'SlaveMasterFlow',
  'Off',
];
/** Fan steps the cloud accepts in a command, in the order of their numbers. Night and Turbo are chosen by the unit itself. */
const FAN_SPEEDS = ['Low', 'Medium', 'High'];
const HUMIDITY_LEVELS = ['Dry', 'Normal', 'Moist'];
const LIGHT_SENSOR_LEVELS = ['NotAvailable', 'Off', 'Low', 'Medium'];
/** Best to worst. */
const AIR_QUALITIES = ['VeryGood', 'Good', 'Medium', 'Poor', 'Bad'];
/** Best to worst. */
const FILTER_STATUSES = ['Good', 'Medium', 'Bad'];

class CloudError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number|null, kind?: 'auth'|'http'|'network'|'timeout'|'format'}} [info]
   */
  constructor(message, info = {}) {
    super(message);
    this.name = 'CloudError';
    this.status = info.status === undefined ? null : info.status;
    this.kind = info.kind || 'http';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A few words of an error answer of the cloud, never a whole HTML page. */
function shortText(data) {
  let text = data;
  if (isRecord(data)) text = data.message;
  if (typeof text !== 'string') return '';
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.startsWith('<')) return '';
  return clean.slice(0, 120);
}

/** The host as typed: spaces and slashes at the end do not count, https:// is assumed. */
function cleanHost(value) {
  let host = typeof value === 'string' ? value.trim().replace(/\/+$/, '') : '';
  if (host === '') return DEFAULT_HOST;
  if (!/^https?:\/\//i.test(host)) host = `https://${host}`;
  return host;
}

class AmbientikaCloud {
  /**
   * @param {{username: string, password: string, host?: string, timeoutS?: number}} options
   */
  constructor(options) {
    this.username = options.username;
    this.password = options.password;
    this.host = cleanHost(options.host);
    this.timeoutMs = (options.timeoutS > 0 ? options.timeoutS : REQUEST_TIMEOUT_S) * 1000;
    this.token = null;
    this.signingIn = null;
    this.requests = new Set();
    this.closed = false;
  }

  /** Ends every request under way; nothing is sent afterwards. */
  close() {
    this.closed = true;
    for (const req of this.requests) req.destroy(new Error('closed'));
    this.requests.clear();
  }

  /**
   * One HTTP exchange with a time limit. Follows redirects like the app does.
   *
   * @returns {Promise<{status: number, type: string, text: string}>}
   */
  exchange(method, url, headers, body, redirects = 0) {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new CloudError('the app is stopping', { kind: 'network' }));
        return;
      }
      const lib = url.protocol === 'http:' ? http : https;
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.requests.delete(req);
        fn(value);
      };
      const req = lib.request(url, { method, headers }, (res) => {
        const status = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location && redirects < MAX_REDIRECTS) {
          res.resume();
          let next;
          try {
            next = new URL(res.headers.location, url);
          } catch (e) {
            finish(reject, new CloudError(`HTTP status ${status} with an unreadable address`, { status, kind: 'http' }));
            return;
          }
          const keep = status === 307 || status === 308;
          const nextHeaders = { ...headers };
          if (!keep) {
            delete nextHeaders['Content-Type'];
            delete nextHeaders['Content-Length'];
          }
          // The token goes along only to the same host.
          if (next.host !== url.host) delete nextHeaders.Authorization;
          finish(resolve, this.exchange(keep ? method : 'GET', next, nextHeaders, keep ? body : undefined, redirects + 1));
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < MAX_BODY) chunks.push(c);
          size += c.length;
        });
        res.on('end', () => {
          let text = Buffer.concat(chunks).toString('utf8');
          if (text.length > MAX_BODY) text = text.slice(0, MAX_BODY);
          finish(resolve, { status, type: String(res.headers['content-type'] || '').toLowerCase(), text });
        });
        res.on('error', (e) => finish(reject, new CloudError(`no connection to the Ambientika cloud (${e.code || e.message})`, { kind: 'network' })));
      });
      const timer = setTimeout(() => {
        finish(reject, new CloudError(`no answer from the Ambientika cloud within ${Math.round(this.timeoutMs / 1000)} seconds`, { kind: 'timeout' }));
        req.destroy();
      }, this.timeoutMs);
      this.requests.add(req);
      req.on('error', (e) => {
        if (this.closed) finish(reject, new CloudError('the app is stopping', { kind: 'network' }));
        else finish(reject, new CloudError(`no connection to the Ambientika cloud (${e.code || e.message})`, { kind: 'network' }));
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  /**
   * One request.
   *
   * @param {string} method GET or POST
   * @param {string} path path of the endpoint
   * @param {{query?: object, body?: any, auth?: boolean}} [options]
   * @returns {Promise<any>} parsed JSON, or null for an empty answer
   */
  async request(method, path, options = {}) {
    if (this.closed) throw new CloudError('the app is stopping', { kind: 'network' });
    const url = new URL(`${this.host}/${path}`);
    for (const [k, v] of Object.entries(options.query || {})) url.searchParams.set(k, String(v));
    const headers = { Accept: 'application/json' };
    if (options.auth !== false) headers.Authorization = `Bearer ${this.token}`;
    let body;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
    const res = await this.exchange(method, url, headers, body);
    let data = res.text === '' ? null : res.text;
    let parsed = false;
    if (res.text !== '' && res.type.includes('json')) {
      try {
        data = JSON.parse(res.text);
        parsed = true;
      } catch (e) {
        if (res.status === 200) throw new CloudError('the Ambientika cloud sent an answer that cannot be read', { status: 200, kind: 'format' });
      }
    }
    if (res.status !== 200) {
      const words = shortText(data);
      throw new CloudError(`HTTP status ${res.status}${words ? `: ${words}` : ''}`, { status: res.status, kind: 'http' });
    }
    return parsed || data === null ? data : { text: data };
  }

  /** Signs in. Several callers at the same time share one sign-in. */
  async signIn() {
    if (!this.signingIn) {
      this.signingIn = (async () => {
        let data;
        try {
          data = await this.request('POST', 'users/authenticate', { auth: false, body: { username: this.username, password: this.password } });
        } catch (e) {
          if (e instanceof CloudError && e.status !== null && [400, 401, 403].includes(e.status)) {
            throw new CloudError('the Ambientika cloud did not accept e-mail address and password', { status: e.status, kind: 'auth' });
          }
          throw e;
        }
        const token = isRecord(data) ? data.jwtToken : undefined;
        if (typeof token !== 'string' || token === '') {
          throw new CloudError('the Ambientika cloud answered the sign-in without a token', { status: 200, kind: 'format' });
        }
        this.token = token;
      })().finally(() => {
        this.signingIn = null;
      });
    }
    await this.signingIn;
  }

  /** A request with the token. A sign-in that has expired is renewed once. */
  async authed(method, path, options = {}) {
    if (this.token === null) await this.signIn();
    const used = this.token;
    try {
      return await this.request(method, path, options);
    } catch (e) {
      if (!(e instanceof CloudError) || (e.status !== 401 && e.status !== 403)) throw e;
      // Several requests may find out at the same time: one sign-in for all of them.
      if (this.token === used) this.token = null;
      if (this.token === null) await this.signIn();
      return this.request(method, path, options);
    }
  }

  /**
   * All units of the account, over all houses and rooms.
   *
   * @returns {Promise<Array<{serial: string, name: string, role: string, zone: number|null, type: string, room: string, house: string, houseId: string}>>}
   */
  async units() {
    const houses = await this.authed('GET', 'house/houses-info');
    if (!Array.isArray(houses)) throw new CloudError('the list of houses cannot be read', { status: 200, kind: 'format' });
    const units = [];
    const seen = new Set();
    const text = (v) => (typeof v === 'string' ? v.trim().slice(0, 120) : '');
    for (const entry of houses) {
      const houseId = isRecord(entry) ? (entry.houseId !== undefined ? entry.houseId : entry.id) : undefined;
      if (typeof houseId !== 'number' && typeof houseId !== 'string') continue;
      const house = await this.authed('GET', 'house/house-complete-info', { query: { houseId } });
      if (!isRecord(house) || !Array.isArray(house.rooms)) continue;
      for (const room of house.rooms) {
        if (!isRecord(room) || !Array.isArray(room.devices)) continue;
        for (const d of room.devices) {
          if (!isRecord(d) || typeof d.serialNumber !== 'string' || d.serialNumber.trim() === '') continue;
          const serial = d.serialNumber.trim();
          if (seen.has(serial)) continue;
          seen.add(serial);
          units.push({
            serial,
            name: text(d.name),
            role: text(d.role),
            zone: typeof d.zoneIndex === 'number' && Number.isInteger(d.zoneIndex) ? d.zoneIndex : null,
            type: text(d.deviceType),
            room: text(room.name),
            house: text(house.name),
            // zoneIndex is only unique within one house
            houseId: String(houseId),
          });
        }
      }
    }
    return units;
  }

  /** The status packet of one unit as the cloud holds it. */
  async status(serial) {
    const data = await this.authed('GET', 'device/device-status', { query: { deviceSerialNumber: serial } });
    if (!isRecord(data) || typeof data.operatingMode !== 'string') {
      throw new CloudError('the status packet cannot be read', { status: 200, kind: 'format' });
    }
    return data;
  }

  /**
   * Sets mode, fan step, humidity level and light sensor of a unit.
   *
   * @param {string} serial
   * @param {{operatingMode: string, fanSpeed: string, humidityLevel: string, lightSensorLevel?: string}} mode
   *   by name; without a light sensor level the unit keeps its own
   */
  async changeMode(serial, mode) {
    const op = OPERATING_MODES.indexOf(mode.operatingMode);
    const fan = FAN_SPEEDS.indexOf(mode.fanSpeed);
    const hum = HUMIDITY_LEVELS.indexOf(mode.humidityLevel);
    if (op < 0 || fan < 0 || hum < 0) throw new CloudError('this combination cannot be sent', { kind: 'format' });
    const body = { deviceSerialNumber: serial, operatingMode: String(op), fanSpeed: fan, humidityLevel: hum };
    const light = mode.lightSensorLevel === undefined ? -1 : LIGHT_SENSOR_LEVELS.indexOf(mode.lightSensorLevel);
    if (light >= 0) body.lightSensorLevel = light;
    await this.authed('POST', 'device/change-mode', { body });
  }

  /** Asks the cloud to clear the filter counter of a unit (a Master; a Slave keeps its own). */
  async resetFilter(serial) {
    await this.authed('GET', 'device/reset-filter', { query: { deviceSerialNumber: serial } });
  }
}

module.exports = {
  AmbientikaCloud,
  CloudError,
  cleanHost,
  DEFAULT_HOST,
  REQUEST_TIMEOUT_S,
  OPERATING_MODES,
  FAN_SPEEDS,
  HUMIDITY_LEVELS,
  LIGHT_SENSOR_LEVELS,
  AIR_QUALITIES,
  FILTER_STATUSES,
};
