'use strict';

/**
 * Writes the Homey Compose files (.homeycompose, driver compose files, locales)
 * from scripts/texts.js and scripts/hacs_labels.json. Run after changing a text:
 *
 *   node scripts/compose.js && npx homey app build
 */

const fs = require('fs');
const path = require('path');
const { LANGS, T } = require('./texts');

const ROOT = path.join(__dirname, '..');
const H = JSON.parse(fs.readFileSync(path.join(__dirname, 'hacs_labels.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// The light sensor steps: the cloud says Medium, the app says High. Our id is "high".
for (const l of LANGS) {
  const light = H[l].light;
  H[l].light = { off: light.off, low: light.low, high: light.medium };
}

function tr(key) {
  const out = {};
  for (const l of LANGS) {
    if (T[key][l] === undefined) throw new Error(`missing ${key}.${l}`);
    out[l] = T[key][l];
  }
  return out;
}
function fromH(pick) {
  const out = {};
  for (const l of LANGS) out[l] = pick(H[l]);
  return out;
}
function values(group, ids) {
  return ids.map((id) => ({ id, title: fromH((h) => h[group][id]) }));
}
function write(rel, data) {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

const MODES = ['smart', 'auto', 'manual_heat_recovery', 'night', 'away_home', 'surveillance', 'timed_expulsion', 'expulsion', 'intake', 'master_slave_flow', 'slave_master_flow', 'off'];
const FANS = ['low', 'medium', 'high'];
const HUMS = ['dry', 'normal', 'moist'];
const LIGHTS = ['off', 'low', 'high'];
const AIRS = ['very_good', 'good', 'medium', 'poor', 'bad'];
const FILTERS = ['good', 'medium', 'bad'];

// ------------------------------------------------------------------ app.json
write('.homeycompose/app.json', {
  id: 'eu.ambientika',
  version: pkg.version,
  compatibility: '>=12.2.0',
  sdk: 3,
  platforms: ['local'],
  name: Object.fromEntries(LANGS.map((l) => [l, 'Ambientika'])),
  description: tr('appDescription'),
  category: ['climate'],
  tags: {
    en: ['ventilation', 'heat recovery', 'air quality', 'humidity', 'Südwind', 'SMART', 'OFFICE'],
    de: ['Lüftung', 'Wohnraumlüftung', 'Wärmerückgewinnung', 'Luftqualität', 'Luftfeuchtigkeit', 'Südwind'],
    nl: ['ventilatie', 'warmteterugwinning', 'luchtkwaliteit', 'vochtigheid', 'WTW', 'Südwind'],
    it: ['ventilazione', 'VMC', 'recupero di calore', "qualità dell'aria", 'umidità', 'Südwind'],
    fr: ['ventilation', 'VMC', 'récupération de chaleur', "qualité de l'air", 'humidité', 'Südwind'],
    es: ['ventilación', 'recuperación de calor', 'calidad del aire', 'humedad', 'Südwind'],
    da: ['ventilation', 'varmegenvinding', 'luftkvalitet', 'fugt', 'Südwind'],
    sv: ['ventilation', 'värmeåtervinning', 'luftkvalitet', 'fukt', 'Südwind'],
    pl: ['wentylacja', 'rekuperacja', 'odzysk ciepła', 'jakość powietrza', 'wilgotność', 'Südwind'],
  },
  brandColor: '#2C5D8F',
  permissions: [],
  images: {
    small: '/assets/images/small.png',
    large: '/assets/images/large.png',
    xlarge: '/assets/images/xlarge.png',
  },
  author: { name: 'Südwind GmbH', email: 'info@ambientika.eu' },
  homepage: 'https://www.ambientika.eu',
  support: 'mailto:info@ambientika.eu',
  source: 'https://github.com/ambientika-eu/homey-ambientika',
  bugs: { url: 'https://github.com/ambientika-eu/homey-ambientika/issues' },
});

// ------------------------------------------------------------------ capabilities
write('.homeycompose/capabilities/ambientika_operating_mode.json', {
  type: 'enum',
  title: fromH((h) => h.mode_name),
  getable: true,
  setable: true,
  uiComponent: 'picker',
  insights: false,
  values: values('mode', MODES),
});
write('.homeycompose/capabilities/ambientika_fan_speed.json', {
  type: 'enum',
  title: fromH((h) => h.fan_name),
  getable: true,
  setable: true,
  uiComponent: 'picker',
  insights: false,
  values: values('fan', FANS),
});
write('.homeycompose/capabilities/ambientika_humidity_level.json', {
  type: 'enum',
  title: fromH((h) => h.hum_name),
  getable: true,
  setable: true,
  uiComponent: 'picker',
  insights: false,
  values: values('hum', HUMS),
});
write('.homeycompose/capabilities/ambientika_light_sensor.json', {
  type: 'enum',
  title: fromH((h) => h.light_name),
  getable: true,
  setable: true,
  uiComponent: 'picker',
  insights: false,
  values: values('light', LIGHTS),
});
write('.homeycompose/capabilities/ambientika_air_quality.json', {
  type: 'enum',
  title: fromH((h) => h.aq_name),
  getable: true,
  setable: false,
  uiComponent: 'sensor',
  icon: '/assets/capabilities/air_quality.svg',
  insights: false,
  values: values('aq', AIRS),
});
write('.homeycompose/capabilities/ambientika_filter_status.json', {
  type: 'enum',
  title: fromH((h) => h.filter_name),
  getable: true,
  setable: false,
  uiComponent: 'sensor',
  icon: '/assets/capabilities/filter.svg',
  insights: false,
  values: values('filter', FILTERS),
});
write('.homeycompose/capabilities/ambientika_night.json', {
  type: 'boolean',
  title: tr('nightCap'),
  getable: true,
  setable: false,
  uiComponent: 'sensor',
  icon: '/assets/capabilities/night.svg',
  insights: true,
  insightsTitleTrue: tr('trgNightOn'),
  insightsTitleFalse: tr('trgNightOff'),
});

// ------------------------------------------------------------------ driver
const MASTER_CAPS = [
  'onoff',
  'ambientika_operating_mode',
  'ambientika_fan_speed',
  'ambientika_humidity_level',
  'ambientika_light_sensor',
  'measure_temperature',
  'measure_humidity',
  'ambientika_air_quality',
  'alarm_moisture',
  'ambientika_filter_status',
  'ambientika_night',
  'button.reset_filter',
];
const CAP_OPTIONS = {
  alarm_moisture: { title: fromH((h) => h.humalarm) },
  'button.reset_filter': { title: fromH((h) => h.reset), maintenanceAction: true },
};
fs.writeFileSync(path.join(ROOT, 'lib', 'capabilities.json'), `${JSON.stringify({ master: MASTER_CAPS, options: CAP_OPTIONS }, null, 2)}\n`);

const label = (id, key) => ({ id, type: 'label', label: tr(key), value: '' });
write('drivers/ventilation/driver.compose.json', {
  name: tr('driverName'),
  class: 'fan',
  capabilities: MASTER_CAPS,
  capabilitiesOptions: CAP_OPTIONS,
  platforms: ['local'],
  connectivity: ['cloud'],
  images: {
    small: '{{driverAssetsPath}}/images/small.png',
    large: '{{driverAssetsPath}}/images/large.png',
    xlarge: '{{driverAssetsPath}}/images/xlarge.png',
  },
  pair: [
    {
      id: 'login_credentials',
      template: 'login_credentials',
      options: {
        title: tr('loginTitle'),
        usernameLabel: tr('usernameLabel'),
        usernamePlaceholder: { en: 'name@example.com' },
        passwordLabel: tr('passwordLabel'),
        passwordPlaceholder: { en: '••••••••' },
      },
    },
    { id: 'list_devices', template: 'list_devices', navigation: { next: 'add_devices' } },
    { id: 'add_devices', template: 'add_devices' },
  ],
  repair: [
    {
      id: 'login_credentials',
      template: 'login_credentials',
      options: {
        title: tr('loginTitle'),
        usernameLabel: tr('usernameLabel'),
        usernamePlaceholder: { en: 'name@example.com' },
        passwordLabel: tr('passwordLabel'),
        passwordPlaceholder: { en: '••••••••' },
      },
    },
  ],
});
write('drivers/ventilation/driver.settings.compose.json', [
  {
    type: 'group',
    label: tr('settingsGroup'),
    children: [label('serial', 'settingSerial'), label('role', 'settingRole'), label('zone', 'settingZone'), label('room', 'settingRoom'), label('house', 'settingHouse'), label('account', 'settingAccount')],
  },
]);

const dropdown = (name, titleKey, group, ids) => ({
  name,
  type: 'dropdown',
  title: typeof titleKey === 'string' ? tr(titleKey) : titleKey,
  values: values(group, ids),
});
write('drivers/ventilation/driver.flow.compose.json', {
  triggers: [
    {
      id: 'operating_mode_changed',
      title: tr('trgMode'),
      tokens: [
        { name: 'mode', type: 'string', title: tr('tokenMode'), example: { en: 'Smart' } },
        { name: 'mode_id', type: 'string', title: Object.fromEntries(LANGS.map((l) => [l, `${T.tokenMode[l]} (id)`])), example: { en: 'smart' } },
      ],
    },
    {
      id: 'air_quality_changed',
      title: tr('trgAir'),
      tokens: [{ name: 'air_quality', type: 'string', title: fromH((h) => h.aq_name), example: fromH((h) => h.aq.good) }],
    },
    {
      id: 'filter_status_changed',
      title: tr('trgFilter'),
      tokens: [{ name: 'filter_status', type: 'string', title: fromH((h) => h.filter_name), example: fromH((h) => h.filter.bad) }],
    },
    { id: 'night_started', title: tr('trgNightOn') },
    { id: 'night_ended', title: tr('trgNightOff') },
  ],
  conditions: [
    { id: 'operating_mode_is', title: tr('condModeTitle'), titleFormatted: tr('condMode'), args: [dropdown('mode', 'argMode', 'mode', MODES)] },
    { id: 'air_quality_worse_than', title: tr('condAirTitle'), titleFormatted: tr('condAir'), args: [dropdown('air_quality', fromH((h) => h.aq_name), 'aq', AIRS.slice(0, 4))] },
    { id: 'filter_status_is', title: tr('condFilterTitle'), titleFormatted: tr('condFilter'), args: [dropdown('filter_status', fromH((h) => h.filter_name), 'filter', FILTERS)] },
    { id: 'is_night', title: tr('condNightTitle'), titleFormatted: tr('condNight') },
  ],
  actions: [
    { id: 'set_operating_mode', title: tr('actModeTitle'), titleFormatted: tr('actMode'), args: [dropdown('mode', 'argMode', 'mode', MODES)] },
    { id: 'set_fan_speed', title: tr('actFanTitle'), titleFormatted: tr('actFan'), hint: tr('actFanHint'), args: [dropdown('fan_speed', fromH((h) => h.fan_name), 'fan', FANS)] },
    { id: 'set_humidity_level', title: tr('actHumTitle'), titleFormatted: tr('actHum'), args: [dropdown('humidity_level', fromH((h) => h.hum_name), 'hum', HUMS)] },
    { id: 'set_light_sensor', title: tr('actLightTitle'), titleFormatted: tr('actLight'), args: [dropdown('light_sensor', fromH((h) => h.light_name), 'light', LIGHTS)] },
    { id: 'reset_filter', title: tr('actReset'), hint: tr('actResetHint') },
  ],
});

// ------------------------------------------------------------------ locales (runtime texts)
const RUNTIME = {
  errors: { slave: 'errSlave', offline: 'errOffline', rejected: 'errRejected', unit: 'errUnit', removed: 'errRemoved', command: 'errCommand', login: 'errLogin', connect: 'errConnect', otherAccount: 'errOtherAccount', slaveFilter: 'slaveFilter' },
};
for (const l of LANGS) {
  const out = { errors: {}, mode: H[l].mode, fan: H[l].fan, humidity: H[l].hum, light: H[l].light, air_quality: H[l].aq, filter: H[l].filter, role: H[l].role };
  for (const [k, key] of Object.entries(RUNTIME.errors)) out.errors[k] = T[key][l];
  write(`locales/${l}.json`, out);
}
console.log('compose files written');
