# Changelog

Changes to Haven for Home Assistant. This file is generated from [ryanbyte1701/haven](https://github.com/ryanbyte1701/haven/blob/main/CHANGELOG.md).

## 2026-11-24

- Settings → Appearance has a live preview: sample devices (a lamp, a room sensor, a lock, a door, a plug, a leak
  sensor), a history chart with a gap and common buttons, drawn with your theme, colour, temperature unit, card
  style, chart style, Connect readings and Cards/Table choice as you change them. It sits beside the choices on a
  wide screen and above them on a phone, and it can't be tapped.
- Tile cards for a lock or valve use the lock or valve button as their icon (the icon showed twice).

## 2026-11-22

- Phones: scrolling just past the top no longer makes the screen wiggle. The app bar shrinks when the page scrolls;
  the space it gave up made the page jump back over the line, so the bar kept growing and shrinking. The space is now
  kept, and the bar only grows back near the very top.

## 2026-11-21

- Three more card styles: **Tile** (a square; the round icon turns a light or switch on and off), **Bubble** (a pill
  that fills up to a light's brightness) and **Glance** (small and round, for a wall of readings). Pick one for the
  whole dashboard in Settings → Appearance, or give a single device its own style in its Edit dialog.
- Settings → Diagnostics also describes the dashboard as your screen shows it, to help design it: screen size,
  appearance choices, what is on each page (devices, rooms, types, card styles), custom views, the Home page setup,
  readings Haven doesn't recognise yet, and for each device its type, pages, card style and whether its card has to
  hide controls. No names or rooms are included.
- The diagnostics anonymiser replaces names as whole words only and leaves product names alone ("Home Assistant" no
  longer became "Room 36 Assistant" when a room is called Home).
- A metered socket that only reports power (each outlet of a TP-Link HS300) shows on the Power page.
- Climate leaves out water temperatures (water line monitors and valves, like leak sensors).

- No more "accesses DeviceEntry.config_entries" deprecation warning: Haven reads a device's single config entry the
  way Home Assistant 2026.10 and later expect.

## 2026-11-20

- Switches includes outlets by name or model (outlet, plug, socket, power strip), so a Hue Smart Plug that comes
  through as a light and each outlet of a power strip show up.
- A water valve or watering kit that comes through as a plain switch (named valve, watering, irrigation, sprinkler)
  counts as a valve: it goes to Water, not Switches.

- A power strip's outlets keep their full names ("Tortoise heater outlet" was cut to "rtoise heater outlet"): the
  device's name is only taken off the front at a word break, and a second outlet is labelled with its own name.

## 2026-11-19

- New **Pool** page: WaterGuru and anything with "pool" in its name (as its own word, so not Whirlpool) go there
  and nowhere else. It shows in the menu once there is something on it.
- Lights: when lights come from more than one system, tabs at the top pick All or one system (Philips Hue,
  Nanoleaf…). Group by Room or Type still works inside each tab, and the choice is remembered on each device.
- Water groups by type (leak sensors, valves, meters) by default; Room is still a tap away.
- Climate no longer shows leak sensors' temperature readings.
- Security puts every smoke and CO alarm together in one section at the top.
- The Controls page is gone. Switches now holds only smart plugs and wall switches or dimmers (named switch, dimmer
  or keypad), never bulbs or a camera's or vacuum's extra switches.
- Settings → Smart assignment follows these rules: it suggests Pool for pool devices, takes leak sensors off Climate
  and bulbs off Switches, adds light switches to Switches, and drops the removed Controls page from devices you set
  by hand. Settings → Home page lists Pool among the pages you can hide.

- Each device records the integration it comes from, which the Lights tabs use.

## 2026-11-17 (v11)

- The Home page's title, hidden tiles and hidden pages are kept across a restart (they were lost, and the next
  layout save erased them for good).
- The Power page reads each device's last value before the chart's start with an index lookup instead of scanning
  the whole history, so it stays fast with a year of history.
- Reloading Home Assistant's devices no longer disconnects every open browser (with 250+ devices the update queue
  overflowed); each device is sent once, and readings that didn't change keep their "last updated" time.
- Settings → Diagnostics: the anonymous file now also hides device friendly names in labels and in capability
  names, host names (with or without a port), compressed IPv6 and plain MAC addresses, URL paths, and device or room
  names that appear in warnings and status lines. Text readings are only kept when they are short lowercase words.
- Copy summary works on plain http (it falls back when the browser has no clipboard).
- The diagnostics file is built from a copy of the devices, so it can't hit a "changed during iteration" error.
- A default-password admin session can't read adapter status (`/api/health`) or `/metrics` until it has chosen a
  password.
- The Home tiles escape a device's own text (an alarm state sent over MQTT can no longer inject markup).
- Fits a 320 px phone: the history range buttons scroll, the Devices search box and the colour picker no longer
  push the page wider.

- Sense appliances that are off read 0 W instead of keeping their last wattage on the Power page.
- A device stays online while any of its entities is available (one unavailable sensor no longer shows the whole
  device offline).
- A device's second control of the same kind (the right-hand garage door, a second dimmer channel) can be controlled.
- A plug-type binary sensor is a reading, not a switch.
- A command sent while the link to Home Assistant drops fails with a normal error instead of silently stopping an
  automation.
- Entities removed or hidden in Home Assistant leave the card at the next read instead of staying until a restart.
- Changes that arrive while Haven is reading Home Assistant's registries are applied after the read, and reads
  happen one at a time, so an older snapshot can't overwrite a newer change.

