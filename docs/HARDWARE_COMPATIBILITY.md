# Hardware Compatibility

This project talks to a Bluetooth Low Energy (BLE) smartwatch. **Compatibility
varies enormously between watches**, especially budget "fitness" watches. This
document records what we have learned so contributors and users can make informed
hardware choices.

---

## How the app adapts to different watches

On connect, `BluetoothManager` inspects the watch's GATT services and builds a
`WatchCapabilities` object:

| Capability | Detected via | Enables |
|---|---|---|
| `heartRate` | SIG Heart Rate service `0x180D` | Heart-rate monitoring & anomaly detection |
| `battery` | SIG Battery service `0x180F` | (informational) |
| `moyoungCommands` | MOYOUNG service `0xFEE0` | Watch GPS request, wrist-removal detection, watch-screen countdown, watch-button trigger |
| `onboardGps` | SIG Location & Navigation `0x1819` | On-watch GPS fix |

The app **degrades gracefully**: if a capability is missing, the related feature
is skipped and (where possible) a phone-side equivalent is used instead. A watch
with only heart rate still powers the core safety flow.

### Feature fallback matrix

| Feature | If watch supports it | If not (HR-only watch) |
|---|---|---|
| Heart-rate anomaly trigger | ✅ Uses watch HR | — (requires HR; most watches have it) |
| Location in alerts | Uses watch GPS | **Falls back to phone GPS** |
| Watch removal detection | ✅ Wrist sensor via MOYOUNG | ❌ Disabled |
| Countdown on watch screen | ✅ Display message | ❌ Shown on phone only |
| Trigger from watch button | ✅ MOYOUNG wrist event | ❌ Use phone manual trigger |
| Bluetooth-disconnection trigger | ✅ | ✅ (phone-side, always works) |
| Manual trigger from phone | ✅ | ✅ (always works) |
| SMS alert with Maps link | ✅ | ✅ (phone-side, always works) |

---

## Tested devices

### MOYOUNG / Da Fit "GPS Fit Fuel" — firmware `MOY-LXC3`

**Result: Heart-rate-only.** Verified via the [Web Bluetooth demo](../web-bluetooth-demo/).

GATT services exposed:

| Service | UUID | Notes |
|---|---|---|
| Heart Rate | `0x180D` | ✅ Characteristic `0x2A37` [notify] — **live HR confirmed working** |
| Battery | `0x180F` | ✅ `0x2A19` [read,notify], `0x2A39`, `0x2A38` [read] |
| MOYOUNG command service | `0xFEE0` | ❌ **Not present** |
| Location & Navigation | `0x1819` | ❌ **Not present** |

**Key finding:** despite "GPS" in the product name, this watch exposes **no GPS
service and no MOYOUNG command channel** over BLE. The "GPS" branding refers to
using the *phone's* GPS during workouts in the Da Fit app, not an onboard chip.

On this watch the app runs the **phone-side subset**: HR anomaly detection,
Bluetooth-disconnection trigger, phone manual trigger, phone GPS, and SMS alerts.
Watch GPS, wrist-removal, watch-screen countdown, and watch-button trigger are
unavailable.

---

## Help us expand this list

If you connect a different watch, please contribute its profile:

1. Open the [Web Bluetooth demo](../web-bluetooth-demo/) in Chrome/Edge.
2. Connect your watch, then click **Probe GPS & services**.
3. Copy the Event log (service/characteristic UUIDs and any MOYOUNG response).
4. Open a PR adding a section here, or an issue with the log pasted in.

Please include: brand, model, firmware string, and the full probe output.

---

## Buying advice (for now)

If you want the **full** feature set (watch-side GPS, removal detection, on-watch
countdown), a cheap "GPS Fit Fuel"-class watch is **not** sufficient — those are
HR-only over BLE. The core safety flow (HR anomaly + phone GPS + SMS) works on
most HR watches, but watch-independent features need hardware that exposes a real
command channel. We do not yet have a verified recommendation; community testing
will fill this in.
