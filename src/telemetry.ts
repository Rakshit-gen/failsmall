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
