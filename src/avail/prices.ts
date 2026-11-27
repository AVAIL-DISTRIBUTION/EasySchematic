/**
 * Prices are not stored in the repository (it is public) nor loaded from it into the database:
 * no unitCost / MSRP / price fields in library/catalog and library/avail. avail:check-library
 * fails on such a field, import:catalog drops it, clear:catalog-prices empties the prices the
 * catalog loaded before.
 */

/** Template columns that hold a price (api/src/db.ts). */
export const PRICE_TEMPLATE_FIELDS = ["unitCost"] as const;

/** A key that names a price: unitCost, msrp, price, listPrice, dealer_cost, "MSRP (USD)"… */
export function isPriceKey(key: string): boolean {
  const k = key.replace(/\s*\(.*\)\s*$/, "").replace(/[\s_-]+/g, "").toLowerCase();
  return /^(msrp|rrp|price|prices|cost|costs)$/.test(k) || /(price|prices|cost|msrp)$/.test(k);
}

/** Paths of every price field in a JSON value ("unitCost", "_avail.msrp", "ports[2].price"). */
export function priceFields(value: unknown, at = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => priceFields(v, `${at}[${i}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => {
    const path = at ? `${at}.${k}` : k;
    return [...(isPriceKey(k) ? [path] : []), ...priceFields(v, path)];
  });
}

/** The value without its price fields (top level and nested). */
export function withoutPrices<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => withoutPrices(v)) as T;
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (!isPriceKey(k)) out[k] = withoutPrices(v);
  return out as T;
}
