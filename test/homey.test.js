'use strict';

/**
 * The whole app as Homey runs it: pairing, devices, capabilities, flow cards,
 * repair and deletion, against the stand-in cloud over real HTTP.
 */

const { TIMING, until, sleep } = require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startFakeCloud } = require('./fake-cloud');
const { createHomey, APP } = require('./fake-homey');

const AmbientikaApp = require('../app');
const VentilationDriver = require('../drivers/ventilation/driver');
const VentilationDevice = require('../drivers/ventilation/device');

const MASTER = 'A0B1C2D3E402'; // Flur, Master zone 0
const SLAVE = 'A0B1C2D3E401'; // Wohnzimmer, Slave zone 0
const MASTER2 = 'A0B1C2D3E404'; // Schlafzimmer Eltern, Master zone 1

let fake;
test.before(async () => {
  fake = await startFakeCloud();
});
test.after(async () => fake.stop());

const worlds = [];
test.afterEach(async () => {
  for (const w of worlds.splice(0)) await w.app.onUninit();
  fake.reset();
});

async function world(language = 'de') {
  const homey = createHomey(language);
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
  const w = { homey, app, driver };
  worlds.push(w);

  w.session = () => {
    const handlers = {};
    return { handlers, setHandler: (name, fn) => (handlers[name] = fn) };
  };
  w.pair = async (username = fake.USER, password = fake.PASSWORD) => {
    const s = w.session();
    await driver.onPair(s);
    await s.handlers.login({ username, password });
    return s.handlers.list_devices();
  };
  w.add = async (pairing) => {
    const d = new VentilationDevice(homey, driver, pairing);
    driver.devices.push(d);
    await d.onInit();
    return d;
  };
  w.addSerials = async (...serials) => {
    const list = await w.pair();
    const out = [];
    for (const s of serials) out.push(await w.add(list.find((p) => p.data.id === s)));
    return out;
  };
  w.remove = async (d) => {
    await d.onDeleted();
    driver.devices.splice(driver.devices.indexOf(d), 1);
  };
  w.run = (kind, id, args) => homey.runListeners[`${kind}.${id}`](args);
  w.triggered = (id) => homey.triggered.filter((t) => t.id === id);
  return w;
}

const shows = (d, cap, value, what) => until(() => d.getCapabilityValue(cap) === value, 4000, what || `${cap} = ${value}`);

test('pairing: wrong password gives the message of the app, the list holds every unit', async () => {
  const w = await world('de');
  const s = w.session();
  await w.driver.onPair(s);
  await assert.rejects(s.handlers.login({ username: fake.USER, password: 'falsch' }), { message: w.homey.__('errors.login') });
  assert.equal(w.homey.settings.get('logins'), null, 'nothing stored for a refused login');

  const list = await w.pair();
  assert.equal(list.length, 5);
  const master = list.find((p) => p.data.id === MASTER);
  assert.equal(master.name, 'Flur');
  assert.equal(master.capabilities, undefined, 'a Master gets every capability of the driver');
  assert.deepEqual(master.settings, { serial: MASTER, role: 'Master', zone: '1', room: 'Haus', house: 'Zuhause', account: fake.USER });
  const slave = list.find((p) => p.data.id === SLAVE);
  assert.equal(slave.settings.role, 'Slave, gleichläufig zum Master');
  assert.ok(!slave.capabilities.includes('onoff') && !slave.capabilities.includes('button.reset_filter'));
  assert.equal(slave.capabilitiesOptions.ambientika_operating_mode.setable, false);
  assert.ok(w.homey.settings.get('logins')[fake.USER.toLowerCase()], 'login stored once devices are listed');
});

test('devices show the status, several devices share one sign-in', async () => {
  const w = await world();
  fake.clear();
  const [m, s, m2] = await w.addSerials(MASTER, SLAVE, MASTER2);
  await shows(m, 'ambientika_operating_mode', 'smart');
  await shows(s, 'measure_temperature', 21);
  await shows(m2, 'measure_humidity', 55);
  assert.equal(m.getCapabilityValue('onoff'), true);
  assert.equal(m.getCapabilityValue('ambientika_fan_speed'), 'medium');
  assert.equal(m.getCapabilityValue('ambientika_light_sensor'), 'low');
  assert.equal(m.getCapabilityValue('ambientika_air_quality'), 'good');
  assert.equal(m.getCapabilityValue('ambientika_filter_status'), 'good');
  assert.equal(m.getCapabilityValue('alarm_moisture'), false);
  assert.equal(m.available, true);
  assert.equal(w.app.accounts.size, 1);
  // one sign-in for the pairing, one for the shared Account
  assert.equal(fake.counts.auth, 2);
  // no triggers for the first values
  assert.equal(w.homey.triggered.length, 0);
});

