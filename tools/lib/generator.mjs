/**
 * Ticket-order generator, grounded in the real Broadway weekly grosses dataset.
 *
 * The source data (Playbill, via TidyTuesday) is weekly and per-show: gross,
 * seats sold, seats in theatre, capacity %, average and top ticket price. That
 * is the ground truth we keep — show names, their real theatres, their real
 * price levels, their real week-to-week capacity swings.
 *
 * What the source data does NOT contain is individual orders, so this module
 * models them: it walks each show's real performance schedule, takes the real
 * weekly capacity for that week, sells our platform's share of the house, and
 * splits those seats into orders across sections, channels and party sizes.
 * Prices are anchored to each show's real average ticket price, so the
 * generated gross lands within a few percent of the real per-seat economics.
 */

export const ORDER_COLUMNS = [
  'order_id',
  'ordered_at',
  'event_date',
  'event_time',
  'show',
  'theatre',
  'section',
  'channel',
  'promo_code',
  'quantity',
  'unit_price',
  'gross',
  'customer_segment',
  'status',
];

/** Seats by section, as a share of the house, with price multipliers. */
const SECTIONS = [
  { name: 'Orchestra', share: 0.44, price: 1.35 },
  { name: 'Front Mezzanine', share: 0.19, price: 1.2 },
  { name: 'Rear Mezzanine', share: 0.21, price: 0.75 },
  { name: 'Balcony', share: 0.11, price: 0.5 },
  { name: 'Box', share: 0.05, price: 1.9 },
];

/** Sales channels, with the price effect each one carries. */
const CHANNELS = [
  { name: 'Web', share: 0.34, price: 1.0 },
  { name: 'Mobile App', share: 0.22, price: 0.98 },
  { name: 'Box Office', share: 0.14, price: 1.02 },
  { name: 'TodayTix', share: 0.11, price: 0.86 },
  { name: 'TKTS Booth', share: 0.09, price: 0.55 },
  { name: 'Group Sales', share: 0.06, price: 0.8 },
  { name: 'Telecharge', share: 0.04, price: 1.0 },
];

const SEGMENTS = [
  { name: 'Tourist', share: 0.4 },
  { name: 'Local', share: 0.28 },
  { name: 'Member', share: 0.14 },
  { name: 'Group', share: 0.1 },
  { name: 'Student', share: 0.08 },
];

/** Promo codes and the discount each applies. */
const PROMOS = [
  { code: '', share: 0.72, price: 1.0 },
  { code: 'RUSH25', share: 0.07, price: 0.35 },
  { code: 'STUDENT', share: 0.06, price: 0.5 },
  { code: 'TKTS50', share: 0.05, price: 0.55 },
  { code: 'GROUP20', share: 0.05, price: 0.8 },
  { code: 'MEMBER10', share: 0.05, price: 0.9 },
];

/**
 * Who buys where. A group sale does not come through the TKTS booth, and a
 * member does not buy on TodayTix — the segment picks the channel, not the
 * other way round. Weights are relative and normalized at use.
 */
const CHANNEL_BY_SEGMENT = {
  Tourist: { Web: 0.3, 'Mobile App': 0.14, 'Box Office': 0.17, TodayTix: 0.14, 'TKTS Booth': 0.19, 'Group Sales': 0.01, Telecharge: 0.05 },
  Local: { Web: 0.28, 'Mobile App': 0.34, 'Box Office': 0.1, TodayTix: 0.16, 'TKTS Booth': 0.08, 'Group Sales': 0.01, Telecharge: 0.03 },
  Member: { Web: 0.46, 'Mobile App': 0.24, 'Box Office': 0.13, TodayTix: 0.01, 'TKTS Booth': 0.01, 'Group Sales': 0.02, Telecharge: 0.13 },
  Group: { Web: 0.12, 'Mobile App': 0.04, 'Box Office': 0.1, TodayTix: 0.02, 'TKTS Booth': 0.01, 'Group Sales': 0.63, Telecharge: 0.08 },
  Student: { Web: 0.16, 'Mobile App': 0.36, 'Box Office': 0.16, TodayTix: 0.22, 'TKTS Booth': 0.09, 'Group Sales': 0.0, Telecharge: 0.01 },
};

