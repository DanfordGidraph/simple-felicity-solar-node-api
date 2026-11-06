import axios, { AxiosError } from 'axios';
import express, { Request, Response } from 'express';

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

interface TokenCache {
    token: string;
    plantId: string | null;
    savedAt: number;
}

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = 'https://shine-api.felicitysolar.com';
const CACHE_FILE = path.join(__dirname, 'token-cache.json');


const USERNAME = process.env.FELICITY_USERNAME;
const PASSWORD = process.env.FELICITY_PASSWORD;

if (!USERNAME || !PASSWORD) {
    console.error('Missing FELICITY_USERNAME or FELICITY_PASSWORD in .env');
    process.exit(1);
}

let token: string = "";
let plantId: string = "";

interface EnergyFlowRaw {
    emsSoc?: string;
    emsVoltage?: string;
    batteryCharging?: string;
    emsPower?: string;
    pvTotalPower?: string;
    totalConsumPower?: string;
    acTotalOutActPower?: string;
    meterPower?: string;
    acTtlInPower?: string;
    acRInVolt?: string;
    plantStatus?: string;
    deviceStatus?: string;
    faultStatus?: number;
    dataTime?: number;
    plantId?: string;
    [key: string]: unknown;
}


async function ensureAuth(): Promise<string> {
    if (!token) await login();
    return token!;
}

function loadCache(): void {
    try {
        if (!fs.existsSync(CACHE_FILE)) return;
        const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as TokenCache;
        if (cached.token) {
            token = cached.token;
            plantId = cached.plantId ?? "";
            console.log('Loaded token from cache');
        }
    } catch {
        console.warn('Could not read token cache, will login');
    }
}

function saveCache(): void {
    const data: TokenCache = {
        token: token ?? '',
        plantId,
        savedAt: Date.now(),
    };
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

async function login(): Promise<string> {
    const res = await axios.post(`${BASE_URL}/userlogin`, {
        userName: USERNAME,
        password: PASSWORD,
        version: '1.0',
    });

    if (res.data?.code !== 200 || !res.data?.data?.token) {
        throw new Error(`Login failed: ${JSON.stringify(res.data)}`);
    }

    token = res.data.data.token;
    saveCache();
    return token;
}

async function fetchPlantId(): Promise<string> {
    const auth = await ensureAuth();
    const res = await axios.post(
        `${BASE_URL}/plant/list_plant`,
        { pageNum: 1, pageSize: 10 },
        { headers: { Authorization: auth, 'Content-Type': 'application/json' } }
    );

    const list = res.data?.data?.dataList;
    if (!list?.length) throw new Error('No plants returned');

    plantId = list[0].id;
    saveCache();
    return plantId!;
}

async function getEnergyFlow(retry = true): Promise<EnergyFlowRaw> {
    if (!plantId) await fetchPlantId();
    const auth = await ensureAuth();

    try {
        const res = await axios.get(
            `${BASE_URL}/device/get_energy_flow2?plantId=${plantId}`,
            { headers: { Authorization: auth } }
        );

        if (res.data?.code !== 200) {
            throw new Error(`Energy flow error: ${JSON.stringify(res.data)}`);
        }
        return res.data.data as EnergyFlowRaw;
    } catch (err) {
        const ax = err as AxiosError;
        if (retry && ax.response?.status === 401) {
            token = ""; // force re-login
            return getEnergyFlow(false);
        }
        throw err;
    }
}

function toNum(val: string | number | undefined | null): number {
    const n = Number(val);
    return Number.isFinite(n) ? n : 0;
}

function mapPlantStatus(code: string | null | undefined): string {
    const map: Record<string, string> = {
        N: 'Normal',
        F: 'Fault',
        W: 'Warning',
        O: 'Offline',
        A: 'Alarm',
    };
    if (!code) return 'Unknown';
    return map[code] ?? code;
}

function mapDeviceStatus(code: string | null | undefined): string {
    const map: Record<string, string> = {
        NM: 'Normal',
        FL: 'Fault',
        F: 'Fault',
        ST: 'Standby',
        SB: 'Standby',
        OL: 'Offline',
        AL: 'Alarm',
    };
    if (!code) return 'Unknown';
    return map[code] ?? code;
}

app.get('/status', async (_req: Request, res: Response) => {
    try {
        const raw = await getEnergyFlow();

        const batterySoc = toNum(raw.emsSoc);
        const solarW = toNum(raw.pvTotalPower);
        const gridVoltage = toNum(raw.acRInVolt);
        const batteryPowerW = toNum(raw.batteryCharging) || toNum(raw.emsPower);

        const payload = {
            batterySocPercent: batterySoc,
            batteryVoltage: toNum(raw.emsVoltage),
            batteryPowerWatts: batteryPowerW,          // negative = discharging
            isBatteryCharging: batteryPowerW > 50,     // small deadband
            solarPowerWatts: solarW,
            hasMeaningfulSolar: solarW > 100,          // tune this threshold
            loadPowerWatts: toNum(raw.totalConsumPower) || toNum(raw.acTotalOutActPower),
            gridPowerWatts: toNum(raw.meterPower) || toNum(raw.acTtlInPower),
            gridVoltage,
            utilityAvailable: gridVoltage > 180,       // typical mains present
            plantStatus: mapPlantStatus(raw.plantStatus as string | undefined),
            deviceStatus: mapDeviceStatus(raw.deviceStatus as string | undefined),
            faultStatus: raw.faultStatus ?? null,
            lastUpdateEpochMs: raw.dataTime ?? Date.now(),
            plantId: raw.plantId ?? plantId,
        };

        res.json(payload);
    } catch (err) {
        console.error(' /status failed:', err);
        res.status(502).json({ error: 'Failed to fetch solar data' });
    }
});

app.get('/health', (_req, res) => {
    res.json({ ok: true, hasToken: !!token, plantId });
});

loadCache();
app.listen(PORT, async () => {
    console.log(`Felicity solar API listening on http://localhost:${PORT}`);
    try {
        await login();
        await fetchPlantId();
        console.log(`Ready. Plant ID: ${plantId}`);
    } catch (e) {
        console.error('Startup login/plant fetch failed (will retry on first /status):', e);
    }
});