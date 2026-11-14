# Booksy MCP

Unofficial Model Context Protocol (MCP) server and [Agent Plugin](https://agent-plugins.org) for Booksy's customer API in Brazil (`br.booksy.com`). Search shops, list services and staff, check free slots, and — with a customer access token you supply — list, preview, confirm, or cancel bookings.

## Disclaimer

This is an unofficial, community-maintained project. It is **not affiliated with, endorsed by, or supported by Booksy**. It talks to Booksy's **undocumented web customer API**, which can break or change without notice. Use it at your own risk, and respect [Booksy's Terms of Service](https://booksy.com/en-us/p/terms).

Coverage is Brazil only. The `BOOKSY_COUNTRY` environment variable exists, but only `br` has been tested.

## Requirements

- **Node.js 18 or later** (the server uses the global `fetch` API and `AbortSignal.timeout`)
- **No npm dependencies** — run `node server.mjs` directly

## Install

Clone or copy this directory somewhere on your machine. In the snippets below, replace `/path/to/server.mjs` with the absolute path to `server.mjs` in that copy.

Account tools also need a customer access token (see [Getting a customer access token](#getting-a-customer-access-token)). Read-only search and availability tools work without one.

### Cursor

**Local plugin folder.** Copy this directory to `~/.cursor/plugins/local/booksy` (a real directory, not a symlink), then reload the window.

**Or** add a server in `.cursor/mcp.json` (project) or your Cursor user MCP config:

```json
{
  "mcpServers": {
    "booksy": {
      "command": "node",
      "args": ["/path/to/server.mjs"]
    }
  }
}
```

The plugin's own `mcp.json` uses a relative `./server.mjs` and `cwd: "${PLUGIN_ROOT}"`, as required by the Agent Plugins 1.0.0 schema. Clients that implement that schema set `PLUGIN_ROOT` for you. Cursor's plugin loader may use a different variable (`${CURSOR_PLUGIN_ROOT}`) and may not expand `${PLUGIN_ROOT}`; if a Cursor-local plugin install does not start, launch `node ./server.mjs` yourself with the plugin directory as the working directory, or use the `.cursor/mcp.json` snippet above with a concrete path.

### Claude Desktop

Add the server to `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "booksy": {
      "command": "node",
      "args": ["/path/to/server.mjs"]
    }
  }
}
```

Restart Claude Desktop after saving.

### Grok Bot

Add a custom MCP server with this command:

```text
node /path/to/server.mjs
```

### Other stdio MCP clients

The server speaks JSON-RPC 2.0 over stdin/stdout (newline-delimited JSON, or `Content-Length` framing). Point the client at:

```text
node /path/to/server.mjs
```

If the client supports an `env` map on the server entry, you may set `BOOKSY_ACCESS_TOKEN` there. Prefer the token file (below) so the token does not end up in a config file you might commit. Do not put tokens in this repository.

## Read tools (no login)

`search_businesses`, `get_business`, and `get_free_slots` use Booksy's public marketplace `x-api-key`. You do not need an account.

If `BOOKSY_API_KEY` is unset, the server scrapes the production `web-*` key from booksy.com JavaScript assets at runtime and caches it in a temp file for 24 hours. You can set `BOOKSY_API_KEY` to skip that scrape. Never print, commit, or paste that key.

## Getting a customer access token

Email/password login is not supported: Booksy requires an hCaptcha token on `POST /core/v2/customer_api/account/login`. Account tools therefore use a session token you copy from a browser session you already have.

The marketplace web app stores the token in a cookie named `identity-br` (that is `identity-` plus the country code) with `max-age` 31536000 seconds (365 days), `path=/`, `Secure`, and `SameSite=Lax`. On login, the app writes **only the raw access-token string** into that cookie — not the full `{ accessToken, profile }` object it keeps in memory.

The cookie helper URL-encodes the value (`encodeURIComponent`). For a typical token (letters and digits, no punctuation), the encoded form is identical to the raw token. The helper only JSON-wraps the value first when it is not a plain string, or when the string itself parses as JSON that is not a string (for example an object). On read, the app runs `decodeURIComponent` and then tries `JSON.parse`.

**The Network tab is the most reliable way to get the raw token**, because `x-access-token` is the header the API actually uses.

### 1. Log in

Open [booksy.com](https://booksy.com/pt-br/), sign in to your customer account, and stay on the site.

### 2. Copy the token

**Chrome or Edge (recommended: Network)**

1. Press F12 (or right-click the page → Inspect).
2. Open the **Network** tab. Filter by `customer_api/me`.
3. Click a request to `/core/v2/customer_api/me` (reload the page if none appear).
4. Under **Request Headers**, copy the value of `x-access-token`. That is the raw token.

**Chrome or Edge (Cookies)**

1. Press F12 → **Application** → **Cookies** → `https://booksy.com`.
2. Select the cookie named `identity-br`.
3. Copy its value, then:
   - If it is a bare token (no `%` sequences, no surrounding quotes or `{...}`), use it as-is. This is the usual case.
   - If it looks URL-encoded (`%22`, `%7B`, and so on), decode it first. In DevTools console: `decodeURIComponent("paste-the-cookie-value")`.
   - If the decoded value is JSON such as `{"accessToken":"..."}`, use the `accessToken` field.
   - If the decoded value is a quoted JSON string (it starts and ends with `"`), parse it: `JSON.parse("paste-the-decoded-value")`. The result is the raw token.

**Firefox**

1. Open Developer Tools (F12) → **Storage** → **Cookies** → `https://booksy.com`.
2. Select `identity-br` and extract the raw token with the same rules as above.
3. Or use the Network tab, filter `customer_api/me`, and copy `x-access-token` from the request headers.

**Safari**

1. Enable the Develop menu: Safari → Settings → Advanced → “Show features for web developers” (wording may be “Show Develop menu in menu bar” on older versions).
2. Develop → Show Web Inspector → **Storage** → **Cookies**.
3. Select `identity-br` on `https://booksy.com` and extract the raw token with the same rules as above.
4. Or use the Network tab and copy `x-access-token` from a `customer_api/me` request.

Do not commit the token, and do not paste it into chats or issues.

### 3. Where to put it

The server checks, in order:

1. **`BOOKSY_ACCESS_TOKEN`** in the environment (wins if set and non-empty)
2. **`BOOKSY_TOKEN_FILE`**, if you want a custom path
3. Otherwise **`~/.config/booksy/token`**

The file is re-read on every call, so you can replace the token without restarting the server.

```bash
mkdir -p ~/.config/booksy
# paste only the raw token, no quotes or JSON wrapper, then:
chmod 600 ~/.config/booksy/token
```

### Lifetime and rotation

The `identity-br` cookie is issued with a max-age of about **365 days**. There is **no refresh endpoint**. Logging out of Booksy may revoke the token. When it stops working, sign in again and copy a new one; replace the env var or token file, and delete the old value.

Treat the token like a password. Anyone who has it can act as you on Booksy (list, book, cancel). Never commit it, never paste it into chats or GitHub issues, and do not check it into `mcp.json` or shell history if you can avoid it.

## Optional fingerprint

The official booking widget always sends an `X-Fingerprint` header (a UUID, stored in the widget's `_bf` cookie). This server does the same:

- `BOOKSY_FINGERPRINT` if set
- otherwise `BOOKSY_FINGERPRINT_FILE`, or `~/.config/booksy/fingerprint`
- otherwise it generates a UUID and tries to save it at that path

You usually do not need to set this yourself.

## Other environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `BOOKSY_COUNTRY` | `br` | API host `{country}.booksy.com`. Only `br` is tested. |
| `BOOKSY_LOCALE` | `pt-BR` | `Accept-Language` |
| `BOOKSY_API_KEY` | (scraped) | Override the public marketplace key |
| `BOOKSY_CACHE_DIR` | a temp dir | Where the scraped key cache is stored |
| `BOOKSY_FETCH_KEY` | (enabled) | Set to `0` to disable the JS scrape |
| `BOOKSY_APP_VERSION` | `1.213.0` | Sent as `X-App-Version` / `meta.app_version` (widget shape) |
| `BOOKSY_UA` | a Chrome desktop UA | HTTP `User-Agent` |

The Agent Plugins 1.0.0 manifest schema has no `variables` field, and `mcp.json` `env` will not expand arbitrary `${ENV}` placeholders, so these are not declared in the manifests. Set them in the environment inherited by the process.

## Tools

Write tools (`create_booking`, `cancel_booking`) must be **confirmed with the user** before they are called.

### `search_businesses`

No auth. Search Booksy businesses in Brazil.

- `query` (string, required) — shop name or keywords
- `location` (string, optional) — city or place hint (resolved to a location id first)

Returns compact `BusinessSummary` objects: `id`, `name`, `address`, `city`, `rating`, `reviews_count`, `url`.

### `get_business`

No auth. Details for one shop.

- `business_id` (required) — id from `search_businesses`

Returns `BusinessDetail`: address, `services` (each with `variants`: `variant_id`, `price`, `duration_min`), and `staff` (`staffer_id`, `name`).

### `get_free_slots`

No auth. Free start times for one service on one date.

- `business_id` (required)
- `service_variant_id` (required) — from `get_business`
- `date` (required) — `YYYY-MM-DD`
- `staffer_id` (optional) — filtered client-side; the upstream query does not narrow the payload

Returns `DaySlots` with start times `HH:MM`. Availability can change before you book; treat this as a snapshot.

### `list_my_bookings`

Requires a customer access token. Lists the logged-in customer's bookings.

- `state` (optional) — `active` (upcoming) or `inactive` (finished). `upcoming` and `finished` / `past` are also accepted.
- `page` (optional, default 1)
- `per_page` (optional, default 20)

Returns compact appointment objects (`appointment_uid`, `booked_from`, `status`, business, service, staffer, `total`).

### `create_booking`

**WRITE.** Confirm the shop, service, staff, date, and time with the user first.

- `business_id` (required)
- `service_variant_id` (required)
- `staffer_id` (required)
- `date` (required) — `YYYY-MM-DD`
- `time` (required) — `HH:MM`
- `dry_run` (optional, **default `true`**)

When `dry_run` is `true` (the default), the server creates a **temporary draft**, sets the service, staffer, and timeslot, and returns the confirmation preview (`GET /drafts/{id}/confirmation`). It does **not** call `/schedule`, so no appointment is confirmed. When `dry_run` is `false`, it goes on to `POST /drafts/{id}/schedule` and confirms a real appointment.

Keep `dry_run=true` until the user has seen the preview and explicitly asks you to book. Then call again with the same arguments and `dry_run=false`.

### `cancel_booking`

**WRITE, destructive.** Confirm with the user first. This cancels a real appointment and cannot be undone from this plugin.

- `appointment_id` (required) — the `appointment_uid` from `list_my_bookings`

## Limits

- No email/password login (hCaptcha is required on that endpoint).
- Slots from `get_free_slots` are live and can disappear before `create_booking` runs.
- Be polite with request volume; this is a personal automation client, not a scraper.
- Bookings created through this plugin are attributed with `booking_source` **Other_Integration**.
- The API is undocumented and may change. Brazil (`br`) is the only tested region.

## Example (public shop ids)

The ids below are from a **public** Booksy shop listing and are shown only as an example. They are not a recommendation, and they may change. Always search and read the live shop before booking.

Example shop: **Brabo Barbearia**, `business_id` `103441` (São Caetano do Sul).

1. `search_businesses` with `query` `"Brabo Barbearia"` and `location` `"São Caetano do Sul"`
2. `get_business` with `business_id` `103441`
3. `get_free_slots` with that `business_id`, a `service_variant_id` from the shop (example: `1421878` for Combo), a date such as `2026-11-20`, and optionally a `staffer_id` (example: `230915`)
4. `create_booking` with the same ids, date, and time (example: `"14:00"`), leaving `dry_run` true
5. Only after the user approves the preview, call `create_booking` again with `dry_run=false`

## License

MIT. See [LICENSE](./LICENSE).
