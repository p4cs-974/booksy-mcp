#!/usr/bin/env node
/**
 * Booksy (Brazil) MCP server.
 * Zero dependencies: JSON-RPC 2.0 over newline-delimited stdin/stdout + global fetch.
 *
 * Read tools return compact shapes (not raw upstream JSON):
 *   BusinessSummary { id, name, address, city, rating, reviews_count, url }
 *   BusinessDetail  { id, name, address, services, staff }
 *   DaySlots        { business_id, variant_id, date, staff: [{ staffer_id, name, times }] }
 *
 * Authenticated tools (BOOKSY_ACCESS_TOKEN only) can list, preview, confirm, or
 * cancel bookings. They do not log in with email/password (hCaptcha required).
 * Never print API keys or access tokens.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { stdin, stdout, stderr } from "node:process";

const SERVER_NAME = "booksy";
const SERVER_VERSION = "0.2.0";
const PROTOCOL_VERSION = "2024-11-05";
const UA =
  process.env.BOOKSY_UA ||
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const KEY_RE = /PRODUCTION:[`"'](web-[0-9a-f-]{36})[`"']/;
const KEY_VALUE_RE = /^web-[0-9a-f-]{36}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PUBLIC_PAGE_PREFIX = "https://booksy.com/pt-br/";
// widget-2024 Config.appVersion; meta.app_version and X-App-Version must match this shape.
const WIDGET_APP_VERSION = process.env.BOOKSY_APP_VERSION || "1.213.0";

let keyMemo;

function countryCode() {
  return process.env.BOOKSY_COUNTRY || "br";
}

function locale() {
  return process.env.BOOKSY_LOCALE || "pt-BR";
}

function apiBase() {
  return `https://${countryCode()}.booksy.com/core/v2/customer_api`;
}

function cacheDir() {
  return process.env.BOOKSY_CACHE_DIR || join(tmpdir(), "booksy-cache");
}

function logErr(message) {
  stderr.write(`${message}\n`);
}

function tokenFile() {
  return process.env.BOOKSY_TOKEN_FILE || join(homedir(), ".config", "booksy", "token");
}

function configDir() {
  return join(homedir(), ".config", "booksy");
}

function fingerprintFile() {
  return process.env.BOOKSY_FINGERPRINT_FILE || join(configDir(), "fingerprint");
}

// Widget client always sends X-Fingerprint (UUID in the _bf cookie, or a generated one).
function fingerprint() {
  const fromEnv = process.env.BOOKSY_FINGERPRINT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const stored = readFileSync(fingerprintFile(), "utf8").trim();
    if (stored) return stored;
  } catch {
    // no stored fingerprint
  }
  const generated = randomUUID();
  try {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(fingerprintFile(), `${generated}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // persistence is optional
  }
  return generated;
}

// Env wins; otherwise read the token file on every call so a new token needs no restart.
function accessToken() {
  const value = process.env.BOOKSY_ACCESS_TOKEN;
  if (value && value.trim()) return value.trim();
  try {
    return readFileSync(tokenFile(), "utf8").trim();
  } catch {
    return "";
  }
}

const NOT_CONFIGURED =
  "Booksy account tools are not configured. Set BOOKSY_ACCESS_TOKEN (env) or write it to ~/.config/booksy/token (mode 600) — your Booksy customer access token (the x-access-token value from a session you already have). Email/password login is not supported because Booksy requires an hCaptcha token on POST /core/v2/customer_api/account/login. Do not scrape the token from a browser; paste it into the environment yourself.";

function requireAccessToken() {
  const token = accessToken();
  if (!token) throw new Error(NOT_CONFIGURED);
  return token;
}

function redact(value) {
  if (value == null) return value;
  let text = String(value).replace(/web-[0-9a-f-]{36}/gi, "web-[redacted]");
  const token = accessToken();
  if (token) text = text.split(token).join("[redacted-token]");
  return text;
}

function envKey() {
  const value = process.env.BOOKSY_API_KEY;
  return value && value.trim() ? value.trim() : "";
}

function extractKeyFromJs(body) {
  const match = String(body).match(KEY_RE);
  return match ? match[1] : "";
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { "User-Agent": UA, Accept: "*/*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching asset`);
  }
  return res.text();
}

function scriptUrlsFromPage(html) {
  const urls = new Set();
  const re = /https:\/\/[^"'\s]+?\.js/gi;
  let match;
  while ((match = re.exec(html))) {
    urls.add(match[0].replace(/&amp;/g, "&"));
  }
  const preferred = [];
  const other = [];
  for (const url of urls) {
    if (/mp-\d{4}-assets/i.test(url)) preferred.push(url);
    else other.push(url);
  }
  return [...preferred, ...other];
}

async function fetchApiKeyFromPage() {
  let page = "";
  try {
    page = await fetchText("https://booksy.com/pt-br/", 20_000);
  } catch {
    return "";
  }
  if (!page) return "";

  for (const url of scriptUrlsFromPage(page)) {
    let body = "";
    try {
      body = await fetchText(url, 30_000);
    } catch {
      continue;
    }
    if (!body) continue;
    if (!body.includes("customer_api") && !body.includes("bn={DEVELOPMENT") && !body.includes("PRODUCTION:")) {
      continue;
    }
    const key = extractKeyFromJs(body);
    if (key) return key;
  }
  return "";
}

async function resolveApiKey() {
  if (keyMemo) return keyMemo;

  const fromEnv = envKey();
  if (fromEnv) {
    keyMemo = fromEnv;
    return keyMemo;
  }

  const dir = cacheDir();
  const cachePath = join(dir, "api_key");
  try {
    const info = await stat(cachePath);
    if (Date.now() - info.mtimeMs < CACHE_TTL_MS) {
      const cached = (await readFile(cachePath, "utf8")).trim();
      if (KEY_VALUE_RE.test(cached)) {
        keyMemo = cached;
        return keyMemo;
      }
    }
  } catch {
    // no usable cache
  }

  const skipFetch = process.env.BOOKSY_FETCH_KEY === "0";
  const scraped = skipFetch ? "" : await fetchApiKeyFromPage();
  if (!scraped) {
    throw new Error(
      "Could not resolve Booksy API key. Set BOOKSY_API_KEY, or allow the server to scrape the production web key from booksy.com JS assets."
    );
  }

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(cachePath, scraped, { encoding: "utf8", mode: 0o600 });
  } catch {
    // cache is optional
  }

  keyMemo = scraped;
  return keyMemo;
}

async function apiRequest(method, path, { params, body, auth = false } = {}) {
  const url = new URL(path.startsWith("http") ? path : `${apiBase()}${path}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value != null && value !== "") url.searchParams.set(key, String(value));
    }
  }

  const apiKey = await resolveApiKey();
  const headers = {
    "User-Agent": UA,
    Accept: "application/json",
    "Accept-Language": locale(),
    "Cache-Control": "no-cache",
    "x-api-key": apiKey,
    "X-App-Version": WIDGET_APP_VERSION,
    "X-Fingerprint": fingerprint(),
  };
  if (auth) headers["x-access-token"] = requireAccessToken();
  if (body !== undefined) headers["Content-Type"] = "application/json";

  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Booksy request failed for ${url.pathname}: ${redact(err.message)}`);
  }

  const text = await res.text();
  if (!res.ok) {
    const snippet = redact(text).replace(/\s+/g, " ").slice(0, 280);
    throw new Error(
      `Booksy HTTP ${res.status} for ${method} ${url.pathname}${url.search}: ${snippet || res.statusText}`
    );
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Booksy returned non-JSON for ${url.pathname}`);
  }
}

