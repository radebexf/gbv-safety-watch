# Contributing to GBV Safety Watch

Thank you for wanting to help. This is a non-commercial, open proof of concept
aimed at protecting people at risk of Gender-Based Violence. Every contribution —
code, testing, docs, hardware profiles, or domain advice — moves it forward.

---

## Ways to contribute

### 1. Verify the builds on real devices (highest priority)
The core logic is tested, but the native app builds have not been fully verified
on devices. If you have the hardware:

- **Android:** follow [docs/BUILD_ANDROID.md](docs/BUILD_ANDROID.md), build to a
  phone, and report what worked / broke.
- **iOS:** follow [docs/BUILD_IOS.md](docs/BUILD_IOS.md) on a Mac, build to an
  iPhone, and report results.
- Verify the **SMS alert** path and **background monitoring** actually work.

### 2. Add watch hardware profiles
Use the [Web Bluetooth demo](web-bluetooth-demo/)'s **Probe** button and submit
your watch's service list to [docs/HARDWARE_COMPATIBILITY.md](docs/HARDWARE_COMPATIBILITY.md).

### 3. Improve the code
- Wire the onboarding flow and monitoring dashboard into `App.tsx`.
- Harden the BLE reconnection and foreground-service reliability.
- Expand test coverage.

### 4. Non-code help
Security/privacy auditing, GBV domain expertise, accessibility, translations,
and design are all genuinely needed.

---

## Development setup

```bash
npm install        # install dependencies
npm test           # run the full test suite
npm run type-check # TypeScript type check
npm run lint       # lint
```

- Language: **TypeScript** (React Native).
- Tests: **Jest** + **fast-check** (property-based testing). Run with
  `npm test` (uses `--runInBand` for determinism).
- Keep subsystems **dependency-injected** so they stay testable without native
  modules.

---

## Pull request guidelines

1. Fork the repo and create a branch from `main` (e.g. `feature/android-verify`).
2. Keep changes focused; one logical change per PR.
3. **Add or update tests** for any logic change. All tests must pass:
   ```bash
   npm test && npm run type-check
   ```
4. Match the existing code style (run `npm run lint`).
5. Update docs when behaviour changes (README, build guides, hardware notes).
6. Describe **what** you changed, **why**, and **how you tested it** (including
   device/OS if you verified on hardware).

---

## Correctness properties

The project uses property-based testing to encode safety-critical invariants
(see the "Correctness Properties" section of
[`.kiro/specs/gbv-safety-watch/design.md`](../.kiro/specs/gbv-safety-watch/design.md)).
If you touch anomaly detection, baseline computation, alert assembly, contact
rules, or data deletion, keep the corresponding property tests green and add new
ones for new invariants.

---

## Code of conduct

Be respectful and constructive. This project deals with a sensitive, serious
subject. Assume good faith, center the safety of the people this tool is meant to
protect, and keep discussions professional.

---

## Reporting security or privacy issues

Because this software handles health and location data, please report security or
privacy concerns responsibly. Open an issue describing the class of problem
(without publishing exploit detail for anything sensitive), or contact the
maintainers directly if a private channel is available.
