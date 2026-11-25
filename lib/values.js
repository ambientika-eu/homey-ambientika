'use strict';

/**
 * The values of the cloud and their ids in Homey (capability values, flow card arguments).
 * The ids are the ones of the Home Assistant integration, the labels come from its translations.
 */

const MODE_IDS = {
  Smart: 'smart',
  Auto: 'auto',
  ManualHeatRecovery: 'manual_heat_recovery',
  Night: 'night',
  AwayHome: 'away_home',
  Surveillance: 'surveillance',
  TimedExpulsion: 'timed_expulsion',
  Expulsion: 'expulsion',
  Intake: 'intake',
  MasterSlaveFlow: 'master_slave_flow',
  SlaveMasterFlow: 'slave_master_flow',
  Off: 'off',
};
const FAN_IDS = { Low: 'low', Medium: 'medium', High: 'high' };
/** Steps the unit chooses itself; shown as the nearest fixed step. */
const FAN_SHOWN_AS = { Night: 'low', Turbo: 'high' };
const HUMIDITY_IDS = { Dry: 'dry', Normal: 'normal', Moist: 'moist' };
/** The app calls the steps Off, Low and High; the cloud calls them Off, Low and Medium. */
const LIGHT_IDS = { Off: 'off', Low: 'low', Medium: 'high' };
const AIR_QUALITY_IDS = { VeryGood: 'very_good', Good: 'good', Medium: 'medium', Poor: 'poor', Bad: 'bad' };
const FILTER_IDS = { Good: 'good', Medium: 'medium', Bad: 'bad' };

function invert(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) out[v] = k;
  return out;
}

const FROM_ID = {
  mode: invert(MODE_IDS),
  fan: invert(FAN_IDS),
  humidity: invert(HUMIDITY_IDS),
  light: invert(LIGHT_IDS),
};

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The capability values of a status packet. null = not known (Homey shows "-").
 *
 * @param {object} status status packet of the cloud
 * @returns {object} capability id -> value
 */
function capabilityValues(status) {
  const humidity = num(status.humidity);
  return {
    onoff: status.operatingMode !== 'Off',
    ambientika_operating_mode: MODE_IDS[status.operatingMode] || null,
    ambientika_fan_speed: FAN_IDS[status.fanSpeed] || FAN_SHOWN_AS[status.fanSpeed] || null,
    ambientika_humidity_level: HUMIDITY_IDS[status.humidityLevel] || null,
    ambientika_light_sensor: LIGHT_IDS[status.lightSensorLevel] || null,
    measure_temperature: num(status.temperature) === null ? null : Math.round(status.temperature * 10) / 10,
    measure_humidity: humidity === null ? null : Math.min(100, Math.max(0, humidity)),
    ambientika_air_quality: AIR_QUALITY_IDS[status.airQuality] || null,
    ambientika_filter_status: FILTER_IDS[status.filtersStatus] || null,
    alarm_moisture: typeof status.humidityAlarm === 'boolean' ? status.humidityAlarm : null,
    ambientika_night: typeof status.nightAlarm === 'boolean' ? status.nightAlarm : null,
  };
}

/** Air quality from best (0) to worst (4), for the condition "worse than". */
const AIR_QUALITY_ORDER = ['very_good', 'good', 'medium', 'poor', 'bad'];

module.exports = {
  MODE_IDS,
  FAN_IDS,
  HUMIDITY_IDS,
  LIGHT_IDS,
  AIR_QUALITY_IDS,
  FILTER_IDS,
  FROM_ID,
  AIR_QUALITY_ORDER,
  capabilityValues,
};
