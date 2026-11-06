# Felicity Solar Status API

Internal, single-file TypeScript + Express wrapper around the Felicity Solar SHINE cloud API (`shine-api.felicitysolar.com`).

Built so a microcontroller (or any device on your LAN) can poll a small, stable JSON payload and drive **generator auto-start / shutoff** for a Felicity IVEM12048 — something the inverter does not expose at the granularity you need.

The API logs in once, caches the Bearer token on disk, refreshes only on 401, and exposes only the fields that matter for genset logic.

---

## What it does

Shine requires three calls (login → list plants → energy flow). This service does that for you and returns one payload:

| You care about                         | Source field                              | Exposed as                        |
| -------------------------------------- | ----------------------------------------- | --------------------------------- |
| Battery SOC                            | `emsSoc`                                  | `batterySocPercent`               |
| Battery voltage                        | `emsVoltage`                              | `batteryVoltage`                  |
| Battery power (+ charge / − discharge) | `batteryCharging` / `emsPower`            | `batteryPowerWatts`               |
| Solar production                       | `pvTotalPower`                            | `solarPowerWatts`                 |
| Load                                   | `totalConsumPower` / `acTotalOutActPower` | `loadPowerWatts`                  |
| Grid present?                          | `acRInVolt`                               | `utilityAvailable`, `gridVoltage` |
| Plant / inverter health                | `plantStatus`, `deviceStatus`             | full words (`Normal`, `Fault`, …) |

Typical genset rule on the MCU:

```
START  if  SOC < 30%  AND  utility is down  AND  little/no solar
STOP   if  SOC recovered  OR  utility returned  OR  solar is back
```

Night can be treated as “no solar” via a time-of-day check on the microcontroller if you prefer that over the watt threshold.

---

## Features

- One file: `server.ts`
- No auth on _this_ API (intended for a private network)
- Token + plant ID persisted to `token-cache.json` so restarts do not re-login
- Automatic re-login on HTTP 401
- Status codes mapped to readable words (`N` → `Normal`, `NM` → `Normal`)
- Yarn + `node-modules` linker (PnP-friendly editor issues avoided)
- `tsx` for development, `tsc` for a production build

---

## Requirements

- Node.js 18+
- Yarn 3/4 (or Yarn Classic)
- A Felicity Shine account that can see the plant

---

## Project layout

```
felicity-api/
├── server.ts              # the entire API
├── tsconfig.json
├── package.json
├── .yarnrc.yml            # nodeLinker: node-modules
├── .env                   # credentials (never commit)
├── .gitignore
├── token-cache.json       # created at runtime (never commit)
└── dist/                  # production build output
```

---

## Setup

```bash
mkdir felicity-api && cd felicity-api
yarn init -y
```

`.yarnrc.yml`:

```yaml
nodeLinker: node-modules
```

```bash
yarn add express axios dotenv
yarn add -D typescript @types/express @types/node tsx
```

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["server.ts"]
}
```

### `package.json` scripts

```json
{
  "scripts": {
    "dev": "tsx server.ts",
    "build": "tsc",
    "start": "node dist/server.js"
  }
}
```

### `.env`

```
PORT=3000
FELICITY_USERNAME=you@example.com
FELICITY_PASSWORD=your_shine_password
```

Use whatever the Shine login actually expects (plaintext or pre-hashed). If login fails, this is the first thing to check.

### `.gitignore`

```
node_modules
dist
.env
token-cache.json
```

Copy `server.ts` into the project root (the file from this repo / conversation).

---

## Run

**Development** (TypeScript, no compile step):

```bash
yarn dev
```

**Production:**

```bash
yarn build
yarn start
```

On first start the API logs in, fetches the first plant, and writes `token-cache.json`. Later starts reuse that cache.

Smoke test:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/status
```

Bind it to a LAN IP (or put it behind your existing node) so the microcontroller can reach it. Do not expose it to the public internet.

---

## API

Base URL: `http://<host>:3000`

### `GET /health`

Liveness + whether a token/plant are already in memory.

```json
{
  "ok": true,
  "hasToken": true,
  "plantId": "1554671272911106049"
}
```

### `GET /status`

Live plant snapshot. Poll every 30–60 seconds from the MCU.

```json
{
  "batterySocPercent": 68,
  "batteryVoltage": 52,
  "batteryPowerWatts": -2670,
  "isBatteryCharging": false,
  "solarPowerWatts": 0,
  "hasMeaningfulSolar": false,
  "loadPowerWatts": 2452,
  "gridPowerWatts": 0,
  "gridVoltage": 247.7,
  "utilityAvailable": true,
  "plantStatus": "Normal",
  "deviceStatus": "Normal",
  "faultStatus": 1,
  "lastUpdateEpochMs": 1793969700000,
  "plantId": "1554671272911106049"
}
```

