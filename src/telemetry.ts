import { COLO, hash32 } from "./fleet";

// Simulated edge telemetry. In production this would be a query against
// Workers Analytics Engine for the same window; here each colo's
// requests, errors and p95 for a minute are drawn from a hash of the colo
// and the minute, plus any injected faults. The same window always gives
// the same numbers, so tests and replays agree.

export interface Fault {
  key: string;
  version: string | null;
  region: string | null;
  error_rate: number;
  latency_ms: number;
  created_at: number;
  cleared_at: number | null;
}

export interface Totals {
  requests: number;
  errors: number;
  // Request-weighted mean of each colo-minute's p95.
  p95: number;
  minutes: number;
}

export const REQUESTS_PER_WEIGHT_MINUTE = 1000;

const unit = (s: string) => (hash32(s) + 0.5) / 2 ** 32;
function gauss(s: string): number {
  return Math.sqrt(-2 * Math.log(unit(`${s}:a`))) * Math.cos(2 * Math.PI * unit(`${s}:b`));
}

// Minutes are simulated minutes: with TIME_SCALE 60 a simulated minute is one real second.
export function minuteRange(fromMs: number, toMs: number, scale: number): [number, number] {
  return [Math.floor((fromMs * scale) / 60_000), Math.floor((toMs * scale) / 60_000)];
}

export function coloMinute(code: string, version: string, minute: number, scale: number, key: string, faults: Fault[]) {
  const colo = COLO.get(code)!;
  const at = (minute * 60_000) / scale;
  let errorRate = colo.baseErrorRate;
  let latency = 0;
  for (const f of faults) {
    if (f.key !== key || at < f.created_at || (f.cleared_at !== null && at >= f.cleared_at)) continue;
    if (f.version !== null && f.version !== version) continue;
    if (f.region !== null && f.region !== colo.region) continue;
    errorRate += f.error_rate;
    latency += f.latency_ms;
  }
  const seed = `${code}:${minute}`;
  const requests = Math.max(0, Math.round(colo.weight * REQUESTS_PER_WEIGHT_MINUTE * (1 + 0.08 * gauss(`${seed}:r`))));
  const mean = requests * Math.min(1, errorRate);
  const errors = Math.min(requests, Math.max(0, Math.round(mean + Math.sqrt(mean) * gauss(`${seed}:e`))));
  const p95 = colo.baseP95 + latency + 2.5 * gauss(`${seed}:l`);
  return { requests, errors, p95 };
}

// Totals over colos for a window, each colo on the version given for it.
export function windowTotals(
  colos: { code: string; version: string }[],
  fromMs: number,
  toMs: number,
  scale: number,
  key: string,
  faults: Fault[],
): Totals {
  const [first, end] = minuteRange(fromMs, toMs, scale);
  let requests = 0, errors = 0, latencySum = 0;
  for (const { code, version } of colos) {
    for (let m = first; m < end; m++) {
      const s = coloMinute(code, version, m, scale, key, faults);
      requests += s.requests;
      errors += s.errors;
      latencySum += s.p95 * s.requests;
    }
  }
  return { requests, errors, p95: requests ? latencySum / requests : 0, minutes: Math.max(0, end - first) };
}

export async function loadFaults(db: D1Database, key: string): Promise<Fault[]> {
  const r = await db.prepare("SELECT key, version, region, error_rate, latency_ms, created_at, cleared_at FROM faults WHERE key = ?").bind(key).all<Fault>();
  return r.results;
}
