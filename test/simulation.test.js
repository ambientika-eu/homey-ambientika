'use strict';

/**
 * Simulation: the app with five units while the cloud, the units and the user
 * do random things for a while - outages, units without an answer, expired
 * tokens, commands, units that ignore commands, changed roles, filter resets.
 * Afterwards everything is put in order, and Homey must show what the units report.
 */

const { until, sleep } = require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { startFakeCloud } = require('./fake-cloud');
const { createHomey } = require('./fake-homey');
const { capabilityValues } = require('../lib/values');

const AmbientikaApp = require('../app');
const VentilationDriver = require('../drivers/ventilation/driver');
const VentilationDevice = require('../drivers/ventilation/device');

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODES = ['smart', 'auto', 'manual_heat_recovery', 'night', 'away_home', 'surveillance', 'timed_expulsion', 'expulsion', 'intake', 'master_slave_flow', 'slave_master_flow', 'off'];
const pick = (r, list) => list[Math.floor(r() * list.length)];

for (const seed of [1, 2, 3, 4]) {
  test(`simulation ${seed}: random outages, commands and role changes, then everything settles`, async () => {
    const fake = await startFakeCloud();
    const unhandled = [];
    const onUnhandled = (e) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    const homey = createHomey(pick(rng(seed), ['en', 'de', 'nl', 'it', 'fr', 'es', 'da', 'sv', 'pl']));
    homey.settings.set('host', fake.url);
    const app = new AmbientikaApp();
    app.homey = homey;
    homey.app = app;
    await app.onInit();
    const driver = new VentilationDriver();
    driver.homey = homey;
    driver.devices = [];
    homey.drivers.list = { ventilation: driver };
    await driver.onInit();
    try {
      const session = { handlers: {}, setHandler(n, f) { this.handlers[n] = f; } };
      await driver.onPair(session);
      await session.handlers.login({ username: fake.USER, password: fake.PASSWORD });
      const list = await session.handlers.list_devices();
      const devices = [];
      for (const pairing of list) {
        const d = new VentilationDevice(homey, driver, pairing);
        driver.devices.push(d);
        await d.onInit();
        devices.push(d);
      }
      const r = rng(seed * 7919);
      const refused = [];
      const end = Date.now() + 6000;
      let actions = 0;
      while (Date.now() < end) {
        const d = pick(r, devices);
        const serial = d.getData().id;
        const x = r();
        actions++;
        if (x < 0.30) {
          // the user sets something; a refusal must come with a text of the app
          const what = pick(r, [
            ['actions', 'set_operating_mode', { mode: pick(r, MODES) }],
            ['actions', 'set_fan_speed', { fan_speed: pick(r, ['low', 'medium', 'high']) }],
            ['actions', 'set_humidity_level', { humidity_level: pick(r, ['dry', 'normal', 'moist']) }],
            ['actions', 'set_light_sensor', { light_sensor: pick(r, ['off', 'low', 'high']) }],
            ['actions', 'reset_filter', {}],
          ]);
          homey.runListeners[`${what[0]}.${what[1]}`]({ device: d, ...what[2] }).catch((e) => refused.push(e.message));
        } else if (x < 0.38 && d.hasCapability('onoff')) {
          d.userSets('onoff', r() < 0.5).catch((e) => refused.push(e.message));
        } else if (x < 0.50) {
          fake.set(serial, { temperature: pick(r, [18.5, 21, 23.4, 999, null]), humidity: pick(r, [0, 12, 40, 55, 70, 130]), airQuality: pick(r, ['VeryGood', 'Good', 'Medium', 'Poor', 'Bad', 'Weird']), filtersStatus: pick(r, ['Good', 'Medium', 'Bad']), nightAlarm: r() < 0.5, humidityAlarm: r() < 0.3, fanSpeed: pick(r, ['Low', 'Medium', 'High', 'Night', 'Turbo']) });
        } else if (x < 0.58) {
          fake.fault(serial, pick(r, ['500', '404', 'garbage', 'html', 'hang', null, null]));
        } else if (x < 0.66) {
          fake.outage(pick(r, ['500', 'hang', 'refuse-auth', 'ok', 'ok']));
        } else if (x < 0.72) {
          fake.expire();
        } else if (x < 0.78) {
          fake.deaf(serial, r() < 0.5);
        } else if (x < 0.84) {
          fake.set(serial, { deviceRole: pick(r, ['Master', 'SlaveEqualMaster', 'SlaveOppositeMaster', 'NotConfigured']) });
        } else if (x < 0.88) {
          fake.set(serial, { operatingMode: pick(r, ['Smart', 'Off', 'Night', 'SomethingNew']) });
        } else if (x < 0.90) {
          fake.redirect(pick(r, [0, 0, 307, 308]));
        }
        await sleep(10 + Math.floor(r() * 90));
      }

      // everything in order again
      fake.outage('ok');
      fake.redirect(0);
      for (const s of fake.serials) {
        fake.fault(s, null);
        fake.deaf(s, false);
        const role = fake.unit(s).role;
        fake.set(s, { deviceRole: role, temperature: 20.5, humidity: 48, airQuality: 'Good', filtersStatus: 'Good', operatingMode: 'Smart', fanSpeed: 'Medium', humidityLevel: 'Normal', lightSensorLevel: 'Low', nightAlarm: false, humidityAlarm: false });
      }
      const account = app.accounts.get(fake.USER.toLowerCase());
      const wanted = (d) => {
        const serial = d.getData().id;
        const state = account.stateOf(serial);
        if (!state.raw) return null;
        return capabilityValues(account.view(state));
      };
      await until(
        () => devices.every((d) => {
          if (!d.available) return false;
          const v = wanted(d);
          if (!v || v.ambientika_operating_mode !== 'smart' || v.measure_temperature !== 20.5 || v.measure_humidity !== 48 || v.ambientika_filter_status !== 'good') return false;
          return Object.entries(v).every(([cap, value]) => !d.hasCapability(cap) || cap.endsWith('.avg') || d.getCapabilityValue(cap) === value);
        }),
        15000,
        `settling (seed ${seed})`,
      );
      // no pending expectations, the roles are the ones the units report
      for (const d of devices) {
        const state = account.stateOf(d.getData().id);
        assert.equal(d.getStore().role, fake.unit(d.getData().id).role);
        assert.equal(state.raw.operatingMode, 'Smart');
      }
      // nothing went wrong inside the app
      assert.deepEqual(unhandled, [], 'unhandled rejections');
      for (const d of devices) {
        const bad = d.errors.filter((e) => !/^Command failed:/.test(e));
        assert.deepEqual(bad, [], `errors of ${d.getName()}`);
      }
      assert.deepEqual(driver.errors, []);
      assert.deepEqual(app.errors.filter((e) => !/did not accept e-mail address and password/.test(e)), []);
      // every refusal the user saw is a text of the app, in the user's language
      const known = Object.values(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'locales', `${Object.keys(require('../app.json').name).find((l) => homey.__('errors.slave') === JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'locales', `${l}.json`), 'utf8')).errors.slave)}.json`), 'utf8')).errors).map((t) => t.split('__message__')[0]);
      for (const text of refused) assert.ok(known.some((k) => text.startsWith(k)), `refusal not from the app: ${text}`);
      assert.ok(actions > 40);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await app.onUninit();
      await fake.stop();
    }
  });
}