async function apiGet(path, params) {
  return apiRequest("GET", path, { params });
}

function asId(value, field) {
  if (value == null || value === "") {
    throw new Error(`Missing required argument: ${field}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid ${field}: expected a number, got ${JSON.stringify(value)}`);
  }
  return n;
}

function publicUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${PUBLIC_PAGE_PREFIX}${raw.replace(/^\/+/, "")}`;
}

function mapBusinessSummary(business) {
  const location = business.location || {};
  return {
    id: business.id,
    name: business.name ?? null,
    address: location.address ?? null,
    city: location.city ?? null,
    rating: business.reviews_rank ?? null,
    reviews_count: business.reviews_count ?? null,
    url: publicUrl(business.url),
  };
}

function mapBusinessDetail(payload) {
  const business = payload.business || payload;
  const location = business.location || {};
  const services = [];

  for (const category of business.service_categories || []) {
    for (const service of category.services || []) {
      if (service.active === false) continue;
      if (service.is_available_for_customer_booking === false) continue;
      const variants = [];
      for (const variant of service.variants || []) {
        if (variant.id == null) continue;
        variants.push({
          variant_id: variant.id,
          price: variant.price ?? null,
          duration_min: variant.duration ?? null,
        });
      }
      if (!variants.length) continue;
      services.push({ name: service.name ?? null, variants });
    }
  }

  const staff = [];
  for (const person of business.staff || []) {
    if (person.active === false) continue;
    if (person.visible === false) continue;
    if (person.id == null) continue;
    staff.push({ staffer_id: person.id, name: person.name ?? null });
  }

  return {
    id: business.id,
    name: business.name ?? null,
    address: location.address ?? null,
    services,
    staff,
  };
}

function parseHm(value) {
  const [h, m] = String(value).split(":");
  return Number(h) * 60 + Number(m);
}

function formatHm(minutes) {
  const h = Math.floor(minutes / 60);
  const m = Math.floor(minutes % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function expandBlocks(blocks) {
  const times = [];
  const seen = new Set();
  for (const block of blocks || []) {
    if (block.from == null || block.to == null || block.interval == null) continue;
    const start = parseHm(block.from);
    const end = parseHm(block.to);
    const step = Number(block.interval);
    if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(step) || step <= 0) {
      continue;
    }
    const count = Math.floor((end - start) / step) + 1;
    for (let i = 0; i < count; i++) {
      const stamp = formatHm(start + i * step);
      if (!seen.has(stamp)) {
        seen.add(stamp);
        times.push(stamp);
      }
    }
  }
  return times;
}

function mapDaySlots(payload, businessId, variantId, date, stafferId) {
  const resources = payload.resources || [];
  if (stafferId != null) {
    const match = resources.find((resource) => resource.id === stafferId);
    if (!match) {
      const available = resources
        .map((resource) => `${resource.id} (${resource.name || "unnamed"})`)
        .join(", ");
      throw new Error(
        `Staffer ${stafferId} was not in the slots response for business ${businessId} on ${date}.` +
          (available ? ` Available: ${available}.` : " No staff resources were returned.")
      );
    }
  }

  const staff = [];
  for (const resource of resources) {
    if (stafferId != null && resource.id !== stafferId) continue;
    const dayBlocks = [];
    for (const entry of resource.resource_time_slots || []) {
      if (entry.date === date) {
        dayBlocks.push(...(entry.time_slots || []));
      }
    }
    staff.push({
      staffer_id: resource.id,
      name: resource.name ?? null,
      times: expandBlocks(dayBlocks),
    });
  }

  return {
    business_id: businessId,
    variant_id: variantId,
    date,
    staff,
  };
}

async function searchBusinesses(args) {
  const query = args.query == null ? "" : String(args.query).trim();
  if (!query) throw new Error("Missing required argument: query");

  const params = {
    query,
    response_type: "listing_web",
    sort_order: "score",
    businesses_page: "1",
    businesses_per_page: "20",
    no_thumbs: "1",
    with_markdown: "1",
  };

  const location = args.location == null ? "" : String(args.location).trim();
  if (location) {
    try {
      const resolved = await apiGet("/search/street_hints/resolve/", { query: location });
      const locationId = resolved && resolved.location && resolved.location.id;
      if (locationId != null) params.location_id = locationId;
      else logErr(`Could not resolve location '${location}'; searching by query only`);
    } catch (err) {
      logErr(`Location resolve failed for '${location}': ${redact(err.message)}; searching by query only`);
    }
  }

  const data = await apiGet("/businesses", params);
  return (data.businesses || []).map(mapBusinessSummary);
}

async function getBusiness(args) {
  const businessId = asId(args.business_id, "business_id");
  const data = await apiGet(`/businesses/${businessId}`, {
    with_combos: "1",
    with_markdown: "1",
  });
  if (!data.business && data.id == null) {
    throw new Error(`Business ${businessId} was not found`);
  }
  return mapBusinessDetail(data);
}

async function getFreeSlots(args) {
  const businessId = asId(args.business_id, "business_id");
  const variantId = asId(args.service_variant_id, "service_variant_id");
  const date = String(args.date || "").trim();
  if (!DATE_RE.test(date)) {
    throw new Error("date must be YYYY-MM-DD");
  }
  const stafferId =
    args.staffer_id == null || args.staffer_id === "" ? null : asId(args.staffer_id, "staffer_id");

  const data = await apiGet("/me/bookings/time_slots/", {
    start_date: date,
    end_date: date,
    service_variant_id: variantId,
    business_id: businessId,
  });
  return mapDaySlots(data, businessId, variantId, date, stafferId);
}

function bookingMeta() {
  // Widget Ws(): after decamelize-keys this is app_version, booking_source,
  // platform, device_type. booking_source is the enum VALUE (Other_Integration),
  // not the key (other_integration).
  return {
    app_version: WIDGET_APP_VERSION,
    booking_source: "Other_Integration",
    platform: "web",
    device_type: "Desktop",
  };
}

function lastSubbooking(appointment) {
  const subs = appointment?.subbookings || [];
  return subs.length ? subs[subs.length - 1] : null;
}

function currentServiceVariantId(appointment) {
  const service = lastSubbooking(appointment)?.service;
  const id = service?.variant?.id ?? service?.variant_id;
  return id == null ? null : Number(id);
}

function confirmationPreview(confirmation, appointment, draftId) {
  const summary = (confirmation && confirmation.service_summary && confirmation.service_summary[0]) || {};
  const business = appointment?.business || {};
  const sub = lastSubbooking(appointment) || {};
  const staffer = sub.staffer || {};
  const total = (confirmation && confirmation.total_summary) || {};
  return {
    draft_id: draftId,
    business: confirmation?.business_info ?? business.name ?? null,
    service: summary.name ?? sub.service?.name ?? null,
    staffer: summary.staffer_info ?? staffer.name ?? null,
    date: confirmation?.raw_date ?? null,
    time: confirmation?.raw_time ?? null,
    time_range: summary.time_info ?? null,
    price: total.price ?? summary.price ?? appointment?.total ?? null,
    header: confirmation?.header ?? null,
    confirm_step: true,
  };
}

function padTime(value) {
  const text = String(value || "").trim();
  if (!TIME_RE.test(text)) throw new Error("time must be HH:MM");
  const [hours, minutes] = text.split(":");
  return `${hours.padStart(2, "0")}:${minutes}`;
}

function appointmentVersion(appointment) {
  if (!appointment || typeof appointment !== "object") return null;
  if (appointment._version != null) return appointment._version;
  if (appointment.version != null) return appointment.version;
  return null;
}

function unwrapAppointment(payload) {
  if (payload && payload.appointment && typeof payload.appointment === "object") {
    return payload.appointment;
  }
  return payload || {};
}

function stafferFromBooking(booking) {
  // Draft/detail appointments nest staff under subbookings[].staffer.
  // GET /me/bookings has no subbookings; the booked staffer is resources[]
  // with type "S" (Staff). service.staffer_ids is the service's allowed staff,
  // not the person on this appointment.
  const sub = lastSubbooking(booking) || {};
  const fromSub = sub.staffer || {};
  if (fromSub.id != null || fromSub.name || sub.staffer_id != null) {
    return { id: fromSub.id ?? sub.staffer_id ?? null, name: fromSub.name ?? null };
  }
  const resources = booking.resources || [];
  const staff =
    resources.find((resource) => resource && resource.type === "S") || resources[0] || {};
  return { id: staff.id ?? null, name: staff.name ?? null };
}

function mapBooking(booking) {
  const business = booking.business || {};
  const service = booking.service || {};
  const sub = lastSubbooking(booking) || {};
  const subService = sub.service || {};
  const staffer = stafferFromBooking(booking);
  return {
    appointment_uid: booking.appointment_uid ?? booking.coreId ?? booking.core_id ?? booking.id ?? null,
    booked_from: booking.booked_from ?? null,
    status: booking.status ?? null,
    business_id: business.id ?? null,
    business_name: business.name ?? null,
    service_name: service.name ?? subService.name ?? null,
    staffer_id: staffer.id ?? null,
    staffer_name: staffer.name ?? null,
    total: booking.total ?? null,
    version: appointmentVersion(booking),
  };
}

function normalizeBookingState(value) {
  const state = String(value || "").trim().toLowerCase();
  if (!state) return "";
  if (state === "upcoming") return "active";
  if (state === "finished" || state === "past") return "inactive";
  return state;
}

async function listMyBookings(args) {
  requireAccessToken();
  const page = args.page == null || args.page === "" ? 1 : asId(args.page, "page");
  const perPage = args.per_page == null || args.per_page === "" ? 20 : asId(args.per_page, "per_page");
  const params = { bookings_page: page, bookings_per_page: perPage };
  const state = normalizeBookingState(args.state);
  if (state) params.state = state;
  const data = await apiRequest("GET", "/me/bookings", { params, auth: true });
  const bookings = data.bookings || [];
  return {
    bookings: bookings.map(mapBooking),
    bookings_count: data.bookings_count ?? bookings.length,
  };
}

async function cancelBooking(args) {
  requireAccessToken();
  const appointmentId = args.appointment_id == null ? "" : String(args.appointment_id).trim();
  if (!appointmentId) throw new Error("Missing required argument: appointment_id");
  const encoded = encodeURIComponent(appointmentId);
  const detail = await apiRequest("GET", `/me/appointments/${encoded}/`, {
    params: { no_thumbs: "true", with_combos: 1 },
    auth: true,
  });
  const appointment = unwrapAppointment(detail);
  const version = appointmentVersion(appointment);
  if (version == null) {
    throw new Error("Could not read appointment _version needed to cancel");
  }
  const result = await apiRequest("POST", `/me/appointments/${encoded}/action/`, {
    body: { action: "cancel", _version: version, no_thumbs: "true" },
    auth: true,
  });
  return { cancelled: true, booking: mapBooking(unwrapAppointment(result)) };
}

async function createBooking(args) {
  requireAccessToken();
  const businessId = asId(args.business_id, "business_id");
  const variantId = asId(args.service_variant_id, "service_variant_id");
  const stafferId = asId(args.staffer_id, "staffer_id");
  const date = String(args.date || "").trim();
  if (!DATE_RE.test(date)) throw new Error("date must be YYYY-MM-DD");
  const time = padTime(args.time);
  const dryRun = args.dry_run !== false && args.dry_run !== "false";
  const meta = bookingMeta();

  // Widget create-B5acPUtf / routes Q(): POSTs business_id, service_variant_id,
  // staffer_id (or -1), optional booked_from (YYYY-MM-DD or YYYY-MM-DDTHH:MM), and meta.
  // booked_from does not pin the slot; change_timeslot does.
  let payload = await apiRequest("POST", "/drafts/create", {
    body: {
      business_id: businessId,
      service_variant_id: variantId,
      staffer_id: stafferId,
      booked_from: date,
      meta,
    },
    auth: true,
  });
  let appointment = unwrapAppointment(payload);
  const draftId = appointment.id;
  if (draftId == null) throw new Error("Booksy draft create did not return a draft id");

  if (currentServiceVariantId(appointment) !== variantId) {
    payload = await apiRequest("POST", `/drafts/${draftId}/add_service`, {
      body: { version: appointmentVersion(appointment), service_variant_id: variantId },
      auth: true,
    });
    appointment = unwrapAppointment(payload);
  }

  const sub = lastSubbooking(appointment);
  const currentStaffer = sub?.staffer?.id ?? sub?.staffer_id;
  if (sub?.id != null && currentStaffer !== stafferId) {
    payload = await apiRequest("POST", `/drafts/${draftId}/change_staffer`, {
      body: {
        version: appointmentVersion(appointment),
        subbooking_id: sub.id,
        staffer_id: stafferId,
      },
      auth: true,
    });
    appointment = unwrapAppointment(payload);
  }

  payload = await apiRequest("POST", `/drafts/${draftId}/change_timeslot`, {
    body: { version: appointmentVersion(appointment), slot: { d: date, t: time } },
    auth: true,
  });
  appointment = unwrapAppointment(payload);

  const confirmation = await apiRequest("GET", `/drafts/${draftId}/confirmation`, { auth: true });

  if (dryRun) {
    return {
      dry_run: true,
      confirmed: false,
      draft_id: draftId,
      confirm_step: true,
      preview: confirmationPreview(confirmation, appointment, draftId),
      confirmation,
      appointment: mapBooking(appointment),
      note: "Draft only. No appointment was confirmed. Call again with dry_run=false after the user confirms to schedule it.",
    };
  }

  payload = await apiRequest("POST", `/drafts/${draftId}/schedule`, {
    body: { meta },
    auth: true,
  });
  appointment = unwrapAppointment(payload);
  return {
    dry_run: false,
    confirmed: true,
    draft_id: draftId,
    appointment_uid: appointment.coreId ?? appointment.appointment_uid ?? appointment.id,
    appointment: mapBooking(appointment),
  };
}


const TOOLS = [
  {
    name: "search_businesses",
    description:
      "Search Booksy businesses (Brazil) by name or keywords. Optional location (city or place) is resolved to a location_id first. Returns compact BusinessSummary objects. Does not book.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Shop name or search keywords" },
        location: {
          type: "string",
          description: "Optional city or place hint, e.g. 'São Caetano do Sul'",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_business",
    description:
      "Get a Booksy business by id: address, services (variant_id, price, duration_min), and staff. Use after search_businesses. Does not book.",
    inputSchema: {
      type: "object",
      properties: {
        business_id: {
          description: "Booksy business id from search_businesses",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
      },
      required: ["business_id"],
    },
  },
  {
    name: "get_free_slots",
    description:
      "List free start times for a service variant on one date. Optional staffer_id is filtered client-side. Times are HH:MM, expanded inclusively from each {from,to,interval} block. Does not book.",
    inputSchema: {
      type: "object",
      properties: {
        business_id: {
          description: "Booksy business id",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
        service_variant_id: {
          description: "Service variant id from get_business",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
        date: { type: "string", description: "Date to check, YYYY-MM-DD" },
        staffer_id: {
          description: "Optional staffer id to narrow results (filtered client-side)",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
      },
      required: ["business_id", "service_variant_id", "date"],
    },
  },
  {
    name: "list_my_bookings",
    description:
      "List the logged-in customer's Booksy bookings. Requires BOOKSY_ACCESS_TOKEN. Optional state is 'active' (upcoming) or 'inactive' (finished). Not a booking write.",
    inputSchema: {
      type: "object",
      properties: {
        state: {
          type: "string",
          description: "Optional filter: active (upcoming), inactive (finished). 'upcoming' and 'finished' are also accepted.",
        },
        page: {
          description: "Page number, default 1",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
        per_page: {
          description: "Page size, default 20",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "create_booking",
    description:
      "WRITE action: create a Booksy booking for the logged-in customer. Confirm with the user before calling, and keep dry_run true until they approve the preview. Requires BOOKSY_ACCESS_TOKEN. dry_run (default true) builds a draft and returns the confirmation preview without scheduling; that still creates a temporary draft. dry_run=false calls POST /drafts/{id}/schedule and confirms a real appointment.",
    inputSchema: {
      type: "object",
      properties: {
        business_id: {
          description: "Booksy business id",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
        service_variant_id: {
          description: "Service variant id from get_business",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
        staffer_id: {
          description: "Staffer id from get_business",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
        date: { type: "string", description: "Appointment date, YYYY-MM-DD" },
        time: { type: "string", description: "Start time, HH:MM" },
        dry_run: {
          type: "boolean",
          default: true,
          description: "If true (default), preview only and do not confirm. If false, confirm the appointment.",
        },
      },
      required: ["business_id", "service_variant_id", "staffer_id", "date", "time"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "cancel_booking",
    description:
      "WRITE action, destructive: cancel an existing Booksy appointment. Confirm with the user before calling. Requires BOOKSY_ACCESS_TOKEN. appointment_id is the appointment_uid from list_my_bookings.",
    inputSchema: {
      type: "object",
      properties: {
        appointment_id: {
          description: "Appointment uid from list_my_bookings",
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
      },
      required: ["appointment_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
];

const TOOL_HANDLERS = {
  search_businesses: searchBusinesses,
  get_business: getBusiness,
  get_free_slots: getFreeSlots,
  list_my_bookings: listMyBookings,
  create_booking: createBooking,
  cancel_booking: cancelBooking,
};

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message: redact(message) } };
}

function toolResult(id, data) {
  return ok(id, {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  });
}

function toolError(id, message) {
  return ok(id, {
    content: [{ type: "text", text: redact(message) }],
    isError: true,
  });
}

async function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const requested = params && params.protocolVersion;
    return ok(id, {
      protocolVersion: requested || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === "notifications/initialized" || method === "initialized") {
    return null;
  }

  if (method === "ping") {
    return ok(id, {});
  }

  if (method === "tools/list") {
    return ok(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) {
      return toolError(id, `Unknown tool: ${name}`);
    }
    try {
      const data = await handler(args);
      return toolResult(id, data);
    } catch (err) {
      return toolError(id, err && err.message ? err.message : String(err));
    }
  }

  if (id === undefined) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function writeMessage(message, useContentLength) {
  const body = JSON.stringify(message);
  if (useContentLength) {
    stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  } else {
    stdout.write(`${body}\n`);
  }
}

function parseJsonMessage(raw, framing) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    writeMessage(rpcError(null, -32700, "Parse error"), framing === "content-length");
    return;
  }
  return message;
}

async function processMessage(raw, framing) {
  const message = parseJsonMessage(raw, framing);
  if (!message) return;
  if (message.method == null) return;
  try {
    const response = await handleRequest(message);
    if (response) writeMessage(response, framing === "content-length");
  } catch (err) {
    if (message.id !== undefined) {
      writeMessage(
        rpcError(message.id, -32603, err && err.message ? err.message : String(err)),
        framing === "content-length"
      );
    } else {
      logErr(redact(err && err.message ? err.message : String(err)));
    }
  }
}

function extractMessages(buffer) {
  const messages = [];
  let rest = buffer;

  while (rest.length) {
    const text = rest.toString("utf8");
    const headerMatch = text.match(/^(?:Content-Length:\s*(\d+)\r\n(?:.*\r\n)*\r\n)/i);
    if (headerMatch) {
      const size = Number(headerMatch[1]);
      const headerBytes = Buffer.byteLength(headerMatch[0], "utf8");
      if (rest.length < headerBytes + size) break;
      const body = rest.subarray(headerBytes, headerBytes + size).toString("utf8");
      messages.push({ raw: body, framing: "content-length" });
      rest = rest.subarray(headerBytes + size);
      continue;
    }

    // If a Content-Length header is still arriving, wait for more data.
    if (/^Content-Length:/i.test(text) || /^(?:Content-Length:|[A-Za-z][\w-]*:)/.test(text) && !text.includes("\n")) {
      break;
    }

    const nl = rest.indexOf(0x0a);
    if (nl === -1) break;
    const line = rest.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
    rest = rest.subarray(nl + 1);
    if (line) messages.push({ raw: line, framing: "newline" });
  }

  return { messages, rest };
}

async function main() {
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const extracted = extractMessages(buffer);
    buffer = extracted.rest;
    for (const item of extracted.messages) {
      queue = queue.then(() => processMessage(item.raw, item.framing));
    }
  });
  stdin.on("error", (err) => logErr(redact(err.message)));
  stdin.on("end", () => {
    queue.finally(() => process.exit(0));
  });
}

main();
