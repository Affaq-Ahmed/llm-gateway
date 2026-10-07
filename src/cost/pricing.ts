import table from "./prices.json";

export type PriceEntry = {
  readonly effectiveFrom: string;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
};

const prices = table as Readonly<Record<string, readonly PriceEntry[]>>;

export function rateFor(model: string, at: Date): PriceEntry {
  const atMs = at.getTime();
  if (!Number.isFinite(atMs)) throw new Error(`Invalid pricing date: ${String(at)}`);

  const key = canonicalModel(model);
  const entries = prices[key];
  if (entries === undefined) throw new Error(`No pricing configured for model=${model}`);

  let selected: PriceEntry | undefined;
  for (const entry of entries) {
    const effectiveMs = Date.parse(entry.effectiveFrom);
    if (!Number.isFinite(effectiveMs)) {
      throw new Error(`Invalid effectiveFrom for model=${key}`);
    }
    if (effectiveMs <= atMs) selected = entry;
  }
  if (selected === undefined) {
    throw new Error(`No pricing configured for model=${model} at ${at.toISOString()}`);
  }
  return selected;
}

function canonicalModel(model: string): string {
  const afterProvider = model.includes(":") ? model.slice(model.indexOf(":") + 1) : model;
  const exact = afterProvider.replaceAll(".", "-");
  if (prices[exact] !== undefined) return exact;
  const afterVendor = exact.includes("/") ? exact.slice(exact.indexOf("/") + 1) : exact;
  return afterVendor;
}
