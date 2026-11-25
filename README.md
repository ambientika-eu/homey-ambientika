# Ambientika for Homey

Homey app for **Ambientika** decentralised ventilation units with heat recovery (SMART, OFFICE) by Südwind.

The app signs in to the Ambientika cloud with the e-mail address and password of the Ambientika app, the same way the app on your phone does. Every unit of the account becomes a Homey device.

## What it does

| In Homey | |
| --- | --- |
| On / off | Off is the mode Off; on returns to the last mode (Smart when there is none) |
| Operating mode | Smart, Auto, manual heat recovery, Night, Away, Surveillance, timed exhaust, exhaust, intake, flow Master → Slave, flow Slave → Master, Off |
| Fan speed | Low, Medium, High. In Smart, Auto, Night, Away and Surveillance the unit chooses the speed itself; a fixed speed switches it to manual heat recovery |
| Humidity level | Dry, Normal, Moist |
| Light sensor | Off, Low, High |
| Sensors | Temperature and humidity (checked for plausibility, and averaged over 30 minutes), air quality, filter status, humidity alarm, night detected by the light sensor |
| Maintenance | Reset the filter counter (Master); the reset is checked against the status the unit reports afterwards |

Flow cards: triggers for operating mode, air quality, filter status and night/day; conditions for operating mode, air quality, filter status and night; actions for operating mode, fan speed, humidity level, light sensor and filter reset.

A unit that runs as a **Slave** follows the Master of its zone. Homey shows its sensors and the mode of its Master; settings are changed at the Master.

The app follows the same rules as the [Ambientika MQTT Bridge](https://github.com/ambientika-eu/ambientika-mqtt-bridge) and the integration for Home Assistant, so all of them show the same values. A command stays shown until the unit reports it (up to two minutes); the cloud confirms that it took the command, the unit reports it a little later.

Languages: English, German, Dutch, Italian, French, Spanish, Danish, Swedish, Polish.

## Requirements

- Homey Pro (2023 or later) or Homey Pro mini, Homey 12.2 or later
- Ambientika SMART or OFFICE, set up in the Ambientika app and connected to the Wi-Fi

## Install

From the Homey App Store: search for **Ambientika**.

From this repository (developers):

```bash
npm install --global homey
git clone https://github.com/ambientika-eu/homey-ambientika.git
cd homey-ambientika
homey app install
```

## Development

```bash
node scripts/compose.js      # writes the compose files from scripts/texts.js
npx homey app validate --level publish
npm test                     # tests and simulations against a local stand-in of the Ambientika cloud
```

The texts of modes and sensors are the ones of the [Home Assistant integration](https://github.com/ambientika-eu/HomeAssistant-integration-for-Ambientika), so that the Ambientika app, Home Assistant and Homey use the same words.

## Support

info@ambientika.eu · https://www.ambientika.eu

Maintained by Südwind GmbH, the manufacturer of Ambientika. MIT License.