## 2026-11-17 (v10)

- Settings → Diagnostics: the Copy summary, Report on GitHub and Download buttons wrap on a phone instead of
  running off the side of the screen.

- Sense appliances show as off, not offline, while they draw no power (Sense marks them "unavailable" then), so they no
  longer inflate the offline count.

## 2026-11-17 (v9)

- History charts draw the line straight across gaps between readings, for devices that only report now and then
  or on a change, instead of breaking it. Each reading next to a gap (or every reading, when there are only a few)
  gets a dot, so you can see where the real readings are. Settings → Appearance → *Connect readings* turns this off.

## 2026-11-17 (v8)

- Smoother with many devices: a live update now changes just that device's card straight away, and the rest of the
  page (counts, order, chips) catches up at most once a second, instead of the whole page being rebuilt for every
  update.
- The Power dashboard reads every device's history in one database query, and remembers the result briefly.
- Under the hood: the dashboard's code is split into smaller files (no change to how it works), Home Assistant
  device detection lives in one table of rules, and every page is now tested automatically in a real browser
  (desktop and phone) together with code checks on every change.

## 2026-11-17 (v7)

- Home Assistant live updates are matched to each reading by name. Before, a reading that appeared after the first
  import (a blind starting to report its position) could land on the wrong control until the next refresh.
- Fewer, smaller live updates: when a device changes many times in a burst, each screen gets its newest state once.
- Background tabs and phones with the screen off stop polling, and catch up as soon as Haven is on screen again.
- Smart assignment checks large homes faster.

## 2026-11-17 (v6)

- **Settings → Home Assistant**: a switch for every integration Haven found in Home Assistant (with how many
  devices each brings) and for each kind of data (readings, on/off sensors, lights, thermostats, blinds…). Turn one
  off and its devices leave Haven; nothing changes in Home Assistant.
- **Smoke and CO alarms are always in Security**, also when Home Assistant reports them as text ("normal" /
  "alarm"), or only their name, model or integration (X-Sense, Kidde, Nest Protect…) says what they are.
- Better automatic sorting: devices that report nothing Haven recognises get a type from their name or model
  (thermostat, lock, camera, blinds, lamp, plug, router…), and **Smart assignment** suggests each recognised type's
  page (locks and smoke alarms to Security, leak sensors to Water, thermostats to Climate, plugs to Switches…).
- **Diagnostics downloads on phones and in the Home Assistant app**: Haven makes the file and a download link that
  works for 10 minutes (shown on the page too, in case the download doesn't start). **Report on GitHub** opens a new
  issue with the summary filled in; attach the downloaded file before submitting.

## 2026-11-17 (v5)

- **Power dashboard** on the Power page: total use over time as a stacked chart of your biggest users (hover or
  touch for the moment's breakdown), using now / average / peak / energy for the range (4h, 24h, 7d, 30d, 1y),
  and a per-device table with each device's trend, now, average, peak and share of the energy. Any device that
  reports watts counts: plugs, EV chargers, UPSes and Home Assistant power sensors.
- **Thermostat controls on Home**: a card per thermostat with the current temperature, whether it's heating or
  cooling, −/+ for the setpoint(s) that apply in its mode (one target, or heat-to and cool-to in Auto), the mode
  buttons and Resume schedule. Turn it off under Settings → Home page & menu.
- **Settings → Smart assignment**: Haven suggests page and room changes (blinds and windows to Windows, appliances
  to Appliances, lamps on smart plugs to Lights, a room for devices without one, back to automatic pages when your
  manual ones match) and applies only the ones you tick.
- Moving a device to **Windows**, **Switches** or **Appliances** from its edit menu works (it was rejected).
- Blinds, shades, curtains, awnings and shutters are window coverings: they go on Windows (not Doors), never
  count as "not secure", and get their own *Blinds & shades* group.
- Custom views: **Name contains** keywords (any of them; devices added later match too), a search box to find
  devices to pick by hand with **Pick all shown**, and Windows, Switches and Appliances as types.
- Home Assistant thermostats (climate entities) can be controlled: mode, setpoints and fan. Their temperatures use
  Home Assistant's unit system, so °F homes no longer show impossible indoor readings (72 °F read as 72 °C).
  Home Assistant blinds and shades with a position get an Open % slider.

## 2026-11-17 (v4)

- New pages: **Windows** (window sensors move off Doors), **Switches** (every power switch and smart plug) and,
  in the Home Assistant edition, **Appliances** (washers, dryers, fridges, ovens, water heaters, vacuums…).
- **Search** box on every device page.
- New groups in *Group by Type*: **Cars** and **Network**. Cars show charge or fuel and range; odometer, range and
  fuel level are recognised.
- Tapping anywhere on a card opens its pop-up (not just the name). Home and Doors tiles such as "5 open" list the
  devices behind them; tap one to open it.
- Home page & menu settings save as soon as you change them (no Save needed), so they apply straight away.
- The Inside card uses thermostats and their room sensors (and anything named indoor) first, and ignores fridges,
  freezers, ovens, attics and other non-room temperatures.
- The weather card no longer mistakes the forecast for your weather station, and uses the station's outdoor
  temperature and humidity.
- Lights page: the All on / All off buttons are gone.
- Phones: "Good evening" and the date are no longer cut off by the header buttons.
- Home Assistant devices: a camera's Siren, Motion detection and other extra switches are their own controls (not
  "Power"), and turning a siren on asks first; appliance and car openings (a water heater's shutoff valve, car
  doors) are no longer treated as house doors.

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
