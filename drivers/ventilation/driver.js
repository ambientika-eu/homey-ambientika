'use strict';

const Homey = require('homey');
const { AmbientikaCloud, CloudError } = require('../../lib/cloud');
const { isSlave } = require('../../lib/account');
const { AIR_QUALITY_ORDER } = require('../../lib/values');
const CAPS = require('../../lib/capabilities.json');

/** What a Slave shows: its sensors and the mode it runs in, nothing to set. */
const SLAVE_CAPS = CAPS.master.filter((c) => !['onoff', 'ambientika_fan_speed', 'ambientika_humidity_level', 'ambientika_light_sensor', 'button.reset_filter'].includes(c));

const ROLE_IDS = { Master: 'master', SlaveEqualMaster: 'slave_equal_master', SlaveOppositeMaster: 'slave_opposite_master', NotConfigured: 'not_configured' };

class VentilationDriver extends Homey.Driver {
  async onInit() {
    const flow = this.homey.flow;
    this.triggers = {
      mode: flow.getDeviceTriggerCard('operating_mode_changed'),
      air: flow.getDeviceTriggerCard('air_quality_changed'),
      filter: flow.getDeviceTriggerCard('filter_status_changed'),
      nightOn: flow.getDeviceTriggerCard('night_started'),
      nightOff: flow.getDeviceTriggerCard('night_ended'),
    };

    flow.getConditionCard('operating_mode_is').registerRunListener(async ({ device, mode }) => device.getCapabilityValue('ambientika_operating_mode') === mode);
    flow.getConditionCard('air_quality_worse_than').registerRunListener(async ({ device, air_quality: limit }) => {
      const now = AIR_QUALITY_ORDER.indexOf(device.getCapabilityValue('ambientika_air_quality'));
      return now >= 0 && now > AIR_QUALITY_ORDER.indexOf(limit);
    });
    flow.getConditionCard('filter_status_is').registerRunListener(async ({ device, filter_status: status }) => device.getCapabilityValue('ambientika_filter_status') === status);
    flow.getConditionCard('is_night').registerRunListener(async ({ device }) => device.getCapabilityValue('ambientika_night') === true);

    flow.getActionCard('set_operating_mode').registerRunListener(async ({ device, mode }) => device.setFromFlow({ ambientika_operating_mode: mode }));
    flow.getActionCard('set_fan_speed').registerRunListener(async ({ device, fan_speed: fan }) => device.setFromFlow({ ambientika_fan_speed: fan }));
    flow.getActionCard('set_humidity_level').registerRunListener(async ({ device, humidity_level: level }) => device.setFromFlow({ ambientika_humidity_level: level }));
    flow.getActionCard('set_light_sensor').registerRunListener(async ({ device, light_sensor: level }) => device.setFromFlow({ ambientika_light_sensor: level }));
    flow.getActionCard('reset_filter').registerRunListener(async ({ device }) => device.resetFilter());
  }

  /** Translates a CloudError of the sign-in into a message for the pairing screen. */
  loginError(e) {
    if (e instanceof CloudError && e.kind === 'auth') return new Error(this.homey.__('errors.login'));
    return new Error(this.homey.__('errors.connect', { message: e instanceof Error ? e.message : String(e) }));
  }

  /** Signs in with a temporary client and reads the units. */
  async tryLogin(username, password) {
    const cloud = new AmbientikaCloud({ username: String(username || '').trim(), password: String(password || ''), host: this.homey.app.cloudHost() });
    try {
      await cloud.signIn();
      return await cloud.units();
    } catch (e) {
      throw this.loginError(e);
    } finally {
      cloud.close();
    }
  }

  /** The Homey device of a unit, as the pairing list shows it. */
  deviceOf(unit, username) {
    const slave = isSlave(unit.role);
    const roleId = ROLE_IDS[unit.role];
    const device = {
      name: unit.name || `Ambientika ${unit.serial}`,
      data: { id: unit.serial },
      store: { username, role: unit.role },
      settings: {
        serial: unit.serial,
        role: roleId ? this.homey.__(`role.${roleId}`) : unit.role || '-',
        zone: unit.zone === null ? '-' : String(unit.zone + 1),
        room: unit.room || '-',
        house: unit.house || '-',
        account: username,
      },
    };
    if (slave) {
      device.capabilities = SLAVE_CAPS;
      device.capabilitiesOptions = {
        ...Object.fromEntries(Object.entries(CAPS.options).filter(([k]) => SLAVE_CAPS.includes(k))),
        ambientika_operating_mode: { setable: false },
      };
    }
    return device;
  }

  async onPair(session) {
    let username = '';
    let password = '';
    let units = [];

    session.setHandler('login', async (data) => {
      units = await this.tryLogin(data.username, data.password);
      username = String(data.username).trim();
      password = String(data.password);
      return true;
    });

    // Pairing ended without adding a device: the login is not kept.
    session.setHandler('disconnect', async () => {
      if (!username) return;
      const name = username;
      const later = typeof this.homey.setTimeout === 'function' ? this.homey.setTimeout.bind(this.homey) : setTimeout;
      later(() => this.homey.app.releaseAccount(name), 60 * 1000);
    });

    session.setHandler('list_devices', async () => {
      // The login is stored only now: when the user adds devices, they need it.
      this.homey.app.saveLogin(username, password);
      return units.map((u) => this.deviceOf(u, username));
    });
  }

  async onRepair(session, device) {
    session.setHandler('login', async (data) => {
      const list = await this.tryLogin(data.username, data.password);
      if (!list.some((u) => u.serial === device.getData().id)) throw new Error(this.homey.__('errors.otherAccount'));
      const name = String(data.username).trim();
      const before = device.getStore().username;
      this.homey.app.saveLogin(name, String(data.password));
      if (before && before.toLowerCase() !== name.toLowerCase()) {
        await device.setStoreValue('username', name);
        await device.reconnect();
      } else {
        await device.reconnect();
      }
      return true;
    });
  }
}

VentilationDriver.ROLE_IDS = ROLE_IDS;
VentilationDriver.SLAVE_CAPS = SLAVE_CAPS;
module.exports = VentilationDriver;
