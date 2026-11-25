'use strict';

const Homey = require('homey');
const { Account } = require('./lib/account');

/**
 * Ambientika for Homey.
 *
 * Signs in to the Ambientika cloud with the login of the Ambientika app and
 * shows every unit of the account (SMART, OFFICE) as a Homey device.
 * One Account per login is shared by all devices of that login.
 *
 * Maintained by Südwind GmbH, the manufacturer of Ambientika.
 */
class AmbientikaApp extends Homey.App {
  async onInit() {
    /** lower-case e-mail address -> Account */
    this.accounts = new Map();
    this.log('Ambientika app started');
  }

  async onUninit() {
    for (const account of this.accounts.values()) account.stop();
    this.accounts.clear();
  }

  /** Address of the cloud. Empty = the one of the Ambientika app; only support changes it. */
  cloudHost() {
    const host = this.homey.settings.get('host');
    return typeof host === 'string' && host.trim() !== '' ? host : undefined;
  }

  static key(username) {
    return String(username || '').trim().toLowerCase();
  }

  /** Stored logins: { key: { username, password } }. Only the logins that devices use are kept. */
  logins() {
    const stored = this.homey.settings.get('logins');
    return stored && typeof stored === 'object' ? stored : {};
  }

  saveLogin(username, password) {
    const logins = this.logins();
    logins[AmbientikaApp.key(username)] = { username: String(username).trim(), password };
    this.homey.settings.set('logins', logins);
    const account = this.accounts.get(AmbientikaApp.key(username));
    if (account && account.password !== password) account.setPassword(password);
  }

  /**
   * The shared Account of a login; started on first use. undefined when no password is stored.
   *
   * @param {string} username
   * @returns {Account|undefined}
   */
  getAccount(username) {
    const key = AmbientikaApp.key(username);
    let account = this.accounts.get(key);
    if (account) return account;
    const login = this.logins()[key];
    if (!login) return undefined;
    account = new Account({
      username: login.username,
      password: login.password,
      host: this.cloudHost(),
      log: (...args) => this.log(`[${login.username}]`, ...args),
      error: (...args) => this.error(`[${login.username}]`, ...args),
    });
    this.accounts.set(key, account);
    account.start();
    return account;
  }

  /** A device was deleted: an Account without devices is stopped and its login forgotten. */
  releaseAccount(username) {
    const key = AmbientikaApp.key(username);
    const account = this.accounts.get(key);
    if (account && account.deviceCount > 0) return;
    const stillUsed = this.homey.drivers
      ? Object.values(this.homey.drivers.getDrivers()).some((driver) => driver.getDevices().some((d) => AmbientikaApp.key(d.getStore().username) === key && !d.deleted))
      : false;
    if (stillUsed) return;
    if (account) account.stop();
    this.accounts.delete(key);
    const logins = this.logins();
    if (logins[key]) {
      delete logins[key];
      this.homey.settings.set('logins', logins);
    }
  }
}

module.exports = AmbientikaApp;