/** Which codes each segment can actually redeem. */
const PROMOS_BY_SEGMENT = {
  Tourist: ['', 'TKTS50'],
  Local: ['', 'RUSH25', 'TKTS50'],
  Member: ['', 'MEMBER10'],
  Group: ['', 'GROUP20'],
  Student: ['', 'STUDENT', 'RUSH25'],
};

/** Party sizes. Pairs dominate; fours are the family bump; groups buy blocks. */
const PARTY_SIZES = [
  { size: 1, share: 0.15 },
  { size: 2, share: 0.45 },
  { size: 3, share: 0.11 },
  { size: 4, share: 0.19 },
  { size: 5, share: 0.04 },
  { size: 6, share: 0.06 },
];

const PARTY_SIZES_BY_SEGMENT = {
  Group: [
    { size: 4, share: 0.18 },
    { size: 5, share: 0.16 },
    { size: 6, share: 0.24 },
    { size: 8, share: 0.22 },
    { size: 10, share: 0.14 },
    { size: 12, share: 0.06 },
  ],
  Student: [
    { size: 1, share: 0.34 },
    { size: 2, share: 0.46 },
    { size: 3, share: 0.1 },
    { size: 4, share: 0.1 },
  ],
};

/**
 * The standard eight-performance Broadway week: dark Monday, matinees
 * Wednesday, Saturday and Sunday. `[weekday, 'HH:mm', occupancyFactor]`.
 */
const PERFORMANCE_SCHEDULE = [
  [2, '19:00', 0.93], // Tue
  [3, '14:00', 0.9], //  Wed matinee
  [3, '19:00', 0.97], // Wed
  [4, '19:00', 0.97], // Thu
  [5, '20:00', 1.02], // Fri
  [6, '14:00', 0.98], // Sat matinee
  [6, '20:00', 1.04], // Sat
  [0, '15:00', 0.96], // Sun matinee
];

/** Deterministic PRNG so a given seed always rebuilds the same dataset. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn a `{name: weight}` map into a normalized pick table carrying extra fields. */
function weightTable(weights, lookup) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  return Object.entries(weights)
    .filter(([, w]) => w > 0)
    .map(([name, w]) => ({ ...lookup(name), name, share: w / total }));
}

const CHANNEL_PRICE = Object.fromEntries(CHANNELS.map(c => [c.name, c.price]));
const PROMO_PRICE = Object.fromEntries(PROMOS.map(p => [p.code, p.price]));
const PROMO_SHARE = Object.fromEntries(PROMOS.map(p => [p.code, p.share]));

const CHANNEL_TABLE = Object.fromEntries(
  Object.entries(CHANNEL_BY_SEGMENT).map(([segment, weights]) => [
    segment,
    weightTable(weights, name => ({ price: CHANNEL_PRICE[name] })),
  ]),
);

const PROMO_TABLE = Object.fromEntries(
  Object.entries(PROMOS_BY_SEGMENT).map(([segment, codes]) => [
    segment,
    weightTable(
      Object.fromEntries(codes.map(code => [code, PROMO_SHARE[code]])),
      code => ({ code, price: PROMO_PRICE[code] }),
    ),
  ]),
);

/**
 * The expected value of channel discount x promo discount across the whole
 * joint distribution. Dividing by it keeps the generated average ticket price
 * on the show's real average — the real figure is already net of discounts, so
 * without this correction every ticket would be discounted twice.
 */