test('operating mode from the device view: sent, shown, trigger with the word of the user language', async () => {
  const w = await world('de');
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'ambientika_operating_mode', 'smart');
  fake.clear();
  await m.userSets('ambientika_operating_mode', 'night');
  const call = fake.log.find((l) => l.kind === 'change-mode');
  assert.deepEqual(call.body, { deviceSerialNumber: MASTER, operatingMode: '3', fanSpeed: 1, humidityLevel: 1, lightSensorLevel: 2 });
  assert.equal(fake.unit(MASTER).status.operatingMode, 'Night');
  await until(() => w.triggered('operating_mode_changed').length === 1);
  assert.deepEqual(w.triggered('operating_mode_changed')[0].tokens, { mode: 'Nacht', mode_id: 'night' });
  // the next reading confirms it, no second trigger
  await sleep(TIMING.pollS * 1000 + 400);
  assert.equal(m.getCapabilityValue('ambientika_operating_mode'), 'night');
  assert.equal(w.triggered('operating_mode_changed').length, 1);
});

test('on/off: off is the mode Off, on goes back to the last mode', async () => {
  const w = await world();
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'onoff', true);
  await m.userSets('ambientika_operating_mode', 'auto');
  await m.userSets('onoff', false);
  assert.equal(fake.unit(MASTER).status.operatingMode, 'Off');
  await shows(m, 'ambientika_operating_mode', 'off');
  await sleep(500);
  await m.userSets('onoff', true);
  assert.equal(fake.unit(MASTER).status.operatingMode, 'Auto');
  await shows(m, 'ambientika_operating_mode', 'auto');
  // the unit reported every command: nothing is waited for, nothing is complained about
  await sleep(1800);
  assert.equal(w.app.accounts.get(fake.USER.toLowerCase()).stateOf(MASTER).expected, null);
  assert.equal(w.app.logs.filter((l) => /still reports/.test(l)).length, 0);
});

test('fixed fan step in Smart: manual heat recovery; several capabilities at once are one command', async () => {
  const w = await world();
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'ambientika_operating_mode', 'smart');
  await m.userSets('ambientika_fan_speed', 'high');
  assert.equal(fake.unit(MASTER).status.operatingMode, 'ManualHeatRecovery');
  assert.equal(fake.unit(MASTER).status.fanSpeed, 'High');
  await shows(m, 'ambientika_operating_mode', 'manual_heat_recovery');
  await sleep(400);
  fake.clear();
  await m.userSetsMany({ ambientika_operating_mode: 'away_home', ambientika_humidity_level: 'dry' });
  const calls = fake.log.filter((l) => l.kind === 'change-mode');
  assert.equal(calls.length, 1);
  assert.equal(fake.unit(MASTER).status.operatingMode, 'AwayHome');
  assert.equal(fake.unit(MASTER).status.humidityLevel, 'Dry');
});

test('flow cards: actions and conditions', async () => {
  const w = await world('en');
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'ambientika_operating_mode', 'smart');
  // every condition and action card of app.json has a run listener
  for (const kind of ['conditions', 'actions']) for (const c of APP.flow[kind]) assert.equal(typeof w.homey.runListeners[`${kind}.${c.id}`], 'function', `${kind}.${c.id}`);

  await w.run('actions', 'set_operating_mode', { device: m, mode: 'intake' });
  assert.equal(fake.unit(MASTER).status.operatingMode, 'Intake');
  await w.run('actions', 'set_humidity_level', { device: m, humidity_level: 'moist' });
  assert.equal(fake.unit(MASTER).status.humidityLevel, 'Moist');
  await w.run('actions', 'set_light_sensor', { device: m, light_sensor: 'high' });
  assert.equal(fake.unit(MASTER).status.lightSensorLevel, 'Medium', 'the step the app calls High is Medium in the cloud');
  await w.run('actions', 'set_fan_speed', { device: m, fan_speed: 'low' });
  assert.equal(fake.unit(MASTER).status.fanSpeed, 'Low');
  assert.equal(fake.unit(MASTER).status.operatingMode, 'Intake', 'a fixed mode stays');

  assert.equal(await w.run('conditions', 'operating_mode_is', { device: m, mode: 'intake' }), true);
  assert.equal(await w.run('conditions', 'operating_mode_is', { device: m, mode: 'smart' }), false);

  fake.set(MASTER, { airQuality: 'Poor' });
  await shows(m, 'ambientika_air_quality', 'poor');
  assert.equal(await w.run('conditions', 'air_quality_worse_than', { device: m, air_quality: 'good' }), true);
  assert.equal(await w.run('conditions', 'air_quality_worse_than', { device: m, air_quality: 'poor' }), false);
  assert.deepEqual(w.triggered('air_quality_changed')[0].tokens, { air_quality: 'Poor' });
});

