interface Want {
  item: string;
  qty: number;
}

export interface FulfillmentResult {
  ok: boolean;
  error?: string;
  orders?: Record<string, string>;
  stock?: Record<string, number>;
  queue?: string[];
  rejected?: number;
  report?: string;
}

interface Counters {
  rejected: number;
}

export function processEvents(raw: unknown): FulfillmentResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: "malformed input" };
  }
  return fulfillEvents(raw as Record<string, unknown>);
}

function fulfillEvents(input: Record<string, unknown>): FulfillmentResult {
  if (typeof input.stock !== "object" || input.stock === null) {
    return { ok: false, error: "bad stock" };
  }
  const stock: Record<string, number> = {};
  const rawStock = input.stock as Record<string, unknown>;
  for (const item of Object.keys(rawStock)) {
    if (!Number.isInteger(rawStock[item]) || (rawStock[item] as number) < 0) {
      return { ok: false, error: "bad stock" };
    }
    stock[item] = rawStock[item] as number;
  }
  if (!Array.isArray(input.events)) {
    return { ok: false, error: "bad events" };
  }
  return processEventQueue(input.events, stock);
}

function processEventQueue(events: unknown[], stock: Record<string, number>): FulfillmentResult {
  const orders: Record<string, string> = {};
  const reserved: Record<string, Want> = {};
  const pendingWants: Record<string, Want> = {};
  const queue: string[] = [];
  const counters: Counters = { rejected: 0 };

  for (let index = 0; index < events.length; index++) {
    const event = events[index] as Record<string, unknown>;
    const error = processEvent(event, index, stock, orders, reserved, pendingWants, queue, counters);
    if (error !== null) {
      return { ok: false, error };
    }
  }

  return {
    ok: true,
    orders,
    stock,
    queue,
    rejected: counters.rejected,
    report: buildReport(orders, counters.rejected),
  };
}

function processEvent(
  event: Record<string, unknown>,
  index: number,
  stock: Record<string, number>,
  orders: Record<string, string>,
  reserved: Record<string, Want>,
  pendingWants: Record<string, Want>,
  queue: string[],
  counters: Counters,
): string | null {
  if (typeof event !== "object" || event === null) {
    return "event " + index + ": malformed";
  }
  if (event.type === "order") {
    return processOrderEvent(event, index, stock, orders, reserved, pendingWants, queue);
  }
  if (event.type === "cancel") {
    return processCancelEvent(event, index, stock, orders, reserved, pendingWants, queue, counters);
  }
  if (event.type === "ship") {
    return processShipEvent(event, index, reserved, orders, counters);
  }
  if (event.type === "restock") {
    return processRestockEvent(event, index, stock, orders, reserved, pendingWants, queue);
  }
  if (event.type === "expire") {
    return processExpireEvent(event, index, stock, orders, reserved, pendingWants, queue, counters);
  }
  return "event " + index + ": bad type";
}

function processOrderEvent(
  event: Record<string, unknown>,
  index: number,
  stock: Record<string, number>,
  orders: Record<string, string>,
  reserved: Record<string, Want>,
  pendingWants: Record<string, Want>,
  queue: string[],
): string | null {
  if (typeof event.id !== "string" || event.id.length === 0) {
    return "event " + index + ": bad id";
  }
  if (orders[event.id] !== undefined) {
    return "event " + index + ": duplicate order";
  }
  return finishOrderEvent(event, index, stock, orders, reserved, pendingWants, queue);
}

function finishOrderEvent(
  event: Record<string, unknown>,
  index: number,
  stock: Record<string, number>,
  orders: Record<string, string>,
  reserved: Record<string, Want>,
  pendingWants: Record<string, Want>,
  queue: string[],
): string | null {
  if (typeof event.item !== "string" || event.item.length === 0) {
    return "event " + index + ": bad item";
  }
  if (!Number.isInteger(event.qty) || (event.qty as number) < 1) {
    return "event " + index + ": bad qty";
  }
  const available = stock[event.item] === undefined ? 0 : stock[event.item];
  if (available >= (event.qty as number)) {
    stock[event.item] = available - (event.qty as number);
    reserved[event.id as string] = { item: event.item, qty: event.qty as number };
    orders[event.id as string] = "reserved";
  } else {
    queue.push(event.id as string);
    pendingWants[event.id as string] = { item: event.item, qty: event.qty as number };
    orders[event.id as string] = "backordered";
  }
  return null;
}

function processCancelEvent(
  event: Record<string, unknown>,
  index: number,
  stock: Record<string, number>,
  orders: Record<string, string>,
  reserved: Record<string, Want>,
  pendingWants: Record<string, Want>,
  queue: string[],
  counters: Counters,
): string | null {
  if (typeof event.id !== "string" || event.id.length === 0) {
    return "event " + index + ": bad id";
  }
  if (reserved[event.id] !== undefined) {
    const holding = reserved[event.id]!;
    const back = stock[holding.item] === undefined ? 0 : stock[holding.item];
    stock[holding.item] = back + holding.qty;
    delete reserved[event.id];
    orders[event.id] = "cancelled";
    refillQueueAfterCancel(stock, orders, reserved, pendingWants, queue);
  } else if (orders[event.id] === "backordered") {
    queue.splice(queue.indexOf(event.id), 1);
    delete pendingWants[event.id];
    orders[event.id] = "cancelled";
  } else {
    counters.rejected = counters.rejected + 1;
  }
  return null;
}

