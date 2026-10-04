# Building the Android App

This guide gets the GBV Safety Watch app running on a physical Android phone.
It works on **Windows, macOS, or Linux**.

> **You need a real Android phone.** Bluetooth Low Energy (BLE) does not work on
> the Android emulator, and this app's whole purpose is talking to a BLE watch.

---

## Prerequisites

1. **Node.js 18+** — https://nodejs.org
2. **Java Development Kit (JDK) 17** — bundled with Android Studio, or install
   separately (Temurin/Adoptium is a good choice).
3. **Android Studio** — https://developer.android.com/studio
   During setup, let it install:
   - Android SDK
   - Android SDK Platform (API 34)
   - Android SDK Build-Tools
   - Android SDK Platform-Tools (includes `adb`)
4. A **physical Android phone** with:
   - Bluetooth enabled
   - A SIM card (required to actually send SMS alerts)

---

## One-time environment setup

### 1. Set the `ANDROID_HOME` environment variable

The SDK usually installs to:

- **Windows:** `%LOCALAPPDATA%\Android\Sdk`
- **macOS:** `~/Library/Android/sdk`
- **Linux:** `~/Android/Sdk`

Set `ANDROID_HOME` to that path and add `platform-tools` to your `PATH`.

**Windows (PowerShell, run once):**
```powershell
setx ANDROID_HOME "$env:LOCALAPPDATA\Android\Sdk"
setx PATH "$env:PATH;$env:LOCALAPPDATA\Android\Sdk\platform-tools"
```

**macOS/Linux (add to `~/.zshrc` or `~/.bashrc`):**
```bash
export ANDROID_HOME="$HOME/Library/Android/sdk"   # macOS
# export ANDROID_HOME="$HOME/Android/Sdk"         # Linux
export PATH="$PATH:$ANDROID_HOME/platform-tools"
```

Restart your terminal, then verify:
```bash
adb --version
```

### 2. Enable Developer Mode + USB debugging on the phone

1. Settings → **About phone** → tap **Build number** 7 times.
2. Settings → **Developer options** → turn on **USB debugging**.
3. Plug the phone into your computer with a USB cable.
4. Tap **Allow** on the "Allow USB debugging?" prompt on the phone.

Verify the phone is seen:
```bash
adb devices
```
You should see your device listed as `device` (not `unauthorized`).

---

## Build and run

From the project root (`GBVSafetyWatch/`):

```bash
npm install
npm run android
```

The first build downloads Gradle dependencies and can take several minutes. When
it finishes, the app installs and launches on your phone.

> **Tip:** Keep the Metro bundler running in a second terminal with `npm start`
> if `npm run android` doesn't start it automatically.

---

## Using the app

On first launch the app opens a **Bluetooth test screen**:

1. **Prepare the watch:** close/unpair the official Da Fit app so the watch's
   single BLE connection is free.
2. Tap **Scan for watch** and grant Bluetooth permission when prompted.
3. Find your watch in the list (by name, e.g. "Fit Fuel"/"GPS") and tap it.
4. Once connected, live heart rate should stream in.

> The onboarding flow and full monitoring dashboard are wired in the source but
> the default screen is the BLE test screen. See `App.tsx` to switch entry points.

---

## Runtime permissions

The app declares these in `android/app/src/main/AndroidManifest.xml`:

- `BLUETOOTH_SCAN`, `BLUETOOTH_CONNECT` (Android 12+)
- `ACCESS_FINE_LOCATION` (needed for BLE scan on older Android)
- `SEND_SMS` (alert dispatch)
- `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_HEALTH` (background monitoring)
- `POST_NOTIFICATIONS`, `WAKE_LOCK`, `RECEIVE_BOOT_COMPLETED`

Android will prompt for the dangerous ones at runtime. Grant them for full
functionality.

---

## Project layout (Android native)

```
android/
├── app/
│   ├── build.gradle
│   ├── src/main/
│   │   ├── AndroidManifest.xml
│   │   ├── java/com/gbvsafetywatch/
│   │   │   ├── MainActivity.kt
│   │   │   ├── MainApplication.kt
│   │   │   ├── MonitoringForegroundService.kt   # keeps monitoring alive
│   │   │   └── BootReceiver.kt                   # auto-resume after reboot
│   │   └── res/
│   └── debug.keystore
├── build.gradle
├── settings.gradle
└── gradle/
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `adb devices` shows `unauthorized` | Re-plug the cable and tap **Allow** on the phone. |
| `SDK location not found` | Set `ANDROID_HOME` (see above) or create `android/local.properties` with `sdk.dir=<path>`. |
| Build fails on JDK version | Ensure JDK **17** is active (`java -version`). |
| Watch not in scan list | Unpair it from the Da Fit app and from the phone's Bluetooth settings, then rescan. |
| Connects but no heart rate | Wear the watch; enable HR monitoring on the watch. |
| `npm run android` can't find device | Confirm `adb devices` lists it first. |

---

## Status / help wanted

The Android native project files were generated from the official React Native
0.73.6 template and have **not yet been verified with a full Gradle build on a
device**. If you build successfully (or hit issues), please open an issue or PR —
confirming the Android build is one of the most valuable contributions right now.
See the status table in the [root README](../README.md).