test('filter: status trigger, reset by button and by flow; a Slave cannot reset', async () => {
  const w = await world('de');
  const [m, s] = await w.addSerials(MASTER, SLAVE);
  await shows(m, 'ambientika_filter_status', 'good');
  fake.set(MASTER, { filtersStatus: 'Bad' });
  await shows(m, 'ambientika_filter_status', 'bad');
  assert.deepEqual(w.triggered('filter_status_changed')[0].tokens, { filter_status: 'schlecht' });
  assert.equal(await w.run('conditions', 'filter_status_is', { device: m, filter_status: 'bad' }), true);
  await m.userSets('button.reset_filter', true);
  assert.equal(fake.unit(MASTER).status.filtersStatus, 'Good');
  await shows(m, 'ambientika_filter_status', 'good', 'filter read again after the reset');
  fake.set(MASTER, { filtersStatus: 'Bad' });
  await shows(m, 'ambientika_filter_status', 'bad');
  await w.run('actions', 'reset_filter', { device: m });
  await shows(m, 'ambientika_filter_status', 'good');
  await assert.rejects(w.run('actions', 'reset_filter', { device: s }), { message: w.homey.__('errors.slaveFilter') });
  // a filter that is Good already: nothing is sent
  fake.clear();
  await w.run('actions', 'reset_filter', { device: m });
  assert.equal(fake.log.filter((l) => l.kind === 'reset-filter').length, 0);
  // a yellow filter is a reset case as well
  fake.set(MASTER, { filtersStatus: 'Medium' });
  await shows(m, 'ambientika_filter_status', 'medium');
  await w.run('actions', 'reset_filter', { device: m });
  await shows(m, 'ambientika_filter_status', 'good');
  assert.ok(w.app.logs.some((l) => /Filter reset for Flur .*confirmed/.test(l)));
});

test('a Slave shows its sensors and the mode of its zone Master, refuses commands with the explanation', async () => {
  const w = await world('nl');
  fake.set(SLAVE, { operatingMode: 'Auto' }); // its own field, left over from before it was coupled
  fake.clear();
  const [s] = await w.addSerials(SLAVE);
  await shows(s, 'ambientika_operating_mode', 'smart', 'the mode of the Master, not its own Auto');
  assert.ok(fake.counts[`status:${MASTER}`] > 0, 'the zone Master is read although it has no Homey device');
  assert.equal(s.hasCapability('onoff'), false);
  assert.equal(s.hasCapability('measure_temperature.avg'), true);
  await assert.rejects(s.userSets('ambientika_operating_mode', 'auto'), /not setable/);
  await assert.rejects(w.run('actions', 'set_operating_mode', { device: s, mode: 'auto' }), { message: w.homey.__('errors.slave') });
  assert.match(w.homey.__('errors.slave'), /Slave/);
  assert.equal(fake.log.filter((l) => l.kind === 'change-mode').length, 0);
  // the Master changes its mode: the Slave follows with the same reading, with a trigger
  fake.set(MASTER, { operatingMode: 'Night' });
  await shows(s, 'ambientika_operating_mode', 'night');
  assert.equal(w.triggered('operating_mode_changed').length, 1);
  // a Slave in another house with the same zone number is not its Master
  assert.equal(w.app.accounts.get(fake.USER.toLowerCase()).zoneMaster(w.app.accounts.get(fake.USER.toLowerCase()).stateOf(SLAVE)).serial, MASTER);
});

test('a Slave whose Master does not answer shows its own mode', async () => {
  const w = await world();
  fake.set(SLAVE, { operatingMode: 'Auto' });
  fake.fault(MASTER, '500');
  const [s] = await w.addSerials(SLAVE);
  await shows(s, 'ambientika_operating_mode', 'auto');
  fake.fault(MASTER, null);
  await shows(s, 'ambientika_operating_mode', 'smart');
});

