export interface QuoteResult {
  ok: boolean;
  error?: string;
  total?: number;
  policy?: string;
  line?: string;
}

export function quoteBooking(raw: unknown): QuoteResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "malformed request" };
  }
  const req = raw as Record<string, unknown>;
  if (!Number.isInteger(req.loyaltyYears) || (req.loyaltyYears as number) < 0) {
    return { ok: false, error: "bad loyalty" };
  }
  return dispatchByCategory(req);
}

function dispatchByCategory(req: Record<string, unknown>): QuoteResult {
  if (req.category === "standard") {
    return quoteStandard(req);
  }
  if (req.category === "suite") {
    return quoteSuite(req);
  }
  if (req.category === "villa") {
    return quoteVilla(req);
  }
  return { ok: false, error: "unknown category" };
}

function quoteStandard(req: Record<string, unknown>): QuoteResult {
  if (!Number.isInteger(req.nights) || (req.nights as number) < 1 || (req.nights as number) > 14) {
    return { ok: false, error: "bad nights" };
  }
  if (!Number.isInteger(req.guests) || (req.guests as number) < 1 || (req.guests as number) > 2) {
    return { ok: false, error: "bad guests" };
  }
  return finishStandardQuote(req);
}

function finishStandardQuote(req: Record<string, unknown>): QuoteResult {
  if (req.season !== "low" && req.season !== "high") {
    return { ok: false, error: "bad season" };
  }
  let total = 80 * (req.nights as number);
  if (req.season === "high") {
    total = total + 30 * (req.nights as number);
  }
  if ((req.loyaltyYears as number) >= 3 || req.coupon === "VIP") {
    total = total - Math.floor(total / 10);
  }
  let policy = "strict";
  if (req.coupon === "VIP" || (req.loyaltyYears as number) > 2) {
    policy = "flex";
  }
  const line = "standard:" + String(req.nights) + "n:" + String(total) + ":" + policy;
  return { ok: true, total, policy, line };
}

function quoteSuite(req: Record<string, unknown>): QuoteResult {
  if (!Number.isInteger(req.nights) || (req.nights as number) < 1 || (req.nights as number) > 21) {
    return { ok: false, error: "bad nights" };
  }
  if (!Number.isInteger(req.guests) || (req.guests as number) < 1 || (req.guests as number) > 4) {
    return { ok: false, error: "bad guests" };
  }
  return priceSuite(req);
}

function priceSuite(req: Record<string, unknown>): QuoteResult {
  if (!(req.season === "low" || req.season === "high")) {
    return { ok: false, error: "bad season" };
  }
  let total = 150 * (req.nights as number);
  if (req.season === "high") {
    total = total + 60 * (req.nights as number);
  }
  if (req.coupon === "VIP" || (req.loyaltyYears as number) >= 3) {
    total = total - Math.floor(total / 10);
  }
  return finishSuiteQuote(req, total);
}

function finishSuiteQuote(req: Record<string, unknown>, total: number): QuoteResult {
  if ((req.guests as number) > 2) {
    total = total + 25;
  }
  let policy = "strict";
  if (!((req.loyaltyYears as number) < 3) || req.coupon === "VIP") {
    policy = "flex";
  }
  const line = "suite:" + String(req.nights) + "n:" + String(total) + ":" + policy;
  return { ok: true, total, policy, line };
}

function quoteVilla(req: Record<string, unknown>): QuoteResult {
  if (!Number.isInteger(req.nights) || (req.nights as number) < 1 || (req.nights as number) > 28) {
    return { ok: false, error: "bad nights" };
  }
  if ((req.nights as number) < 3) {
    return { ok: false, error: "villa minimum stay" };
  }
  if (!Number.isInteger(req.guests) || (req.guests as number) < 1 || (req.guests as number) > 8) {
    return { ok: false, error: "bad guests" };
  }
  return priceVilla(req);
}

function priceVilla(req: Record<string, unknown>): QuoteResult {
  if (req.season !== "low" && req.season !== "high") {
    return { ok: false, error: "bad season" };
  }
  let total = 300 * (req.nights as number);
  if (req.season === "high") {
    total = total + 120 * (req.nights as number);
  }
  if ((req.loyaltyYears as number) > 2 || req.coupon === "VIP") {
    total = total - Math.floor(total / 10);
  }
  return finishVillaQuote(req, total);
}

function finishVillaQuote(req: Record<string, unknown>, total: number): QuoteResult {
  total = total + 500;
  let policy = "strict";
  if (req.coupon === "VIP" || !((req.loyaltyYears as number) < 3)) {
    policy = "flex";
  }
  const line = "villa:" + String(req.nights) + "n:" + String(total) + ":" + policy;
  return { ok: true, total, policy, line };
}
