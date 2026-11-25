'use strict';

require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { planCommand } = require('../lib/account');
const { capabilityValues } = require('../lib/values');

const base = (over = {}) => ({ operatingMode: 'Smart', fanSpeed: 'Medium', humidityLevel: 'Normal', lightSensorLevel: 'Low', lastOperatingMode: 'Auto', ...over });

test('operating mode only: the other settings stay', () => {
  assert.deepEqual(planCommand(base(), { operatingMode: 'Night' }), { operatingMode: 'Night', fanSpeed: 'Medium', humidityLevel: 'Normal', lightSensorLevel: 'Low' });
});

test('off and on again: back to the last mode, Smart when there is none', () => {
  assert.equal(planCommand(base(), { power: false }).operatingMode, 'Off');
  assert.equal(planCommand(base({ operatingMode: 'Off', lastOperatingMode: 'Night' }), { power: true }).operatingMode, 'Night');
  assert.equal(planCommand(base({ operatingMode: 'Off', lastOperatingMode: 'Off' }), { power: true }).operatingMode, 'Smart');
  assert.equal(planCommand(base({ operatingMode: 'Off', lastOperatingMode: undefined }), { power: true }).operatingMode, 'Smart');
  // on while running changes nothing
  assert.equal(planCommand(base({ operatingMode: 'Auto' }), { power: true }).operatingMode, 'Auto');
});

test('a fixed fan step out of Smart or Auto: manual heat recovery', () => {
  assert.deepEqual(planCommand(base(), { fanSpeed: 'High' }), { operatingMode: 'ManualHeatRecovery', fanSpeed: 'High', humidityLevel: 'Normal', lightSensorLevel: 'Low' });
  assert.equal(planCommand(base({ operatingMode: 'Auto' }), { fanSpeed: 'Low' }).operatingMode, 'ManualHeatRecovery');
  assert.equal(planCommand(base({ operatingMode: 'Night' }), { fanSpeed: 'Low' }).operatingMode, 'Night');
  // with a mode in the same command the mode wins
  assert.equal(planCommand(base(), { fanSpeed: 'Low', operatingMode: 'Auto' }).operatingMode, 'Auto');
  // a unit that is off runs in its last fixed mode again
  assert.equal(planCommand(base({ operatingMode: 'Off', lastOperatingMode: 'Intake' }), { fanSpeed: 'Low' }).operatingMode, 'Intake');
  assert.equal(planCommand(base({ operatingMode: 'Off', lastOperatingMode: 'Smart' }), { fanSpeed: 'Low' }).operatingMode, 'ManualHeatRecovery');
});

test('Night and Turbo are not sent: the last fixed step instead', () => {
  assert.equal(planCommand(base({ fanSpeed: 'Night' }), { operatingMode: 'Auto' }).fanSpeed, 'Low');
  assert.equal(planCommand(base({ fanSpeed: 'Turbo' }), { operatingMode: 'Auto' }).fanSpeed, 'High');
  assert.equal(planCommand(base({ fanSpeed: 'Turbo' }), { operatingMode: 'Auto' }, { lastFan: 'Medium' }).fanSpeed, 'Medium');
});

test('unknown values: humidity Normal, light sensor left out, unknown mode refused', () => {
  const p = planCommand(base({ humidityLevel: 'Strange', lightSensorLevel: 'Strange' }), { operatingMode: 'Auto' });
  assert.equal(p.humidityLevel, 'Normal');
  assert.equal('lightSensorLevel' in p, false);
  assert.throws(() => planCommand(base({ operatingMode: 'Strange' }), { fanSpeed: 'Low' }), /choose an operating mode/);
  // the light sensor level remembered from before the unit was switched off
  assert.equal(planCommand(base({ operatingMode: 'Off', lightSensorLevel: 'NotAvailable' }), { power: true }, { lastLight: 'Medium' }).lightSensorLevel, 'Medium');
});

test('capability values of a status packet', () => {
  const v = capabilityValues({ operatingMode: 'ManualHeatRecovery', fanSpeed: 'Turbo', humidityLevel: 'Moist', lightSensorLevel: 'Medium', temperature: 21.36, humidity: 104, airQuality: 'VeryGood', filtersStatus: 'Bad', humidityAlarm: true, nightAlarm: false });
  assert.deepEqual(v, {
    onoff: true,
    ambientika_operating_mode: 'manual_heat_recovery',
    ambientika_fan_speed: 'high',
    ambientika_humidity_level: 'moist',
    ambientika_light_sensor: 'high',
    measure_temperature: 21.4,
    measure_humidity: 100,
    ambientika_air_quality: 'very_good',
    ambientika_filter_status: 'bad',
    alarm_moisture: true,
    ambientika_night: false,
  });
  const empty = capabilityValues({ operatingMode: 'Off' });
  assert.equal(empty.onoff, false);
  assert.equal(empty.measure_temperature, null);
  assert.equal(empty.ambientika_light_sensor, null);
  assert.equal(capabilityValues({ operatingMode: 'Off', lightSensorLevel: 'NotAvailable' }).ambientika_light_sensor, null);
});