test('a Master with a Homey device and its Slave: a command at the Master shows on the Slave at once', async () => {
  const w = await world();
  const [m, s] = await w.addSerials(MASTER, SLAVE);
  await shows(s, 'ambientika_operating_mode', 'smart');
  await m.userSets('ambientika_operating_mode', 'away_home');
  assert.equal(s.getCapabilityValue('ambientika_operating_mode'), 'away_home');
});

test('a command the unit does not carry out: shown as sent while waiting, then the unit counts again', async () => {
  const w = await world();
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'ambientika_operating_mode', 'smart');
  fake.deaf(MASTER, true);
  await m.userSets('ambientika_operating_mode', 'night');
  await sleep(700); // two readings later it still shows what was sent
  assert.equal(m.getCapabilityValue('ambientika_operating_mode'), 'night');
  await shows(m, 'ambientika_operating_mode', 'smart', 'back to what the unit reports');
  assert.ok(w.app.logs.some((l) => /still reports operating mode Smart instead of Night/.test(l)), 'the log says so');
  // a unit that reports late: no flicker back in between
  fake.deaf(MASTER, false);
  await m.userSets('ambientika_humidity_level', 'dry');
  const seen = new Set();
  const t = setInterval(() => seen.add(m.getCapabilityValue('ambientika_humidity_level')), 20);
  await sleep(900);
  clearInterval(t);
  assert.deepEqual([...seen], ['dry']);
});

test('measured values pass the plausibility check', async () => {
  const w = await world();
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'measure_humidity', 55);
  fake.set(MASTER, { humidity: 0, temperature: 999 });
  await sleep(700);
  assert.equal(m.getCapabilityValue('measure_humidity'), 55);
  assert.equal(m.getCapabilityValue('measure_temperature'), 21);
  fake.set(MASTER, { humidity: 130, temperature: 22.5 });
  await shows(m, 'measure_humidity', 100);
  await shows(m, 'measure_temperature', 22.5);
});

test('a Slave that becomes a Master gets its controls', async () => {
  const w = await world();
  const [s] = await w.addSerials(SLAVE);
  await shows(s, 'ambientika_operating_mode', 'smart');
  // the unit itself reports the new role in its status; the list of units is still the old one
  fake.set(SLAVE, { deviceRole: 'Master', filtersStatus: 'Bad' });
  await until(() => s.hasCapability('onoff'), 4000, 'controls added');
  assert.equal(s.getStore().role, 'Master');
  assert.equal(s.capOptions.ambientika_operating_mode.setable, true);
  assert.equal(s.getSettings().role, 'Master');
  await shows(s, 'onoff', true);
  await s.userSets('ambientika_fan_speed', 'low');
  assert.equal(fake.unit(SLAVE).status.fanSpeed, 'Low');
  assert.equal(fake.unit(SLAVE).status.operatingMode, 'ManualHeatRecovery');
  await s.userSets('button.reset_filter', true);
  assert.ok(fake.log.some((l) => l.kind === 'reset-filter' && l.serial === SLAVE));
});

test('night detected: triggers and condition', async () => {
  const w = await world();
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'ambientika_night', false);
  assert.equal(w.triggered('night_ended').length, 0);
  fake.set(MASTER, { nightAlarm: true });
  await shows(m, 'ambientika_night', true);
  assert.equal(w.triggered('night_started').length, 1);
  assert.equal(await w.run('conditions', 'is_night', { device: m }), true);
  fake.set(MASTER, { nightAlarm: false });
  await shows(m, 'ambientika_night', false);
  assert.equal(w.triggered('night_ended').length, 1);
});

test('a unit that does not answer: unavailable after three readings, available again', async () => {
  const w = await world('de');
  const [m, m2] = await w.addSerials(MASTER, MASTER2);
  await shows(m, 'measure_temperature', 21);
  fake.fault(MASTER, '500');
  await until(() => m.available === false, 4000, 'unavailable');
  assert.equal(m.unavailableMessage, w.homey.__('errors.unit'));
  assert.equal(m2.available, true, 'the other unit is not affected');
  fake.fault(MASTER, null);
  await until(() => m.available === true, 4000, 'available again');
});

