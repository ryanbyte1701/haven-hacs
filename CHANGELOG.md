# Changelog

Changes to Haven for Home Assistant. This file is generated from [ryanbyte1701/haven](https://github.com/ryanbyte1701/haven/blob/main/CHANGELOG.md).

## 2026-11-17 (v3)

- **Settings → Diagnostics**: download an anonymous tech dump for troubleshooting (every device's type, model,
  integration and what it reports, integration status, filled-in settings, history storage and recent warnings).
  Names and rooms are replaced, ids scrambled, and IP/MAC/e-mail addresses, host names, tokens and passwords
  removed. **Copy summary** puts a short version on the clipboard.

## 2026-11-17 (v2)

- Security page now includes smoke, CO and gas alarms, and presence, occupancy and motion sensors (you can still
  remove a device from Security on the Devices page).
- **Group by Room | Type** on every device page, remembered per page. Type groups cards into Thermostats,
  Lights, Locks, Doors & windows, Motion & presence, Smoke & CO alarms, Leak sensors, Plugs & switches and more;
  each card still shows its room.
- Devices page: **Offline (n)** filter and an **Offline first** sort.
- Device pop-up: live chart of the last 5 minutes on **Now**; **History** in 4 h, 24 h, 7 days (30 days and 1 year
  when kept) and a **custom range**; close with the **X**, a click outside, or Escape.
- Phones: the table layout fills the width, shows "Source · Room" on one line and a compact battery; alert chips
  are grouped ("11 offline") with an expandable list instead of a row of identical icons; long field labels no
  longer spill over the field border.
- Large screens (1440p and up) use the full width; cards grow to fill each row.
- New Haven logo (side menu, sign-in, browser tab).
- Smart plugs and power strips from Home Assistant (TP-Link/Tapo, Kasa and others) are recognised as plugs and
  appear on the Power page with today's and this month's energy.
- Temperatures on sliders and chips follow your °F/°C setting.

- UPS monitoring (NUT client), the weather forecast and outdoor air quality are available again in Settings.
- UPSes from Home Assistant's NUT integration appear on the Power page with the full UPS panel (status, charge,
  runtime, load, voltages).
- Home Assistant weather entities fill the Home page weather card, including the daily forecast.
- Release notes now come from this changelog.

## 2026-11-17

- First release: Haven as a Home Assistant integration with a **Haven** item in the side menu; every device,
  area and live state comes straight from Home Assistant; HA admins are Haven admins, other HA users are Regular.
