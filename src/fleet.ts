// The simulated fleet: data centers ("colos") by airport code, with a
// traffic weight and the error rate and p95 latency they show on a
// healthy config.

export interface Colo {
  code: string;
  region: Region;
  weight: number;
  baseErrorRate: number;
  baseP95: number;
}

export const REGIONS = ["apac", "europe", "namerica", "samerica", "mea"] as const;
export type Region = (typeof REGIONS)[number];

const c = (code: string, region: Region, weight: number, baseErrorRate: number, baseP95: number): Colo => ({ code, region, weight, baseErrorRate, baseP95 });

export const COLOS: Colo[] = [
  c("SIN", "apac", 9, 0.0018, 62), c("BOM", "apac", 7, 0.0024, 71), c("NRT", "apac", 8, 0.0015, 55),
  c("SYD", "apac", 5, 0.0017, 66), c("HKG", "apac", 6, 0.0019, 58), c("DEL", "apac", 4, 0.0026, 78),
  c("FRA", "europe", 10, 0.0012, 41), c("LHR", "europe", 11, 0.0013, 43), c("AMS", "europe", 8, 0.0012, 40),
  c("CDG", "europe", 7, 0.0014, 44), c("MAD", "europe", 3, 0.0016, 49), c("WAW", "europe", 2, 0.0017, 52),
  c("IAD", "namerica", 12, 0.0011, 38), c("ORD", "namerica", 9, 0.0012, 40), c("LAX", "namerica", 10, 0.0013, 42),
  c("DFW", "namerica", 7, 0.0012, 41), c("SEA", "namerica", 4, 0.0014, 45), c("YYZ", "namerica", 3, 0.0015, 47),
  c("GRU", "samerica", 5, 0.0022, 69), c("SCL", "samerica", 2, 0.0025, 74), c("BOG", "samerica", 2, 0.0027, 77),
  c("JNB", "mea", 2, 0.0028, 85), c("DXB", "mea", 3, 0.0021, 64), c("CAI", "mea", 1, 0.003, 92),
];

export const COLO = new Map(COLOS.map((x) => [x.code, x]));
export const TOTAL_WEIGHT = COLOS.reduce((a, x) => a + x.weight, 0);

// FNV-1a, 32 bit. Stable across runtimes, which is all it needs to be.
export function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The order a rollout reaches colos in. Each rollout gets its own order, so
// the same colo isn't always the canary, but a rollout's order never
// changes, so every stage is a superset of the one before.
export function rolloutOrder(rolloutId: string): Colo[] {
  return [...COLOS].sort((a, b) => hash32(`${rolloutId}:${a.code}`) - hash32(`${rolloutId}:${b.code}`));
}

// Colos for a stage: the canary stage (percent 0) is one colo; any other
// stage takes colos in rollout order until they carry `percent` of traffic.
export function coloSet(rolloutId: string, percent: number): string[] {
  const order = rolloutOrder(rolloutId);
  if (percent <= 0) return [order[0].code];
  const out: string[] = [];
  let share = 0;
  for (const x of order) {
    if (share >= percent / 100) break;
    out.push(x.code);
    share += x.weight / TOTAL_WEIGHT;
  }
  return out;
}

export function trafficShare(codes: string[]): number {
  return codes.reduce((a, code) => a + (COLO.get(code)?.weight ?? 0), 0) / TOTAL_WEIGHT;
}
