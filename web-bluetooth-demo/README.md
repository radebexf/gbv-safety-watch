# Web Demos

Browser demos for the GBV Safety Watch POC — no app install needed. Hosted live on
GitHub Pages, or run locally (see below).

**Live:** https://radebexf.github.io/gbv-safety-watch/

| Page | File | Works on |
|---|---|---|
| Heart rate & watch probe | `index.html` | Chrome / Edge (Web Bluetooth) — **not** Safari/iPhone |
| SMS alert + panic trigger + simulation | `sms-test.html` | Any browser, including iPhone |
| Alert receiver dashboard | `receiver.html` | Any browser; cross-device via demo relay |

---

## 1. Heart rate & watch probe (`index.html`)

The part **proven on real hardware**. Connects to a BLE heart-rate watch and
streams live BPM.

- **Connect watch** — scan + connect, then see live heart rate.
- **Probe GPS & services** — lists every GATT service/characteristic the watch
  exposes and attempts a MOYOUNG GPS request. Use this to add your watch to
  [../docs/HARDWARE_COMPATIBILITY.md](../docs/HARDWARE_COMPATIBILITY.md).
- **Sniff button presses** — subscribes to all notify characteristics so you can
  check whether the watch reports button presses over BLE.

> Requires **Chrome or Edge** on Windows/macOS/Android. Not available in Safari
> or on iPhone/iPad (no Web Bluetooth API).

---

## 2. SMS alert + panic trigger (`sms-test.html`)

Builds the exact alert message the real app sends and lets you send a real SMS.

- Enter your name + an emergency contact number.
- **Use my live GPS** — captures real coordinates (needs HTTPS, so use the live
  URL or a local server, not a `file://` open).
- **Build alert message** — renders the message (identical to the app's template).
- **Open Messaging app to send** — opens your phone's SMS app pre-filled; you tap
  send. (Browsers cannot send SMS silently — see the platform note in the
  [root README](../README.md).)
- **Triple-tap panic circle** — tap 3× within 2 s to fire a manual alert fast.
- **Simulate a trigger** — buttons for heart-rate anomaly, watch removal, and
  Bluetooth loss, each running the **False Positive Window countdown** first so
  you can demo cancelling a false alarm.

Every triggered alert is also broadcast to the receiver (below).

---

## 3. Alert receiver dashboard (`receiver.html`)

A contact/responder view that lights up when an alert fires — showing the person,
trigger, UTC time, and an embedded map pin.

- **Same browser:** open it in another tab; alerts appear instantly.
- **Cross-device:** open it on another device (e.g. your laptop) while triggering
  from your phone. Uses a free public MQTT relay. The top-right **`relay:`**
  indicator shows the connection state (`live ✓` when connected).

> ⚠️ The cross-device relay is **demo only** — public broker, unencrypted,
> guessable topic. Never send real personal data through it. The production app
> uses direct SMS with no relay.

---

## Run locally

Web Bluetooth and geolocation need a secure context; `localhost` qualifies.

**Python:**
```bash
cd web-bluetooth-demo
python -m http.server 8787
```
Open http://localhost:8787/index.html

**Node:**
```bash
cd web-bluetooth-demo
npx http-server . -p 8787
```

> To reach the pages from a phone on the same Wi-Fi, use the laptop's LAN IP
> (e.g. `http://192.168.1.16:8787/...`). Some public/hotel Wi-Fi networks block
> device-to-device traffic ("client isolation") — if the page won't load, use the
> GitHub Pages URL instead.

---

## What these demos prove — and don't

**Prove:** BLE heart-rate streaming on real hardware, the exact alert message
format, live GPS capture, the trigger/cancel flow, and a real SMS reaching a
contact.

**Don't cover:** automatic/background SMS (Android native only), real sensor-driven
triggers, and on-device encrypted storage — those live in the native app.
