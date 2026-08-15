/**
 * City and airport names to IATA codes.
 *
 * Flight sites put codes in their URLs and city names in their search boxes,
 * so a form that reads "Dhaka" cannot build the URL that returns flights
 * without this step. The list is deliberately small and regional rather than
 * exhaustive: it covers what a person here actually searches, and anything
 * missing falls back to driving the site's own autocomplete.
 */

const AIRPORTS: Record<string, string> = {
  // Bangladesh
  dhaka: 'DAC',
  'hazrat shahjalal': 'DAC',
  "cox's bazar": 'CXB',
  'coxs bazar': 'CXB',
  chittagong: 'CGP',
  chattogram: 'CGP',
  sylhet: 'ZYL',
  jessore: 'JSR',
  jashore: 'JSR',
  barisal: 'BZL',
  rajshahi: 'RJH',
  saidpur: 'SPD',

  // South and South-East Asia
  kolkata: 'CCU',
  calcutta: 'CCU',
  delhi: 'DEL',
  'new delhi': 'DEL',
  mumbai: 'BOM',
  bombay: 'BOM',
  chennai: 'MAA',
  bangalore: 'BLR',
  bengaluru: 'BLR',
  hyderabad: 'HYD',
  kathmandu: 'KTM',
  colombo: 'CMB',
  male: 'MLE',
  maldives: 'MLE',
  karachi: 'KHI',
  lahore: 'LHE',
  islamabad: 'ISB',
  bangkok: 'BKK',
  phuket: 'HKT',
  'kuala lumpur': 'KUL',
  singapore: 'SIN',
  jakarta: 'CGK',
  bali: 'DPS',
  denpasar: 'DPS',
  'ho chi minh': 'SGN',
  hanoi: 'HAN',
  manila: 'MNL',
  'hong kong': 'HKG',
  guangzhou: 'CAN',
  shanghai: 'PVG',
  beijing: 'PEK',
  tokyo: 'NRT',
  seoul: 'ICN',

  // Middle East
  dubai: 'DXB',
  'abu dhabi': 'AUH',
  sharjah: 'SHJ',
  doha: 'DOH',
  kuwait: 'KWI',
  muscat: 'MCT',
  riyadh: 'RUH',
  jeddah: 'JED',
  dammam: 'DMM',
  bahrain: 'BAH',
  manama: 'BAH',
  istanbul: 'IST',

  // Europe and North America
  london: 'LHR',
  'london heathrow': 'LHR',
  manchester: 'MAN',
  paris: 'CDG',
  amsterdam: 'AMS',
  frankfurt: 'FRA',
  munich: 'MUC',
  rome: 'FCO',
  madrid: 'MAD',
  barcelona: 'BCN',
  zurich: 'ZRH',
  milan: 'MXP',
  'new york': 'JFK',
  newark: 'EWR',
  boston: 'BOS',
  washington: 'IAD',
  atlanta: 'ATL',
  chicago: 'ORD',
  dallas: 'DFW',
  houston: 'IAH',
  'los angeles': 'LAX',
  'san francisco': 'SFO',
  seattle: 'SEA',
  toronto: 'YYZ',
  vancouver: 'YVR',
  sydney: 'SYD',
  melbourne: 'MEL',
};

/**
 * The IATA code for whatever the person typed.
 *
 * Accepts a bare code as-is, then the site's own combobox text ("Dhaka, Bangladesh",
 * "DAC, Hazrat Shahjalal International Airport"), then a plain city name.
 */
export function toAirportCode(input: unknown): string | undefined {
  const raw = String(input ?? '').trim();
  if (!raw) return undefined;

  // Already a code.
  if (/^[A-Z]{3}$/.test(raw)) return raw;

  // Comboboxes render "DAC, Hazrat Shahjalal…" or "Dhaka (DAC)".
  const embedded = raw.match(/\b([A-Z]{3})\b/);
  if (embedded && !/^[A-Z]{3}$/.test(raw)) {
    const code = embedded[1];
    // "USA" and "NEW" are words, not codes — only trust one in a code position.
    if (/^[A-Z]{3},|\([A-Z]{3}\)/.test(raw) || raw.startsWith(`${code},`)) return code;
  }

  const lower = raw.toLowerCase();
  if (AIRPORTS[lower]) return AIRPORTS[lower];

  // "Dhaka, Bangladesh" → "dhaka"; "Cox's Bazar Airport" → "cox's bazar".
  const head = lower.split(/[,(]/)[0].replace(/\b(international|intl|airport)\b/g, '').trim();
  if (AIRPORTS[head]) return AIRPORTS[head];

  for (const [name, code] of Object.entries(AIRPORTS)) {
    if (head === name || head.startsWith(`${name} `)) return code;
  }
  return undefined;
}
