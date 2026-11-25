'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startFakeCloud } = require('./fake-cloud');
const { AmbientikaCloud, CloudError, cleanHost, DEFAULT_HOST } = require('../lib/cloud');

let fake;
test.before(async () => {
  fake = await startFakeCloud();
});
test.after(async () => fake.stop());
test.beforeEach(() => fake.reset());

const client = (over = {}) => new AmbientikaCloud({ username: fake.USER, password: fake.PASSWORD, host: fake.url, timeoutS: 0.8, ...over });

test('cleanHost', () => {
  assert.equal(cleanHost(''), DEFAULT_HOST);
  assert.equal(cleanHost(undefined), DEFAULT_HOST);
  assert.equal(cleanHost(' app.example.com:4521/ '), 'https://app.example.com:4521');
  assert.equal(cleanHost('http://127.0.0.1:9'), 'http://127.0.0.1:9');
});

test('sign-in, units over houses and rooms, status', async () => {
  const c = client();
  await c.signIn();
  assert.equal(c.token, 'tok-1');
  const units = await c.units();
  assert.equal(units.length, 5);
  const flur = units.find((u) => u.name === 'Flur');
  assert.deepEqual(flur, { serial: 'A0B1C2D3E402', name: 'Flur', role: 'Master', zone: 0, type: 'Smart', room: 'Haus', house: 'Zuhause', houseId: '1' });
  const st = await c.status('A0B1C2D3E402');
  assert.equal(st.operatingMode, 'Smart');
  assert.equal(st.temperature, 21);
  c.close();
});

test('wrong password is an auth error, the password with special characters is sent as it is', async () => {
  const bad = client({ password: 'falsch' });
  await assert.rejects(bad.signIn(), (e) => e instanceof CloudError && e.kind === 'auth');
  const good = client();
  await good.signIn();
  assert.ok(fake.log.some((l) => l.kind === 'auth' && l.ok === true));
});

test('change-mode sends the numbers the cloud expects', async () => {
  const c = client();
  fake.clear();
  await c.changeMode('A0B1C2D3E402', { operatingMode: 'Night', fanSpeed: 'High', humidityLevel: 'Dry', lightSensorLevel: 'Medium' });
  const call = fake.log.find((l) => l.kind === 'change-mode');
  assert.deepEqual(call.body, { deviceSerialNumber: 'A0B1C2D3E402', operatingMode: '3', fanSpeed: 2, humidityLevel: 0, lightSensorLevel: 3 });
  assert.equal(call.ok, true);
  assert.equal(fake.unit('A0B1C2D3E402').status.operatingMode, 'Night');
  // without light sensor level the field is left out
  await c.changeMode('A0B1C2D3E402', { operatingMode: 'Off', fanSpeed: 'Low', humidityLevel: 'Normal' });
  const last = fake.log.filter((l) => l.kind === 'change-mode').pop();
  assert.equal('lightSensorLevel' in last.body, false);
  await assert.rejects(c.changeMode('A0B1C2D3E402', { operatingMode: 'Turbo', fanSpeed: 'Low', humidityLevel: 'Normal' }), /cannot be sent/);
  c.close();
});

test('an expired token is renewed once, several requests share one sign-in', async () => {
  const c = client();
  await c.signIn();
  fake.expire();
  fake.clear();
  const results = await Promise.all(fake.serials.map((s) => c.status(s)));
  assert.equal(results.length, 5);
  assert.equal(fake.counts.auth, 1);
  assert.equal(c.token, 'tok-2');
  c.close();
});

test('time limit for a request the cloud never answers', async () => {
  const c = client();
  await c.signIn();
  fake.fault('A0B1C2D3E402', 'hang');
  const t0 = Date.now();
  await assert.rejects(c.status('A0B1C2D3E402'), (e) => e.kind === 'timeout');
  assert.ok(Date.now() - t0 < 2000);
  fake.fault('A0B1C2D3E402', null);
  c.close();
});

test('broken answers and server errors', async () => {
  const c = client();
  await c.signIn();
  fake.fault('A0B1C2D3E402', 'garbage');
  await assert.rejects(c.status('A0B1C2D3E402'), (e) => e.kind === 'format');
  fake.fault('A0B1C2D3E402', 'html');
  await assert.rejects(c.status('A0B1C2D3E402'), (e) => e.kind === 'format');
  fake.fault('A0B1C2D3E402', '500');
  await assert.rejects(c.status('A0B1C2D3E402'), (e) => e.status === 500 && /boom/.test(e.message));
  fake.fault('A0B1C2D3E402', null);
  c.close();
});

test('no server at the address: network error', async () => {
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const c = client({ host: `http://127.0.0.1:${port}` });
  await assert.rejects(c.signIn(), (e) => e.kind === 'network');
});

test('redirects are followed: 307 and 308 keep the method, 302 becomes GET', async () => {
  for (const status of [307, 308]) {
    fake.reset();
    fake.redirect(status);
    const c = client();
    await c.signIn();
    const units = await c.units();
    assert.equal(units.length, 5);
    await c.changeMode('A0B1C2D3E401', { operatingMode: 'Auto', fanSpeed: 'Low', humidityLevel: 'Normal' });
    assert.equal(fake.unit('A0B1C2D3E401').status.operatingMode, 'Auto');
    assert.ok(fake.counts.redirect >= 4);
    c.close();
  }
  fake.reset();
  fake.redirect(302);
  const c = client();
  // A POST that is redirected with 302 arrives as GET, which the sign-in does not take.
  await assert.rejects(c.signIn());
  c.token = 'tok-1';
  const st = await c.status('A0B1C2D3E402'); // GET through 302 works
  assert.equal(st.operatingMode, 'Smart');
  c.close();
  fake.redirect(0);
});

test('reset-filter clears the counter of a Master', async () => {
  const c = client();
  fake.set('A0B1C2D3E402', { filtersStatus: 'Bad' });
  await c.resetFilter('A0B1C2D3E402');
  assert.equal(fake.unit('A0B1C2D3E402').status.filtersStatus, 'Good');
  c.close();
});

test('close() ends requests under way and refuses new ones', async () => {
  const c = client({ timeoutS: 10 });
  await c.signIn();
  fake.fault('A0B1C2D3E402', 'hang');
  const p = c.status('A0B1C2D3E402');
  setTimeout(() => c.close(), 50);
  await assert.rejects(p, (e) => e.kind === 'network');
  await assert.rejects(c.status('A0B1C2D3E401'), /stopping/);
  fake.fault('A0B1C2D3E402', null);
});
