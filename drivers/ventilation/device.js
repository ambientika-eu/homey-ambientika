'use strict';

const Homey = require('homey');
const { CloudError } = require('../../lib/cloud');
const { isSlave } = require('../../lib/account');
const { capabilityValues, FROM_ID } = require('../../lib/values');
const CAPS = require('../../lib/capabilities.json');

/** Capabilities Homey can set, and the setting of the command each one stands for. */
const SETTERS = {
  onoff: (v) => ({ power: v === true }),
  ambientika_operating_mode: (v) => ({ operatingMode: FROM_ID.mode[v] }),
  ambientika_fan_speed: (v) => ({ fanSpeed: FROM_ID.fan[v] }),
  ambientika_humidity_level: (v) => ({ humidityLevel: FROM_ID.humidity[v] }),
  ambientika_light_sensor: (v) => ({ lightSensorLevel: FROM_ID.light[v] }),
};
const MASTER_ONLY = ['onoff', 'ambientika_fan_speed', 'ambientika_humidity_level', 'ambientika_light_sensor', 'button.reset_filter'];

class VentilationDevice extends Homey.Device {
  async onInit() {
    this.serial = this.getData().id;
    this.deleted = false;
    this.known = false; // a first status has been shown: from then on changes fire the flow triggers

    this.registerMultipleCapabilityListener(
      Object.keys(SETTERS).filter((c) => this.hasCapability(c)),
      async (values) => this.set(values),
      300,
    );
    if (this.hasCapability('button.reset_filter')) {
      this.registerCapabilityListener('button.reset_filter', async () => this.resetFilter());
    }
    this.connect();
  }

  /** Joins the Account of its login. */
  connect() {
    const username = this.getStore().username;
    this.account = this.homey.app.getAccount(username);
    if (!this.account) {
      this.setUnavailable(this.homey.__('errors.rejected')).catch(this.error);
      return;
    }
    if (this.account.rejected) this.setUnavailable(this.homey.__('errors.rejected')).catch(this.error);
    this.account.register(this.serial, this);
  }

  /** After a repair: joins the Account again (new password or other login). */
  async reconnect() {
    if (this.account) this.account.unregister(this.serial);
    this.connect();
  }

  async onUninit() {
    if (this.account) this.account.unregister(this.serial);
  }

  async onDeleted() {
    this.deleted = true;
    const username = this.getStore().username;
    if (this.account) this.account.unregister(this.serial);
    this.homey.app.releaseAccount(username);
  }

  get slave() {
    return isSlave(this.getStore().role);
  }

  // ---------------------------------------------------------------- from the Account

  async onStatus(status) {
    const values = capabilityValues(status);
    const before = {};
    for (const [cap, value] of Object.entries(values)) {
      if (!this.hasCapability(cap)) continue;
      before[cap] = this.getCapabilityValue(cap);
      if (value === null && before[cap] === null) continue;
      if (value !== before[cap]) await this.setCapabilityValue(cap, value).catch(this.error);
    }
    if (this.known) await this.fireTriggers(before, values);
    this.known = true;
  }

  async fireTriggers(before, now) {
    const t = this.driver.triggers;
    if (!t) return;
    const changed = (cap) => this.hasCapability(cap) && now[cap] !== null && now[cap] !== before[cap];
    if (changed('ambientika_operating_mode')) {
      const id = now.ambientika_operating_mode;
      await t.mode.trigger(this, { mode: this.homey.__(`mode.${id}`), mode_id: id }).catch(this.error);
    }
    if (changed('ambientika_air_quality')) {
      await t.air.trigger(this, { air_quality: this.homey.__(`air_quality.${now.ambientika_air_quality}`) }).catch(this.error);
    }
    if (changed('ambientika_filter_status')) {
      await t.filter.trigger(this, { filter_status: this.homey.__(`filter.${now.ambientika_filter_status}`) }).catch(this.error);
    }
    if (changed('ambientika_night') && before.ambientika_night !== null) {
      await (now.ambientika_night ? t.nightOn : t.nightOff).trigger(this).catch(this.error);
    }
  }