test('cloud outage: unavailable, commands give the offline message, back again by itself', async () => {
  const w = await world('it');
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'measure_temperature', 21);
  fake.outage('500');
  await until(() => m.available === false, 5000, 'unavailable');
  assert.equal(m.unavailableMessage, w.homey.__('errors.offline'));
  await assert.rejects(w.run('actions', 'set_operating_mode', { device: m, mode: 'auto' }), { message: w.homey.__('errors.offline') });
  fake.outage('ok');
  await until(() => m.available === true, 6000, 'available again');
  await w.run('actions', 'set_operating_mode', { device: m, mode: 'auto' });
  assert.equal(fake.unit(MASTER).status.operatingMode, 'Auto');
});

test('a command the cloud does not accept: message with the reason, value stays', async () => {
  const w = await world('en');
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'ambientika_operating_mode', 'smart');
  // the cloud refuses values out of range; a status it cannot take back:
  fake.set(MASTER, { operatingMode: 'SomethingNew' });
  await until(() => m.getCapabilityValue('ambientika_operating_mode') === null, 4000, 'unknown mode shown as -');
  await assert.rejects(m.userSets('ambientika_fan_speed', 'low'), /did not accept the command: .*choose an operating mode/);
  await m.userSets('ambientika_operating_mode', 'auto');
  assert.equal(fake.unit(MASTER).status.operatingMode, 'Auto');
});

test('password changed in the Ambientika app: unavailable, repair with the new login', async () => {
  const w = await world('de');
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'measure_temperature', 21);
  fake.outage('refuse-auth');
  fake.expire();
  await until(() => m.available === false, 5000, 'unavailable');
  assert.equal(m.unavailableMessage, w.homey.__('errors.rejected'));

  // repair: wrong password first, then the right one
  fake.outage('ok');
  const s = w.session();
  await w.driver.onRepair(s, m);
  await assert.rejects(s.handlers.login({ username: fake.USER, password: 'alt' }), { message: w.homey.__('errors.login') });
  await s.handlers.login({ username: fake.USER, password: fake.PASSWORD });
  await until(() => m.available === true, 4000, 'available after repair');
  await m.userSets('ambientika_operating_mode', 'night');
  assert.equal(fake.unit(MASTER).status.operatingMode, 'Night');
});

test('repair with a login that does not have the unit is refused', async () => {
  const w = await world('de');
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'measure_temperature', 21);
  fake.removeUnit(MASTER);
  const s = w.session();
  await w.driver.onRepair(s, m);
  await assert.rejects(s.handlers.login({ username: fake.USER, password: fake.PASSWORD }), { message: w.homey.__('errors.otherAccount') });
});

test('a unit removed from the account: unavailable with the reason', async () => {
  const w = await world('de');
  TIMING.unitsIntervalS = 0.5;
  try {
    const [m] = await w.addSerials(MASTER);
    await shows(m, 'measure_temperature', 21);
    fake.removeUnit(MASTER);
    await until(() => m.unavailableMessage === w.homey.__('errors.removed'), 5000, 'removed');
  } finally {
    TIMING.unitsIntervalS = 600;
  }
});

test('deleting the devices: the login is forgotten, the Account stops', async () => {
  const w = await world();
  const [m, s] = await w.addSerials(MASTER, SLAVE);
  await shows(m, 'measure_temperature', 21);
  const account = w.app.accounts.get(fake.USER.toLowerCase());
  await w.remove(m);
  assert.ok(w.homey.settings.get('logins')[fake.USER.toLowerCase()], 'still used by the Slave');
  assert.equal(account.stopped, false);
  await w.remove(s);
  assert.equal(w.homey.settings.get('logins')[fake.USER.toLowerCase()], undefined);
  assert.equal(account.stopped, true);
  assert.equal(w.app.accounts.size, 0);
});

test('restart of the app: the devices come back from the stored login', async () => {
  const w = await world();
  const list = await w.pair();
  const pairing = list.find((p) => p.data.id === MASTER);
  await w.app.onUninit();
  // a new app process with the same settings
  const homey2 = createHomey('en');
  homey2.settings.set('host', fake.url);
  homey2.settings.set('logins', w.homey.settings.get('logins'));
  const app2 = new AmbientikaApp();
  app2.homey = homey2;
  homey2.app = app2;
  await app2.onInit();
  const driver2 = new VentilationDriver();
  driver2.homey = homey2;
  driver2.devices = [];
  homey2.drivers.list = { ventilation: driver2 };
  await driver2.onInit();
  worlds.push({ app: app2 });
  const d = new VentilationDevice(homey2, driver2, pairing);
  driver2.devices.push(d);
  await d.onInit();
  await shows(d, 'measure_temperature', 21);
});

