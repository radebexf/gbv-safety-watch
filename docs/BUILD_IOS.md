# Building the iOS App

This guide gets the GBV Safety Watch app running on a physical iPhone.

> **A Mac is required.** iOS apps can only be compiled and signed on macOS with
> Xcode. There is no way around this — it is an Apple platform requirement. You
> cannot build the iOS app from Windows or Linux.
>
> **A physical iPhone is required.** Bluetooth Low Energy (BLE) does not work in
> the iOS Simulator, and this app's purpose is talking to a BLE watch.

---

## Prerequisites

1. A **Mac** running a recent macOS.
2. **Xcode** (from the Mac App Store). Open it once to install components.
3. **Xcode Command Line Tools:**
   ```bash
   xcode-select --install
   ```
4. **Node.js 18+** — https://nodejs.org
5. **CocoaPods:**
   ```bash
   sudo gem install cocoapods
   ```
6. A **physical iPhone** with a SIM card (required to send SMS alerts).
7. An **Apple ID** (a free one works for development/testing on your own device).

---

## Build and run

From the project root (`GBVSafetyWatch/`):

```bash
# 1. Install JS dependencies
npm install

# 2. Install native iOS pods (links react-native-ble-plx etc.)
cd ios
pod install
cd ..

# 3. Build & run on a connected iPhone
npm run ios --device
```

Or build from Xcode directly (recommended the first time, for signing):

1. Open `ios/GBVSafetyWatch.xcworkspace` in Xcode (**the `.xcworkspace`, not the
   `.xcodeproj`**).
2. Select your iPhone as the run target (top bar).
3. In **Signing & Capabilities**, choose your Apple ID team and let Xcode manage
   signing. You may need to set a unique bundle identifier.
4. Press **Run** (▶).

---

## First launch on the iPhone

With a free Apple ID, iOS does not trust the app automatically:

1. On the iPhone: **Settings → General → VPN & Device Management**.
2. Tap your Apple ID under "Developer App" and tap **Trust**.
3. Reopen the app.

---

## Using the app

The default screen is a **Bluetooth test screen**:

1. **Prepare the watch:** close/unpair the official Da Fit app so the watch's
   single BLE connection is free.
2. Tap **Scan for watch** and allow Bluetooth when iOS prompts.
3. Find your watch by name (e.g. "Fit Fuel"/"GPS") and tap it.
4. Live heart rate should stream in once connected.

> **Note on identifiers:** iOS hides the Bluetooth MAC address. CoreBluetooth
> assigns each device an opaque UUID, so you identify the watch by its advertised
> **name**, not its MAC.

---

## Permissions & background modes

Already configured in `ios/GBVSafetyWatch/Info.plist`:

- `NSBluetoothAlwaysUsageDescription` / `NSBluetoothPeripheralUsageDescription`
- `NSLocationAlwaysAndWhenInUseUsageDescription` (and related)
- `UIBackgroundModes`: `bluetooth-central`, `location`

iOS shows the permission prompts on first use, using the text from `Info.plist`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `pod install` fails | Run `sudo gem install cocoapods`; on Apple Silicon you may need `arch -x86_64 pod install` for some pods. |
| "Untrusted Developer" on launch | Trust the app under Settings → General → VPN & Device Management. |
| App won't install / signing error | Set a unique bundle ID and select your team in Xcode → Signing & Capabilities. |
| BLE scan finds nothing | Unpair the watch from Da Fit and from iOS Settings → Bluetooth, then rescan. |
| Connects but no heart rate | Wear the watch; enable HR monitoring on the watch. |
| Build errors after `npm install` | Re-run `cd ios && pod install` to relink native modules. |

---

## Status / help wanted

The iOS `Info.plist` and permissions are configured, but the app has **not yet
been built and run on a physical iPhone** (the primary author only has access to
a Windows PC). Verifying the iOS build, `pod install`, signing, and the BLE +
SMS paths on a real iPhone is a high-value contribution. Please open an issue or
PR with your results. See the status table in the [root README](../README.md).