  async onReachable(reachable, why) {
    if (reachable) {
      await this.setAvailable().catch(this.error);
      return;
    }
    const key = why === 'rejected' ? 'errors.rejected' : why === 'unit' ? 'errors.unit' : 'errors.offline';
    await this.setUnavailable(this.homey.__(key)).catch(this.error);
  }

  async onUnit(unit) {
    const roleIds = this.driver.constructor.ROLE_IDS || {};
    const roleId = roleIds[unit.role];
    const settings = {
      role: roleId ? this.homey.__(`role.${roleId}`) : unit.role || '-',
      zone: unit.zone === null ? '-' : String(unit.zone + 1),
      room: unit.room || '-',
      house: unit.house || '-',
    };
    const current = this.getSettings();
    if (Object.entries(settings).some(([k, v]) => current[k] !== v)) await this.setSettings(settings).catch(this.error);

    const wasSlave = this.slave;
    if (unit.role && unit.role !== this.getStore().role) {
      await this.setStoreValue('role', unit.role);
      this.log(`Role is now ${unit.role}`);
    }
    // Slave -> Master: the unit can be set now.
    if (wasSlave && !this.slave) await this.becomeMaster();
  }

  async becomeMaster() {
    const added = [];
    for (const cap of CAPS.master) {
      if (this.hasCapability(cap)) continue;
      try {
        await this.addCapability(cap);
        added.push(cap);
        if (CAPS.options[cap]) await this.setCapabilityOptions(cap, CAPS.options[cap]);
      } catch (e) {
        this.error(`addCapability ${cap}`, e);
      }
    }
    await this.setCapabilityOptions('ambientika_operating_mode', { setable: true }).catch(this.error);
    const setters = added.filter((c) => SETTERS[c]);
    // The operating mode keeps its listener from onInit; the new ones get their own.
    if (setters.length > 0) this.registerMultipleCapabilityListener(setters, async (values) => this.set(values), 300);
    if (added.includes('button.reset_filter')) this.registerCapabilityListener('button.reset_filter', async () => this.resetFilter());
  }

  async onRemoved() {
    await this.setUnavailable(this.homey.__('errors.removed')).catch(this.error);
  }

  // ---------------------------------------------------------------- to the Account

  /** Flow actions: the same as setting the capabilities in the device view. */
  async setFromFlow(values) {
    await this.set(values);
  }

  /**
   * Sends what was set in Homey to the unit.
   *
   * @param {object} values capability id -> new value
   */
  async set(values) {
    if (this.slave) throw new Error(this.homey.__('errors.slave'));
    if (!this.account) throw new Error(this.homey.__('errors.rejected'));
    const wanted = {};
    for (const [cap, value] of Object.entries(values)) {
      const setter = SETTERS[cap];
      if (!setter) continue;
      const part = setter(value);
      for (const [k, v] of Object.entries(part)) if (v !== undefined) wanted[k] = v;
    }
    if (Object.keys(wanted).length === 0) return;
    try {
      await this.account.command(this.serial, wanted);
    } catch (e) {
      throw this.userError(e);
    }
  }

  async resetFilter() {
    if (this.slave) throw new Error(this.homey.__('errors.slaveFilter'));
    if (!this.account) throw new Error(this.homey.__('errors.rejected'));
    try {
      await this.account.resetFilter(this.serial);
    } catch (e) {
      throw this.userError(e);
    }
  }

  userError(e) {
    this.error('Command failed:', e && e.message);
    if (e instanceof CloudError && e.kind === 'auth') return new Error(this.homey.__('errors.rejected'));
    if (e instanceof CloudError && (e.kind === 'network' || e.kind === 'timeout' || (e.status !== null && e.status >= 500))) return new Error(this.homey.__('errors.offline'));
    return new Error(this.homey.__('errors.command', { message: e instanceof Error ? e.message : String(e) }));
  }
}

VentilationDevice.MASTER_ONLY = MASTER_ONLY;
module.exports = VentilationDevice;