test('a device added with version 1.0.0 gets the averaged values', async () => {
  const w = await world();
  const list = await w.pair();
  const pairing = list.find((p) => p.data.id === MASTER);
  pairing.capabilities = APP.drivers[0].capabilities.filter((c) => !c.endsWith('.avg'));
  const d = await w.add(pairing);
  assert.equal(d.hasCapability('measure_temperature.avg'), true);
  assert.equal(d.hasCapability('measure_humidity.avg'), true);
  await shows(d, 'measure_temperature', 21);
});

test('wrong password: the next sign-in comes later each time', async () => {
  const w = await world();
  const [m] = await w.addSerials(MASTER);
  await shows(m, 'measure_temperature', 21);
  fake.outage('refuse-auth');
  fake.expire();
  await until(() => m.available === false, 5000, 'unavailable');
  fake.clear();
  await sleep(1500);
  // 0.3 s, then 0.6 s, 0.6 s ...: two or three tries, not one per reading (0.3 s -> five)
  assert.ok(fake.counts.auth >= 2 && fake.counts.auth <= 3, `sign-ins: ${fake.counts.auth}`);
  fake.outage('ok');
  await until(() => m.available === true, 4000, 'available again without a repair once the password is accepted again');
});

test('translations: every locale has the same keys, every text of app.json in every language', () => {
  const dir = path.join(__dirname, '..', 'locales');
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${p}${k}.`) : [`${p}${k}`])).sort();
  const en = keys(JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8')));
  const langs = fs.readdirSync(dir).map((f) => f.replace('.json', ''));
  assert.equal(langs.length, 9);
  for (const l of langs) assert.deepEqual(keys(JSON.parse(fs.readFileSync(path.join(dir, `${l}.json`), 'utf8'))), en, l);
  // every translated object in app.json has all languages
  const missing = [];
  const walk = (o, p) => {
    if (!o || typeof o !== 'object') return;
    if (typeof o.en === 'string' && !Array.isArray(o)) {
      if (p.includes('Placeholder') || p.includes('example')) return;
      for (const l of langs) if (typeof o[l] !== 'string' || o[l] === '') missing.push(`${p}.${l}`);
      return;
    }
    for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
  };
  walk(APP, 'app');
  assert.deepEqual(missing, []);
  // the dropdown ids of the flow cards are values of the capabilities
  const caps = APP.capabilities;
  const ids = (cap) => caps[cap].values.map((v) => v.id);
  for (const kind of ['conditions', 'actions']) {
    for (const card of APP.flow[kind]) {
      for (const arg of card.args || []) {
        if (arg.type !== 'dropdown') continue;
        const cap = { mode: 'ambientika_operating_mode', fan_speed: 'ambientika_fan_speed', humidity_level: 'ambientika_humidity_level', light_sensor: 'ambientika_light_sensor', air_quality: 'ambientika_air_quality', filter_status: 'ambientika_filter_status' }[arg.name];
        for (const v of arg.values) assert.ok(ids(cap).includes(v.id), `${card.id}.${arg.name}: ${v.id}`);
      }
    }
  }
});

test('pairing ended without adding a device: the login is not kept', async () => {
  const w = await world();
  const timers = [];
  w.homey.setTimeout = (fn, ms) => timers.push({ fn, ms });
  const s = w.session();
  await w.driver.onPair(s);
  await s.handlers.login({ username: fake.USER, password: fake.PASSWORD });
  await s.handlers.list_devices();
  assert.ok(w.homey.settings.get('logins')[fake.USER.toLowerCase()]);
  await s.handlers.disconnect();
  assert.equal(timers[0].ms, 60000);
  timers[0].fn();
  assert.equal(w.homey.settings.get('logins')[fake.USER.toLowerCase()], undefined);

  // with a device added the login stays
  const s2 = w.session();
  await w.driver.onPair(s2);
  await s2.handlers.login({ username: fake.USER, password: fake.PASSWORD });
  const list = await s2.handlers.list_devices();
  await w.add(list.find((p) => p.data.id === MASTER));
  await s2.handlers.disconnect();
  timers[1].fn();
  assert.ok(w.homey.settings.get('logins')[fake.USER.toLowerCase()]);
});