function refillQueueAfterCancel(
  stock: Record<string, number>,
  orders: Record<string, string>,
  reserved: Record<string, Want>,
  pendingWants: Record<string, Want>,
  queue: string[],
): void {
  for (let position = 0; position < queue.length; position++) {
    const pendingId = queue[position]!;
    const want = pendingWants[pendingId]!;
    const onHand = stock[want.item] === undefined ? 0 : stock[want.item];
    if (onHand >= want.qty) {
      stock[want.item] = onHand - want.qty;
      reserved[pendingId] = { item: want.item, qty: want.qty };
      orders[pendingId] = "reserved";
      delete pendingWants[pendingId];
      queue.splice(position, 1);
      position = position - 1;
    }
  }
}

function processShipEvent(
  event: Record<string, unknown>,
  index: number,
  reserved: Record<string, Want>,
  orders: Record<string, string>,
  counters: Counters,
): string | null {
  if (typeof event.id !== "string" || event.id.length === 0) {
    return "event " + index + ": bad id";
  }
  if (event.qty !== undefined && (!Number.isInteger(event.qty) || (event.qty as number) < 1)) {
    return "event " + index + ": bad qty";
  }
  return finishShipEvent(event, reserved, orders, counters);
}

function finishShipEvent(
  event: Record<string, unknown>,
  reserved: Record<string, Want>,
  orders: Record<string, string>,
  counters: Counters,
): string | null {
  if (reserved[event.id as string] === undefined) {
    counters.rejected = counters.rejected + 1;
  } else if (event.qty === undefined || (event.qty as number) === reserved[event.id as string]!.qty) {
    delete reserved[event.id as string];
    orders[event.id as string] = "shipped";
  } else if ((event.qty as number) < reserved[event.id as string]!.qty) {
    reserved[event.id as string]!.qty = reserved[event.id as string]!.qty - (event.qty as number);
    orders[event.id as string] = "partial";
  } else {
    counters.rejected = counters.rejected + 1;
  }
  return null;
}

function processRestockEvent(
  event: Record<string, unknown>,
  index: number,
  stock: Record<string, number>,
  orders: Record<string, string>,
  reserved: Record<string, Want>,
  pendingWants: Record<string, Want>,
  queue: string[],
): string | null {
  if (typeof event.item !== "string" || event.item.length === 0) {
    return "event " + index + ": bad item";
  }
  if (!Number.isInteger(event.qty) || (event.qty as number) < 1) {
    return "event " + index + ": bad qty";
  }
  const held = stock[event.item] === undefined ? 0 : stock[event.item];
  stock[event.item] = held + (event.qty as number);
  refillQueueAfterRestock(stock, orders, reserved, pendingWants, queue);
  return null;
}

function refillQueueAfterRestock(
  stock: Record<string, number>,
  orders: Record<string, string>,
  reserved: Record<string, Want>,
  pendingWants: Record<string, Want>,
  queue: string[],
): void {
  for (let position = 0; position < queue.length; position++) {
    const pendingId = queue[position]!;
    const want = pendingWants[pendingId]!;
    const onHand = stock[want.item] === undefined ? 0 : stock[want.item];
    if (onHand >= want.qty) {
      stock[want.item] = onHand - want.qty;
      reserved[pendingId] = { item: want.item, qty: want.qty };
      orders[pendingId] = "reserved";
      delete pendingWants[pendingId];
      queue.splice(position, 1);
      position = position - 1;
    }
  }
}

function processExpireEvent(
  event: Record<string, unknown>,
  index: number,
  stock: Record<string, number>,
  orders: Record<string, string>,
  reserved: Record<string, Want>,
  pendingWants: Record<string, Want>,
  queue: string[],
  counters: Counters,
): string | null {
  if (typeof event.id !== "string" || event.id.length === 0) {
    return "event " + index + ": bad id";
  }
  if (reserved[event.id] !== undefined) {
    const holding = reserved[event.id]!;
    const back = stock[holding.item] === undefined ? 0 : stock[holding.item];
    stock[holding.item] = back + holding.qty;
    delete reserved[event.id];
    orders[event.id] = "expired";
    for (let position = 0; position < queue.length; position++) {
      const pendingId = queue[position]!;
      const want = pendingWants[pendingId]!;
      const onHand = stock[want.item] === undefined ? 0 : stock[want.item];
      if (onHand >= want.qty) {
        stock[want.item] = onHand - want.qty;
        reserved[pendingId] = { item: want.item, qty: want.qty };
        orders[pendingId] = "reserved";
        delete pendingWants[pendingId];
        queue.splice(position, 1);
        position = position - 1;
      }
    }
  } else {
    counters.rejected = counters.rejected + 1;
  }
  return null;
}

const STATUSES = ["reserved", "backordered", "shipped", "partial", "cancelled", "expired"];

function statusCounts(orders: Record<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const status of STATUSES) {
    counts[status] = 0;
  }
  for (const id of Object.keys(orders)) {
    counts[orders[id]!] = counts[orders[id]!]! + 1;
  }
  return counts;
}

function buildReport(orders: Record<string, string>, rejected: number): string {
  const counts = statusCounts(orders);
  let line = "orders=" + Object.keys(orders).length;
  for (const status of STATUSES) {
    line = line + ";" + status + "=" + counts[status];
  }
  return line + ";rejected=" + rejected;
}