| Field                | Type           | Notes                                                         |
| -------------------- | -------------- | ------------------------------------------------------------- |
| `batterySocPercent`  | number         | 0–100                                                         |
| `batteryVoltage`     | number         | EMS voltage (V)                                               |
| `batteryPowerWatts`  | number         | **Negative = discharging**                                    |
| `isBatteryCharging`  | boolean        | `batteryPowerWatts > 50` (deadband)                           |
| `solarPowerWatts`    | number         | PV total (W)                                                  |
| `hasMeaningfulSolar` | boolean        | `solarPowerWatts > 100` — tune this                           |
| `loadPowerWatts`     | number         | House/inverter load                                           |
| `gridPowerWatts`     | number         | Meter / AC-in power                                           |
| `gridVoltage`        | number         | L1 AC input (V)                                               |
| `utilityAvailable`   | boolean        | `gridVoltage > 180` — tune this                               |
| `plantStatus`        | string         | `Normal`, `Fault`, `Warning`, `Offline`, `Alarm`, or raw code |
| `deviceStatus`       | string         | `Normal`, `Fault`, `Standby`, `Offline`, `Alarm`, or raw code |
| `faultStatus`        | number \| null | Shine flag/count — **do not assume `1` means healthy**        |
| `lastUpdateEpochMs`  | number         | Timestamp from Shine (ms)                                     |
| `plantId`            | string         | First plant on the account                                    |

On Shine failure: `502` with `{ "error": "Failed to fetch solar data" }`.

---

## Suggested generator logic

Do **not** key start/stop off `plantStatus` / `deviceStatus`. Use them as a safety interlock only (e.g. skip start if the inverter is Offline or Fault).

```
shouldStart =
  batterySocPercent < 30
  AND utilityAvailable === false
  AND hasMeaningfulSolar === false
  AND deviceStatus !== "Fault"
  AND deviceStatus !== "Offline"

shouldStop =
  batterySocPercent >= 50          // hysteresis — pick your recover SOC
  OR utilityAvailable === true
  OR hasMeaningfulSolar === true
```

Add hysteresis so the genset does not chatter around the 30% line. Time-of-day (dusk–dawn) is a valid extra “no solar” condition on the MCU.

Tune on site:

- `hasMeaningfulSolar` — 100 W default; raise if you get false positives at dawn
- `utilityAvailable` — 180 V default; match your mains / brownout reality
- `isBatteryCharging` deadband — 50 W default

---

## Token cache

File: `token-cache.json` in the process working directory (`process.cwd()`).

```json
{
  "token": "Bearer_eyJhbGciOiJIUzI1NiJ9...",
  "plantId": "1554671272911106049",
  "savedAt": 1710000000000
}
```

- Written after a successful login and after plant ID is known
- File mode `0600` on Unix
- On 401 the in-memory token is cleared, login runs once, cache is overwritten
- Delete the file to force a fresh login

This avoids login-rate flags from restarting the Node process.

---

## Status code mapping

Shine returns short codes. The API expands the known ones and **passes unknown codes through unchanged**.

| Plant (`plantStatus`) | Device (`deviceStatus`) |
| --------------------- | ----------------------- |
| `N` Normal            | `NM` Normal             |
| `F` Fault             | `FL` / `F` Fault        |
| `W` Warning           | `ST` / `SB` Standby     |
| `O` Offline           | `OL` Offline            |
| `A` Alarm             | `AL` Alarm              |

These mappings are inferred from typical Shine / Felicity values, not an official spec. If you see a new code in the wild, add it to `mapPlantStatus` / `mapDeviceStatus` in `server.ts`.

---

## Troubleshooting

| Symptom                                   | Likely cause                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cannot find module 'express'`            | PnP still on — confirm `.yarnrc.yml` has `nodeLinker: node-modules`, then `yarn install` and restart the TS server        |
| Login error / 401 from Shine              | Wrong password format in `.env`, or account lock                                                                          |
| `502` on `/status`                        | Shine down, bad token, or no plants on the account                                                                        |
| `utilityAvailable: true` during an outage | Voltage threshold too low, or `acRInVolt` is not the grid feed on your wiring — inspect a live `/status` during an outage |
| Token login flagged                       | Cache file missing or not writable; confirm `token-cache.json` is created and reused                                      |
| Editor import errors after install        | Command palette → **TypeScript: Restart TS Server**                                                                       |

Run only via Yarn (`yarn dev` / `yarn start`). `npx ts-node` bypasses the workspace and will fail under PnP if you ever re-enable it.

---

## Security

- This API has **no authentication**. Run it only on a trusted LAN / localhost.
- `.env` and `token-cache.json` contain live credentials. Keep them out of git and off shared disks.
- Do not publish port 3000 past your firewall.
- The Shine password is sent to Felicity on login the same way the official app/collection does.

---

## License

Private / internal use. Not affiliated with Felicity Solar.
