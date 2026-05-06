# React Native app — plan

The phone app that replaces the dead vendor app. Talks to the kettle over the
LAN directly using the same Across protocol as the Node server in this repo.
Does **not** depend on the (eventual) Pi — works on the home Wi-Fi standalone.

Android first; iOS deferred until V1 is solid.

## Architecture

The RN app reuses the existing protocol layer:

```
appkettle-app (new repo)
├── src/
│   ├── protocol/         ← copy of src/protocol/ from this repo (pure TS, no Node)
│   ├── kettle/
│   │   ├── client.ts     ← port of client.ts, swap node:net for react-native-tcp-socket
│   │   └── discovery.ts  ← port of discovery.ts, swap node:dgram for react-native-udp
│   ├── hooks/
│   │   └── useKettle.ts  ← single hook owning connection state
│   ├── components/
│   ├── screens/
│   │   └── MainScreen.tsx
│   └── App.tsx
├── android/
└── package.json
```

The `protocol/` files are pure functions over strings/buffers — they copy across
with **zero changes**. The `client.ts` port is mechanical: replace 4 imports.

## Decision: how to share `protocol/`

Three options, in order of recommendation:

1. **Hand-copy initially.** ~250 LOC, doesn't change often, two repos. Re-evaluate
   if the protocol shifts.
2. **Publish `@michaelhutchinson/appkettle-protocol` to npm.** Cleaner, but adds
   release overhead. Worth it if a third consumer ever shows up.
3. **Monorepo with workspaces.** Restructure the existing repo. Probably premature.

Start with #1.

## Dependencies

```
react-native
react-native-tcp-socket                       # TCP, the critical piece
react-native-udp                              # UDP discovery broadcasts
@react-native-async-storage/async-storage     # persist kettle IP/IMEI between launches
```

No state library, no UI framework for V1. RN built-ins are enough — adding
Tamagui/Paper later is trivial if it grows.

## MVP (V1)

One screen, three buttons:

- **Status card** — current temp, state, volume, last-updated timestamp.
  Auto-refreshes from the heartbeat stream.
- **Boil button** — defaults to 100°C, long-press for a temp picker. Dispatches
  `kettle_boil`.
- **Stop button** — dispatches `kettle_stop`.

### Lifecycle

- On app foreground → discover (or use cached IP/IMEI from AsyncStorage) →
  connect.
- On app background → close TCP socket. (Android can sometimes keep it alive,
  but don't fight the OS for V1.)
- On status update → re-render.

That's it. Ship that, then add.

## Explicitly NOT in V1

- Pairing flow (`SET_UPPER_WIFI`). Pair via the existing CLI for now; the app
  just speaks to an already-paired kettle.
- Background notifications (kettle ready alerts). Adds Android foreground
  services — complex.
- Multiple kettles. There's one.
- iOS. Sideload pain deferred until V1 is solid on Android.

## Sideload pipeline (Android)

1. `npx @react-native-community/cli init appkettle-app`
2. Generate a release signing key (one-time): `keytool -genkeypair ...`
3. Build APK: `cd android && ./gradlew assembleRelease`
4. Transfer to phone (USB / Drive / Signal / whatever)
5. Install (Android prompts to allow "install from this source" once)

For dev iteration: `npx react-native run-android` with the phone plugged in via
USB and developer mode on. Hot reload for free.

## Decisions to confirm before coding

- **Repo name** — `appkettle-app` or something else?
- **Public or private GitHub?** Same call as the main repo for now.
- **MIT license again?** Probably yes.
- **Manual config or auto-discover on first launch?** Auto-discover is the
  better UX but uses UDP broadcasts which require Wi-Fi; falls back to "enter
  IP manually" if no kettle found in 8s.
- **Theme** — dark / light / system? Steal-the-system-default is the right
  default, but worth confirming.

## Implementation order (eventual session)

1. RN init, get a hello-world running on the Android device
2. Copy `protocol/` over, port `client.ts` (use the loopback test pattern from
   `src/client.integration.test.ts` in this repo)
3. Build `useKettle` hook with the foreground/background lifecycle
4. Status card + boil/stop buttons
5. AsyncStorage for persisted IP/IMEI
6. Cut a release APK, install on the phone
7. Use it for a few days, see what's missing, iterate

Each step is small enough to live-test on the phone before moving on.

## Context the next session will need

- This repo (`appkettle`) has the working Node implementation; the RN app
  ports the protocol + client layers across.
- The kettle's IMEI is `GD0-12900-7a00`, IP is `192.168.1.202` (or whatever
  DHCP has assigned by then — discovery is reliable).
- iOS path (when picked up later): probably $99/year Apple Developer + ad-hoc
  distribution to the girlfriend's iPhone.