const DISCOUNT_MEAN = (() => {
  let mean = 0;
  for (const segment of SEGMENTS) {
    for (const channel of CHANNEL_TABLE[segment.name]) {
      // The TKTS booth only ever sells its own half-price code.
      const promos =
        channel.name === 'TKTS Booth'
          ? [{ code: 'TKTS50', price: 1.0, share: 1 }]
          : PROMO_TABLE[segment.name];
      for (const promo of promos) {
        mean += segment.share * channel.share * promo.share * channel.price * promo.price;
      }
    }
  }
  return mean;
})();

function pick(rng, table) {
  const r = rng();
  let acc = 0;
  for (const entry of table) {
    acc += entry.share;
    if (r < acc) return entry;
  }
  return table[table.length - 1];
}

/** Box-Muller, clamped — used for price and lead-time jitter. */
function gauss(rng, mean, sd, min, max) {
  const u = Math.max(rng(), 1e-9);
  const v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, mean + z * sd));
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Reduce the raw weekly grosses rows to per-show profiles for one real season.
 *
 * @param rows       parsed rows of the TidyTuesday `grosses.csv`
 * @param seasonFrom inclusive `week_ending` lower bound (YYYY-MM-DD)
 * @param seasonTo   inclusive `week_ending` upper bound (YYYY-MM-DD)
 * @param showCount  keep the N shows with the most weeks on the boards
 */
export function buildShowProfiles(rows, { seasonFrom, seasonTo, showCount }) {
  const byShow = new Map();
  for (const row of rows) {
    const week = row.week_ending;
    if (!week || week < seasonFrom || week > seasonTo) continue;
    const seats = num(row.seats_in_theatre);
    const price = num(row.avg_ticket_price);
    const capacity = num(row.pct_capacity);
    if (!seats || !price || capacity === null) continue;

    const key = `${row.show}|${row.theatre}`;
    if (!byShow.has(key)) {
      byShow.set(key, { show: row.show, theatre: row.theatre, weeks: [] });
    }
    byShow.get(key).weeks.push({
      weekEnding: week,
      seats,
      avgPrice: price,
      topPrice: num(row.top_ticket_price) ?? price * 2.2,
      capacity: Math.min(1, capacity),
    });
  }

  return [...byShow.values()]
    .filter(p => p.weeks.length >= 8)
    .sort((a, b) => b.weeks.length - a.weeks.length || b.weeks[0].seats - a.weeks[0].seats)
    .slice(0, showCount)
    .map(p => {
      p.weeks.sort((a, b) => a.weekEnding.localeCompare(b.weekEnding));
      return {
        show: p.show,
        theatre: p.theatre,
        seatsInTheatre: Math.round(median(p.weeks.map(w => w.seats))),
        avgTicketPrice: Number(median(p.weeks.map(w => w.avgPrice)).toFixed(2)),
        topTicketPrice: Number(median(p.weeks.map(w => w.topPrice)).toFixed(2)),
        medianCapacity: Number(median(p.weeks.map(w => w.capacity)).toFixed(4)),
        // The real week-by-week curve, replayed over the target window.
        weekly: p.weeks.map(w => ({
          capacity: Number(w.capacity.toFixed(4)),
          avgPrice: Number(w.avgPrice.toFixed(2)),
        })),
      };
    });
}

const DAY_MS = 86400000;

