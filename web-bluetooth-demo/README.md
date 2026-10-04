# Web Bluetooth Demo

A zero-install browser demo that connects to a BLE heart-rate smartwatch and
shows **live heart rate**. This is the part of the GBV Safety Watch project that
is **proven on real hardware** — the quickest way to confirm the core sensing
works with your watch.

It also includes a **"Probe GPS & services"** button that lists every Bluetooth
service your watch exposes, which is how we map hardware compatibility (see
[../docs/HARDWARE_COMPATIBILITY.md](../docs/HARDWARE_COMPATIBILITY.md)).

---

## Requirements

- **Chrome or Edge** on **Windows, macOS, Android, or ChromeOS**.
- A computer/phone with a **Bluetooth** radio.
- A BLE smartwatch that exposes the standard Heart Rate service (`0x180D`).

> ⚠️ **Not supported in Safari or on iPhone/iPad.** The Web Bluetooth API does
> not exist in those browsers. Use Chrome/Edge elsewhere.

---

## Run it

Web Bluetooth requires a *secure context*. `localhost` counts as secure, so a
tiny local server is the easiest way:

**With Python (any OS):**
```bash
cd web-bluetooth-demo
python -m http.server 8787
```
Then open **http://localhost:8787/index.html** in Chrome or Edge.

**With Node:**
```bash
cd web-bluetooth-demo
npx http-server . -p 8787
```

> Opening `index.html` directly as a `file://` URL may block Bluetooth in some
> browsers — prefer the local server above.

---

## How to use

1. **Prepare the watch:** close/unpair the official Da Fit app so the watch's
   single BLE connection is free. If the watch is paired in your OS Bluetooth
   settings, **remove/forget it there** so the browser can connect directly.
2. Wear the watch and enable heart-rate monitoring (HR only streams while worn —
   not while on the charger).
3. Click **Connect watch** and pick your device from the chooser (all nearby BLE
   devices are shown; look for your watch's name).
4. Live BPM should appear and the sample counter should climb.
5. (Optional) Click **Probe GPS & services** to dump the watch's GATT services
   and attempt a MOYOUNG GPS request. Copy the Event log to contribute a hardware
   profile.

---

## What this demo does and does NOT do

**Does:**
- Prove the watch pairs over BLE and streams real heart rate.
- Read the standard SIG Heart Rate characteristic (`0x2A37`) — the same one the
  real app uses.
- Discover which Bluetooth services your watch exposes.

**Does not:**
- Send SMS, run in the background, detect anomalies, or do anything the real
  safety app does. It is a **connection proof**, not the product.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Chooser is empty | Forget the watch in OS Bluetooth settings; close Da Fit; keep the watch awake and close. |
| "User cancelled the requestDevice() chooser" | The popup was closed without selecting — reopen and pick the watch. |
| Connects but 0 samples | The watch only streams HR while worn — put it on. |
| Button disabled / warning banner | You're not in Chrome/Edge, or no Bluetooth radio is available. |
