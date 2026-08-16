import type { FormField, OutputSpec } from '@mimic/schema';
import { toAirportCode } from './airports';

/**
 * Known sites, described once and properly.
 *
 * The generic compiler reads a recording and works out which parts of the URL
 * were the person's inputs. That works whenever a site puts one value in one
 * parameter. It cannot work when a site welds several values into one string:
 *
 *   kayak     /flights/DAC-KUL/2026-08-25/2026-09-02/2adults
 *   gozayaan  ?trips=KUL,DAC,2026-08-19,DAC,KUL,2026-09-20
 *
 * There is no `{placeholder}` that reaches inside those. So the compiler kept
 * the whole blob as one "advanced" field, and separately exposed the From/To
 * and date fields it had genuinely recorded — which drove page steps that the
 * URL shortcut skips. Every run searched the recorded trip no matter what was
 * typed into the form, and reported success.
 *
 * A profile replaces the guesswork for these sites with a function that builds
 * the URL from the values. Everything else still goes through the generic path.
 */

/**
 * One thing a person might ask for beyond the basics.
 *
 * "Two adults, two rooms" is the shape of every hotel search. "Must have a
 * swimming pool", "no prepayment", "beachfront" are the reason someone is
 * searching at all, and dropping them silently returns a page of results that
 * look right and answer a different question.
 *
 * Every `code` here was read off the site and then confirmed by applying it and
 * watching the result count move. None are remembered or inferred: an invented
 * filter token does not fail loudly on Booking — it returns an unfiltered page.
 */
export interface SiteFilter {
  key: string;
  label: string;
  /** The site's own token, e.g. `hotelfacility=433`. */
  code: string;
  /** Roughly how many of ~83 Cox's Bazar properties matched, when checked. */
  verified: number;
  /**
   * How someone says it.
   *
   * Read against the spoken request directly rather than asked of the model.
   * The model is told — correctly — never to invent a filter parameter it is
   * unsure of, so it leaves these out entirely and "must have a swimming pool"
   * arrived as nothing at all. The profile is the thing that knows this site's
   * filters, so the profile is the thing that should recognise them.
   */
  match: RegExp;
}

/** Which of a site's filters a request is asking for. */
export const filtersInRequest = (
  filters: SiteFilter[] | undefined,
  transcript: string,
): string[] => (filters ?? []).filter((f) => f.match.test(transcript)).map((f) => f.key);

export interface SiteProfile {
  id: string;
  /** Matched against the automation's hostname. */
  host: RegExp;
  name: string;
  category: string;
  emoji: string;
  fields: FormField[];
  /**
   * Optional extras, offered as toggles and understood from a spoken request.
   * Kept apart from `fields` so the form leads with what everyone needs and
   * keeps the long tail behind "Advanced".
   */
  filters?: SiteFilter[];
  output: OutputSpec;
  /** The results URL for these values, or undefined when they can't produce one. */
  buildUrl(values: Record<string, unknown>): string | undefined;
}

/** A filter as a form field: a toggle, off by default, tucked under Advanced. */
export const filterField = (f: SiteFilter, order: number): FormField =>
  field({
    key: f.key,
    label: f.label,
    kind: 'toggle',
    group: 'Filters',
    order,
    exposure: 'advanced',
    defaultValue: false,
  });

/** The site's tokens for whichever extras are switched on. */
export const activeFilters = (
  filters: SiteFilter[] | undefined,
  values: Record<string, unknown>,
): string[] =>
  (filters ?? [])
    .filter((f) => values[f.key] === true || values[f.key] === 'true')
    .map((f) => f.code);

const str = (v: unknown): string => String(v ?? '').trim();
const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

