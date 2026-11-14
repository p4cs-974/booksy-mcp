---
name: booksy
description: >-
  Use when finding barbers, salons, or other shops on Booksy (Brazil,
  booksy.com / br.booksy.com), listing their services, prices, and staff,
  checking free slots, listing the user's bookings, or creating or cancelling
  a booking after the user confirms.
---

# Booksy

Use the `booksy` MCP tools to look up shops and availability, and (when a
customer access token is configured) to list, preview, confirm, or cancel
bookings. Do not invent ids, prices, or times; call the tools.

This connector is unofficial and not affiliated with Booksy. It uses an
undocumented web customer API that can change. Brazil only (`BOOKSY_COUNTRY`
exists but is only tested for `br`).

## When to use

- Find a barber, salon, or other Booksy business by name and (optionally) city
- List services, variant ids, prices, durations, and staff for a shop
- Check free start times on a given date, optionally for one staff member
- List the user's existing bookings
- Preview or confirm a booking, or cancel one, after the user agrees

## Tools

1. `search_businesses` — `query` (shop name or keywords), optional `location`
   (city or place). Returns `BusinessSummary` objects.
2. `get_business` — `business_id` from search. Returns `BusinessDetail`
   (services with `variant_id` / `price` / `duration_min`, plus staff).
3. `get_free_slots` — `business_id`, `service_variant_id`, `date` (`YYYY-MM-DD`),
   optional `staffer_id`. Returns `DaySlots` with start times `HH:MM`.
4. `list_my_bookings` — optional `state` (`active`/`upcoming` or
   `inactive`/`finished`). Requires a customer access token.
5. `create_booking` — WRITE. Confirm with the user first. Args: `business_id`,
   `service_variant_id`, `staffer_id`, `date`, `time`, `dry_run` (default true).
   Keep `dry_run` true until the user approves the preview; only then call
   with `dry_run=false` to schedule. A dry run still creates a temporary draft
   and does not confirm the appointment.
6. `cancel_booking` — WRITE, destructive. Confirm with the user first.
   `appointment_id` is the `appointment_uid` from `list_my_bookings`.

Typical read flow: search → pick a shop → get business (choose service + staff)
→ get free slots for a date in the next few days.

## Auth

Account tools read a Booksy customer access token (`x-access-token`) from
`BOOKSY_ACCESS_TOKEN` if set, otherwise from `BOOKSY_TOKEN_FILE` or
`~/.config/booksy/token`. The user must supply it; do not scrape tokens or
cookies from a browser. Email/password login is not available because Booksy
requires an hCaptcha token on that API. If the token is unset, the account
tools return a "not configured" error.

## Optional environment

- `BOOKSY_API_KEY` — override the public marketplace `x-api-key`. If unset, the
  server scrapes the production web key from booksy.com JS assets at runtime
  and caches it in a temp file. Do not print or commit that key.
- `BOOKSY_ACCESS_TOKEN` / token file — customer session token for account tools.
- `BOOKSY_FINGERPRINT` or `~/.config/booksy/fingerprint` — optional
  `X-Fingerprint` UUID (the server generates and persists one if missing).
- `BOOKSY_COUNTRY` — default `br` (only tested for Brazil).
- `BOOKSY_LOCALE` — default `pt-BR`.
