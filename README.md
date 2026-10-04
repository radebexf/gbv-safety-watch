# GBV Safety Watch

> An open-source personal safety system that pairs a Bluetooth smartwatch with a
> mobile app to detect distress and alert trusted contacts — built as a
> proof of concept for the betterment and safety of people at risk of
> Gender-Based Violence (GBV).

**This is a proof of concept (POC), not a finished product.** It is shared openly
so that developers, researchers, and organisations can inspect it, build on it,
and help turn it into something that genuinely protects people. Contributions are
welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Why this exists

Gender-Based Violence is a crisis in many communities. A wearable that can
automatically call for help — even when the person cannot reach their phone —
could save lives. This project is an attempt to prototype that idea with
affordable, off-the-shelf hardware and open code, so it can be examined,
improved, and deployed by anyone who wants to help, rather than locked behind a
commercial product.

The goal is **not** profit. The goal is a transparent, auditable foundation that
others can trust, verify, and extend.

---

## What it does

When safety monitoring is active, the system:

- Continuously reads **heart rate** from a paired smartwatch.
- Detects **anomalies** (sustained spikes or drops vs. the wearer's personal
  baseline) that may indicate distress.
- Detects **unexpected Bluetooth disconnection** (watch destroyed, out of range,
  or removed from the person).
- Lets the user **manually trigger** an alert from the phone.
- Opens a **False Positive Window** (a short countdown) so the user can cancel a
  false alarm before anything is sent.
- Dispatches an **SMS alert** to pre-registered emergency contacts containing the
  user's name, the trigger reason, a UTC timestamp, and **GPS coordinates with a
  Google Maps link**.
- Stores all personal data **encrypted on-device** and provides a one-tap
  **"Delete All Personal Data"** control.

No cloud server is required — alerts are sent directly from the phone's SIM, so no
health or location data is transmitted to any third party.

---

## Project status — honest summary

| Area | Status |
|---|---|
| Core logic (anomaly detection, baseline, alert assembly, contact rules, state machine) | ✅ Implemented, **193 passing tests** incl. property-based tests |
| Live heart rate from a real watch | ✅ **Proven on hardware** via the [Web Bluetooth demo](web-bluetooth-demo/) |
| Encrypted storage, contacts, onboarding, privacy controls | ✅ Implemented (JS/TS layer) |
| iOS native build | ⚠️ Code + permissions ready; **requires a Mac + Xcode to build** (not yet run on a device) |
| Android native build | ⚠️ Project files generated; **not yet verified with a full Gradle build** |
| Watch GPS / wrist-removal / watch-screen countdown / watch-button trigger | ❌ **Not supported on the test watch** (see [Hardware Compatibility](docs/HARDWARE_COMPATIBILITY.md)) — the app falls back to phone GPS and phone trigger |
| SMS delivery on a real device | ❌ Not yet verified end-to-end |

**What is genuinely proven today:** the heart-rate sensing path works against real
hardware, and the decision logic is covered by an automated test suite. Everything
that needs a native device build (SMS, background service, on-device GPS) is
written but awaits verification by contributors with the right devices.

---

## Architecture at a glance

One **React Native (TypeScript)** codebase targets **both iOS and Android**.

```
Smartwatch (BLE)  ──►  BluetoothManager  ──►  HeartRateMonitor ──► AnomalyDetector
                                          └─►  LocationService ─────────┐
                                                                        ▼
   UI / Onboarding  ◄──►  MonitoringStateMachine (XState)  ──►  AlertPipeline ──► SMS
                                                              └─►  EncryptedStorage
```

- **No cloud backend** — SMS is sent from the device SIM.
- **XState** state machine is the single source of truth for the monitoring
  lifecycle.
- Every subsystem is dependency-injected and unit-testable without native
  modules.
---

## Try it in 2 minutes (no app build needed)

If you have a Chrome/Edge browser and a compatible BLE heart-rate watch, you can
see the core sensing work **right now**:

👉 **[Web Bluetooth demo →](web-bluetooth-demo/)**

This is the one part proven on real hardware. It reads live heart rate and can
probe your watch's Bluetooth services. (Web Bluetooth does not work in Safari or
on iPhone — use Chrome/Edge on Windows, macOS, or Android.)

---

## Build the app

You do **not** need both platforms to contribute. Pick whichever you can build.

- **Android:** [docs/BUILD_ANDROID.md](docs/BUILD_ANDROID.md) — builds on Windows,
  macOS, or Linux with Android Studio.
- **iOS:** [docs/BUILD_IOS.md](docs/BUILD_IOS.md) — requires macOS + Xcode.

### Quick start (shared JS layer)

```bash
npm install        # install dependencies
npm test           # run the full test suite (193 tests)
npm run type-check # TypeScript type check
```

---

## Hardware

Tested with a **MOYOUNG / Da Fit "GPS Fit Fuel"** watch (firmware `MOY-LXC3`).
Compatibility varies a lot between budget watches — read
[docs/HARDWARE_COMPATIBILITY.md](docs/HARDWARE_COMPATIBILITY.md) before buying a
device, because many "GPS" watches do **not** expose GPS or custom features over
Bluetooth.

---

## How you can help

This project needs people. Specifically:

- **Mobile devs** to verify and polish the iOS/Android builds and the SMS /
  background-service paths on real devices.
- **BLE / firmware people** to map more watch models and protocols.
- **Security & privacy reviewers** to audit the encrypted-storage and data-handling code.
- **GBV support organisations** to advise on real-world needs, safety, and ethics.
- **Translators & designers** for accessible, multi-language onboarding.

See [CONTRIBUTING.md](CONTRIBUTING.md) to get started.

---

## Safety, ethics, and limitations

This is prototype software. **Do not rely on it as your only safety measure.** It
has not been through security auditing, real-world field testing, or
certification. SMS delivery, background reliability, and alert timing are not yet
guaranteed. Please read [docs/HARDWARE_COMPATIBILITY.md](docs/HARDWARE_COMPATIBILITY.md)
and the status table above, and treat any deployment as experimental until the
community has validated it.

---

## License

[MIT](LICENSE) — free to use, modify, and distribute, including commercially.
The intent is maximum reuse for the public good.