function ymd(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

/** Local wall-clock ISO, no zone suffix. The whole dataset is New York time. */
function localIso(date) {
  return `${ymd(date)}T${String(date.getHours()).padStart(2, '0')}:${String(
    date.getMinutes(),
  ).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

/** Every performance for every show between two dates. */
function performances(profiles, fromMs, toMs) {
  const out = [];
  const start = new Date(fromMs);
  start.setHours(0, 0, 0, 0);
  for (let t = start.getTime(); t <= toMs; t += DAY_MS) {
    const day = new Date(t);
    const weekday = day.getDay();
    for (const [scheduleDay, time, occupancyFactor] of PERFORMANCE_SCHEDULE) {
      if (scheduleDay !== weekday) continue;
      const [hh, mm] = time.split(':').map(Number);
      for (let showIndex = 0; showIndex < profiles.length; showIndex++) {
        const at = new Date(day);
        at.setHours(hh, mm, 0, 0);
        out.push({ profile: profiles[showIndex], showIndex, at, occupancyFactor });
      }
    }
  }
  return out;
}

/**
 * Generate ticket orders whose purchase time falls inside [from, to].
 *
 * Orders are generated per performance — including performances up to
 * `maxLeadDays` beyond `to`, because a sale made today is usually for a show
 * weeks away — and then filtered to the purchase window.
 *
 * @returns rows in ORDER_COLUMNS shape, sorted by `ordered_at`
 */
export function generateOrders({
  profiles,
  from,
  to,
  share = 0.02,
  seed = 20260825,
  maxLeadDays = 120,
  startIndex = 1,
}) {
  const rng = makeRng(seed);
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();

  const orders = [];
  for (const perf of performances(profiles, fromMs, toMs + maxLeadDays * DAY_MS)) {
    const { profile, at, occupancyFactor } = perf;
    const weekIndex = Math.floor((at.getTime() - fromMs) / (7 * DAY_MS));
    const week = profile.weekly[
      ((weekIndex % profile.weekly.length) + profile.weekly.length) % profile.weekly.length
    ];

    const occupancy = Math.min(1, Math.max(0.35, week.capacity * occupancyFactor * gauss(rng, 1, 0.04, 0.8, 1.15)));
    const ourSeats = Math.round(profile.seatsInTheatre * occupancy * share * gauss(rng, 1, 0.18, 0.4, 1.7));
    if (ourSeats <= 0) continue;

    let sold = 0;
    while (sold < ourSeats) {
      const details = sampleOrderDetails(rng, profile, week, ourSeats - sold);
      sold += details.quantity;

      const orderedAt = new Date(at.getTime() - sampleLeadDays(rng, maxLeadDays) * DAY_MS);
      setPurchaseTimeOfDay(rng, orderedAt);
      const orderedMs = orderedAt.getTime();
      if (orderedMs < fromMs || orderedMs > toMs) continue;

      orders.push({ orderedMs, ...orderRow(profile, at, orderedAt, details) });
    }
  }

  orders.sort((a, b) => a.orderedMs - b.orderedMs);
  return orders.map((order, i) => {
    const { orderedMs, ...rest } = order;
    return { order_id: `ORD-${String(startIndex + i).padStart(7, '0')}`, ...rest };
  });
}

/**
 * Generate `count` orders placed in the last `spreadSeconds` — the live feed.
 *
 * Same seat, price and channel model as the historical build; the difference is
 * that the purchase time is fixed at "just now" and the performance is drawn
 * forward from it, which is the direction a real order actually happens.
 */
export function generateBurst({
  profiles,
  at = new Date(),
  count = 8,
  spreadSeconds = 60,
  seed = Date.now() % 2 ** 31,
  maxLeadDays = 120,
  startIndex = 1,
}) {
  const rng = makeRng(seed);
  const atMs = new Date(at).getTime();

  // Bigger houses sell more, so draw the show weighted by seats.
  const showTable = (() => {
    const total = profiles.reduce((sum, p) => sum + p.seatsInTheatre, 0);
    return profiles.map(p => ({ profile: p, share: p.seatsInTheatre / total }));
  })();

  const orders = [];
  for (let i = 0; i < count; i++) {
    const profile = pick(rng, showTable).profile;
    const orderedAt = new Date(atMs - Math.floor(rng() * spreadSeconds * 1000));
    const eventAt = nextPerformance(
      new Date(orderedAt.getTime() + sampleLeadDays(rng, maxLeadDays) * DAY_MS),
    );
    const weekIndex = Math.floor((eventAt.getTime() - atMs) / (7 * DAY_MS));
    const week =
      profile.weekly[((weekIndex % profile.weekly.length) + profile.weekly.length) % profile.weekly.length];

    const details = sampleOrderDetails(rng, profile, week, 12);
    orders.push({ orderedMs: orderedAt.getTime(), ...orderRow(profile, eventAt, orderedAt, details) });
  }

  orders.sort((a, b) => a.orderedMs - b.orderedMs);
  return orders.map((order, i) => {
    const { orderedMs, ...rest } = order;
    return { order_id: `ORD-${String(startIndex + i).padStart(7, '0')}`, ...rest };
  });
}

/**
 * Section multipliers are normalized so the seat-weighted mean is exactly 1,
 * which keeps the generated average ticket price on the show's real one.
 */
const SECTION_MEAN = SECTIONS.reduce((sum, s) => sum + s.share * s.price, 0);

/** Who is buying, through which channel, in which section, at what price. */
function sampleOrderDetails(rng, profile, week, seatsLeft) {
  // Segment first: it decides where they buy, what they can redeem and how many
  // seats they take.
  const segment = pick(rng, SEGMENTS);
  const channel = pick(rng, CHANNEL_TABLE[segment.name]);
  const promo =
    channel.name === 'TKTS Booth' ? { code: 'TKTS50', price: 1.0 } : pick(rng, PROMO_TABLE[segment.name]);
  const party = pick(rng, PARTY_SIZES_BY_SEGMENT[segment.name] ?? PARTY_SIZES);
  const quantity = Math.max(1, Math.min(party.size, seatsLeft));
  const section = pick(rng, SECTIONS);

  const unitPrice =
    week.avgPrice *
    (section.price / SECTION_MEAN) *
    ((channel.price * promo.price) / DISCOUNT_MEAN) *
    gauss(rng, 1, 0.09, 0.7, 1.4);
  const price = Math.max(22, Math.min(profile.topTicketPrice * 1.15, Math.round(unitPrice * 2) / 2));

  return {
    segment,
    channel,
    promo,
    section,
    quantity,
    price,
    status: rng() < 0.015 ? 'refunded' : 'paid',
  };
}

/** Lead time: a short-notice mode (this week) and a planner mode. */
function sampleLeadDays(rng, maxLeadDays) {
  return rng() < 0.42 ? gauss(rng, 3.5, 3.2, 0, 14) : gauss(rng, 34, 26, 1, maxLeadDays);
}

/** Buying happens across the waking day, peaking late morning and evening. */
function setPurchaseTimeOfDay(rng, date) {
  const hour = rng() < 0.5 ? gauss(rng, 11.5, 2.4, 6, 17) : gauss(rng, 19.5, 2.2, 15, 23.9);
  date.setHours(Math.floor(hour), Math.floor(rng() * 60), Math.floor(rng() * 60), 0);
  return date;
}

/** The first scheduled performance at or after `date`. */
function nextPerformance(date) {
  for (let offset = 0; offset < 8; offset++) {
    const day = new Date(date.getTime() + offset * DAY_MS);
    const slots = PERFORMANCE_SCHEDULE.filter(([weekday]) => weekday === day.getDay());
    for (const [, time] of slots) {
      const [hh, mm] = time.split(':').map(Number);
      const at = new Date(day);
      at.setHours(hh, mm, 0, 0);
      if (at.getTime() >= date.getTime()) return at;
    }
  }
  return date;
}

function orderRow(profile, at, orderedAt, details) {
  return {
    ordered_at: localIso(orderedAt),
    event_date: ymd(at),
    event_time: `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`,
    show: profile.show,
    theatre: profile.theatre,
    section: details.section.name,
    channel: details.channel.name,
    promo_code: details.promo.code,
    quantity: details.quantity,
    unit_price: details.price.toFixed(2),
    gross: (details.price * details.quantity).toFixed(2),
    customer_segment: details.segment.name,
    status: details.status,
  };
}

export { SECTIONS, CHANNELS, SEGMENTS, PROMOS, PARTY_SIZES, PERFORMANCE_SCHEDULE };