/** YYYY-MM-DD, or nothing. Never a half-parsed date the site will misread. */
const iso = (v: unknown): string | undefined => {
  const raw = str(v);
  if (!raw) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return undefined;
  const d = new Date(parsed);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const field = (f: Partial<FormField> & Pick<FormField, 'key' | 'label' | 'kind'>): FormField => ({
  group: 'Details',
  order: 0,
  required: false,
  defaultValue: null,
  options: [],
  validation: {},
  bindsTo: [],
  exposure: 'variable',
  ...f,
});

/* ── flight fields, shared by both flight sites ─────────────────────────── */

const flightFields = (): FormField[] => [
  field({ key: 'origin', label: 'From', kind: 'text', group: 'Trip', order: 0, required: true,
    hint: 'City or airport code — Dhaka, DAC, Kuala Lumpur.' }),
  field({ key: 'destination', label: 'To', kind: 'text', group: 'Trip', order: 1, required: true,
    hint: 'City or airport code.' }),
  field({ key: 'depart_date', label: 'Departure', kind: 'date', group: 'Trip', order: 2, required: true }),
  field({ key: 'return_date', label: 'Return', kind: 'date', group: 'Trip', order: 3,
    hint: 'Leave empty for a one-way trip.', validation: { afterField: 'depart_date' } }),
  field({ key: 'adults', label: 'Adults', kind: 'number', group: 'Passengers', order: 4,
    defaultValue: 1, validation: { min: 1, max: 9 } }),
  field({ key: 'children', label: 'Children', kind: 'number', group: 'Passengers', order: 5,
    defaultValue: 0, validation: { min: 0, max: 8 } }),
  field({ key: 'infants', label: 'Infants', kind: 'number', group: 'Passengers', order: 6,
    defaultValue: 0, validation: { min: 0, max: 8 } }),
];

const flightOutput = (itemLocator: string): OutputSpec => ({
  layout: 'cards',
  resultKind: 'flight',
  itemLocator,
  itemLocatorPinned: true,
  fields: [],
  emptyStateHints: ['no flights found', 'no flights available', 'no result found', 'no results found'],
  unavailableHints: ['sold out', 'not available'],
});

/* ── the profiles ───────────────────────────────────────────────────────── */

const GOZAYAAN: SiteProfile = {
  id: 'gozayaan-flights',
  host: /(^|\.)gozayaan\.com$/i,
  name: 'GoZayaan flight search',
  category: 'flights',
  emoji: '✈️',
  fields: [
    ...flightFields(),
    field({
      key: 'cabin_class',
      label: 'Cabin class',
      kind: 'select',
      group: 'Passengers',
      order: 7,
      exposure: 'advanced',
      defaultValue: 'Economy',
      options: ['Economy', 'Premium Economy', 'Business', 'First'].map((v) => ({
        label: v,
        value: v,
        disabled: false,
      })),
    }),
  ],
  output: flightOutput('div.flight-card'),

  buildUrl(values) {
    const from = toAirportCode(values.origin);
    const to = toAirportCode(values.destination);
    const depart = iso(values.depart_date);
    if (!from || !to || !depart) return undefined;

    /* One leg per trip, each written "FROM,TO,DATE". A return simply adds the
       mirrored leg — which is why an empty return date has to mean one-way
       rather than an empty third field the site reads as a malformed leg. */
    const legs = [`${from},${to},${depart}`];
    const back = iso(values.return_date);
    if (back) legs.push(`${to},${from},${back}`);

    const query = new URLSearchParams({
      adult: String(num(values.adults, 1) || 1),
      child: String(num(values.children, 0)),
      child_age: '',
      infant: String(num(values.infants, 0)),
      cabin_class: str(values.cabin_class) || 'Economy',
      trips: legs.join(','),
    });
    // The site wants the commas literal; encoded ones come back as no flights.
    return `https://gozayaan.com/flight/list?${query.toString().replace(/%2C/gi, ',')}`;
  },
};

const KAYAK: SiteProfile = {
  id: 'kayak-flights',
  host: /(^|\.)kayak\.com$/i,
  name: 'Kayak flight search',
  category: 'flights',
  emoji: '✈️',
  fields: [
    ...flightFields(),
    field({
      key: 'cabin_class',
      label: 'Cabin class',
      kind: 'select',
      group: 'Passengers',
      order: 7,
      exposure: 'advanced',
      defaultValue: 'economy',
      options: [
        { label: 'Economy', value: 'economy', disabled: false },
        { label: 'Premium economy', value: 'premium', disabled: false },
        { label: 'Business', value: 'business', disabled: false },
        { label: 'First', value: 'first', disabled: false },
      ],
    }),
    field({
      key: 'sort_by',
      label: 'Sort by',
      kind: 'select',
      group: 'Preferences',
      order: 8,
      exposure: 'advanced',
      defaultValue: 'bestflight_a',
      options: [
        { label: 'Best', value: 'bestflight_a', disabled: false },
        { label: 'Cheapest', value: 'price_a', disabled: false },
        { label: 'Quickest', value: 'duration_a', disabled: false },
      ],
    }),
  ],
  /* Kayak hashes its class names, so nothing readable survives a redeploy —
     and it cross-sells hotels in the same list, which is what the structural
     scanner picked when left to choose ("Holiday Inn Express Bangkok" as a
     flight). A union of the attributes that do persist beats both: the result
     id it puts on real rows, and the modifier class its flight rows carry. */
  output: flightOutput('[data-resultid], div[class*="mod-variant-no-heading"]'),

  buildUrl(values) {
    const from = toAirportCode(values.origin);
    const to = toAirportCode(values.destination);
    const depart = iso(values.depart_date);
    if (!from || !to || !depart) return undefined;

    const back = iso(values.return_date);
    const travellers = [
      `${Math.max(1, num(values.adults, 1))}adults`,
      num(values.children, 0) ? `${num(values.children, 0)}children` : '',
    ]
      .filter(Boolean)
      .join('/');

    const cabin = str(values.cabin_class);
    const path = [
      'flights',
      `${from}-${to}`,
      depart,
      back ?? '',
      travellers,
      cabin && cabin !== 'economy' ? cabin : '',
    ]
      .filter(Boolean)
      .join('/');

    const sort = str(values.sort_by) || 'bestflight_a';
    return `https://www.kayak.com/${path}?sort=${encodeURIComponent(sort)}`;
  },
};

/**
 * Booking.com stays.
 *
 * Booking's URL is one value per parameter, so inference works — but what it
 * inferred from a recording was a mess: two destination fields (the combobox
 * the person typed into and the `ss` parameter it produced), a `Language`
 * field nobody would change, a filter called `Class=5` named after a raw query
 * fragment, and a five-star toggle bound to a click on an `<svg>` that no
 * longer exists on the next run.
 *
 * The site's filters are a `;`-joined bundle, which is the part inference
 * cannot express, so it belongs here with the rest.
 */
/**
 * Booking's own filter tokens, each confirmed against the live site.
 *
 * `scripts/verify-filters.mts` applies one at a time to the same search and
 * records how many of the ~83 Cox's Bazar properties survive. A token that is
 * wrong does not error — Booking ignores it and returns everything — so a
 * number that moved is the only proof worth having, and the numbers are kept
 * here so the next person can tell a verified code from a remembered one.
 */
const BOOKING_FILTERS: SiteFilter[] = [
  { key: 'breakfast', label: 'Breakfast included', code: 'mealplan=1', verified: 49,
    match: /\bbreakfast\b/i },
  { key: 'free_cancellation', label: 'Free cancellation', code: 'fc=2', verified: 41,
    match: /\bfree cancel|\bcancel(l?able|lation) (is )?free|\brefundable\b/i },
  { key: 'no_prepayment', label: 'No prepayment needed', code: 'oos=1', verified: 83,
    match: /\bno pre-?pay|\bwithout pre-?pay|\bpay (at|on) (the )?(property|arrival|hotel)\b/i },
  { key: 'swimming_pool', label: 'Swimming pool', code: 'hotelfacility=433', verified: 13,
    match: /\b(swimming ?)?pool\b/i },
  { key: 'beachfront', label: 'Beachfront', code: 'hotelfacility=146', verified: 9,
    match: /\bbeach ?front|\bon the beach\b|\bsea ?front\b/i },
  { key: 'spa', label: 'Spa and wellness centre', code: 'hotelfacility=54', verified: 10,
    match: /\bspa\b|\bwellness\b/i },
  { key: 'parking', label: 'Parking', code: 'hotelfacility=2', verified: 77,
    match: /\bparking\b|\bcar park\b/i },
  { key: 'free_wifi', label: 'Free WiFi', code: 'hotelfacility=107', verified: 61,
    match: /\bwi-?fi\b|\binternet\b/i },
  { key: 'air_conditioning', label: 'Air conditioning', code: 'roomfacility=11', verified: 73,
    match: /\bair ?con(ditioning|ditioned)?\b|\bA\/?C\b/i },
  { key: 'private_bathroom', label: 'Private bathroom', code: 'roomfacility=38', verified: 58,
    match: /\bprivate bath/i },
  { key: 'balcony', label: 'Balcony', code: 'roomfacility=17', verified: 60,
    match: /\bbalcon(y|ies)\b|\bterrace\b/i },
  { key: 'hotels_only', label: 'Hotels only', code: 'ht_id=204', verified: 75,
    match: /\bhotels? only\b|\bonly hotels?\b/i },
  { key: 'resorts_only', label: 'Resorts only', code: 'ht_id=206', verified: 1,
    match: /\bresorts? only\b|\bonly resorts?\b|\ba resort\b/i },
  { key: 'well_reviewed', label: 'Rated 8+ by guests', code: 'review_score=80', verified: 3,
    match: /\bwell[- ]reviewed\b|\bhighly rated\b|\bgood reviews?\b|\brating (of )?8/i },
];

const BOOKING: SiteProfile = {
  id: 'booking-stays',
  host: /(^|\.)booking\.com$/i,
  name: 'Booking.com hotel search',
  category: 'hotels',
  emoji: '🏨',
  fields: [
    field({ key: 'destination', label: 'Destination', kind: 'text', group: 'Trip', order: 0, required: true,
      hint: 'City, region or property name.' }),
    field({ key: 'check_in', label: 'Check-in', kind: 'date', group: 'Trip', order: 1, required: true }),
    field({ key: 'check_out', label: 'Check-out', kind: 'date', group: 'Trip', order: 2, required: true,
      validation: { afterField: 'check_in' } }),
    field({ key: 'adults', label: 'Adults', kind: 'number', group: 'Guests', order: 3,
      defaultValue: 2, validation: { min: 1, max: 30 } }),
    field({ key: 'children', label: 'Children', kind: 'number', group: 'Guests', order: 4,
      defaultValue: 0, validation: { min: 0, max: 10 } }),
    field({ key: 'rooms', label: 'Rooms', kind: 'number', group: 'Guests', order: 5,
      defaultValue: 1, validation: { min: 1, max: 30 } }),
    field({ key: 'stars', label: 'Star rating', kind: 'select', group: 'Filters', order: 6,
      exposure: 'advanced', defaultValue: '',
      hint: 'Leave as Any unless you want to narrow it.',
      options: [
        { label: 'Any', value: '', disabled: false },
        { label: '3 stars', value: '3', disabled: false },
        { label: '4 stars', value: '4', disabled: false },
        { label: '5 stars', value: '5', disabled: false },
      ] }),
    ...BOOKING_FILTERS.map((f, i) => filterField(f, 7 + i)),
  ],
  filters: BOOKING_FILTERS,
  output: {
    layout: 'cards',
    resultKind: 'stay',
    itemLocator: '[data-testid="property-card"]',
    itemLocatorPinned: false,
    fields: [],
    emptyStateHints: ['no properties found', '0 properties found', 'no results found'],
    unavailableHints: ['sold out', 'no availability', 'fully booked'],
  },

  buildUrl(values) {
    const destination = str(values.destination);
    const checkIn = iso(values.check_in);
    const checkOut = iso(values.check_out);
    if (!destination || !checkIn || !checkOut) return undefined;

    const query = new URLSearchParams({
      ss: destination,
      checkin: checkIn,
      checkout: checkOut,
      group_adults: String(Math.max(1, num(values.adults, 2))),
      group_children: String(num(values.children, 0)),
      no_rooms: String(Math.max(1, num(values.rooms, 1))),
    });

    /* Filters only when asked for. A recording made with "breakfast included"
       ticked used to weld that into every future run, and Cox's Bazar with two
       inherited filters returns nothing at all. */
    const filters: string[] = [];
    const stars = str(values.stars);
    if (/^[1-5]$/.test(stars)) filters.push(`class=${stars}`);
    filters.push(...activeFilters(BOOKING_FILTERS, values));
    if (filters.length) query.set('nflt', filters.join(';'));

    return `https://www.booking.com/searchresults.html?${query.toString()}`;
  },
};

const PROFILES: SiteProfile[] = [GOZAYAAN, KAYAK, BOOKING];

/** The profile for a hostname, if this site has one. */
export function profileFor(site: string | undefined): SiteProfile | undefined {
  if (!site) return undefined;
  const host = site.replace(/^https?:\/\//i, '').split('/')[0].toLowerCase();
  return PROFILES.find((p) => p.host.test(host));
}
