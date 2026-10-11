# CP-Codes

A basic public pastebin / document store. Pastes are identified by short **CP-Codes**
(e.g. `CP0A1B2C`). No accounts — uploads are gated by a **SHA-256** proof of
work instead.

- AI-cleared innocuous text is available to its uploader and three other IPs; wider traffic requires human review
- No registration or email required to publish (reporters may optionally provide a contact email)
- Public distribution/listing requires human approval; unlisted is the browser default
- Up to 16 named files per paste, 8 MiB inflated total; Markdown supports sibling images and links
- Browser-side gzip compression, decompression, content detection, Markdown/image rendering, and URL handling
- Every upload burns a single-use SHA-256 PoW challenge (base: 65,536 attempts on average; ~45,426 for a 50% chance)
- The verified proof and submitting request metadata are retained with each paste; proof details are public, while public responses never expose request metadata

https://cp.codes is **not** a free-speech platform. Operators delete content they don't
want. Access logs may be provided to law enforcement; content is removed on legal request.

Use cases: transferring small files between computers, sharing notes/code/documents with a few people, and human-approved public notices.

**Redesign policy/API/deployment details:** [doc/REDESIGN.md](doc/REDESIGN.md). In particular, Jev cannot inspect media: media is supported but requires human review. Cost coefficients are estimates; production needs a matching R2 retention policy and real staff credentials.

## Local development

```bash
npm install
cp .dev.vars.example .dev.vars # set DEFAPI_KEY; development staff fixtures are opt-in
make dev          # wrangler dev → http://localhost:8787
```

Browser assets use `Cache-Control: public, max-age=31536000, immutable`
when their URL matches the current version in `src/assets.ts`. Pinned vendor
libraries under `public/lib/` use versioned filenames and the same policy.
Development hosts use the same policy as production. Unversioned or outdated
asset URLs revalidate instead. HTML, API responses, and paste contents keep their
existing cache policies. During development, bump asset versions or enable the
browser's DevTools **Disable cache** option to see edits to cached assets.

When editing a browser asset, bump its entry in `CLIENT_ASSET_VERSIONS`, update
the version in every client import, and bump each importing module's version as
well, continuing through its importers. Server-generated URLs and preloads use
`assetUrl()` to read the registry. `scripts/assets.test.mjs` checks that every
application JS/CSS file is registered, client references agree with the registry,
and both Worker asset routes apply the cache policy. No client build step is needed.

The shared `public/style.css` and `public/site.js` files are imported as text by
`src/ui.ts` during Worker bundling and embedded in each HTML response. Edit those
public files directly; their contents are not duplicated in the template. The CSS
is in the head, and the script initializes the parsed shell before page modules.

Staff navigation is rendered by `site.js` from a readable, eight-hour cookie hint
set after login and cleared on logout or a rejected staff session. It contains only
`1`, never the session token. Public page headers do not authenticate requests;
staff endpoints and paste access checks still use the HttpOnly session cookie.
Changing the hint only changes which links appear. Existing sessions created
before this hint was introduced gain it on their next login.

Optional PoW tuning (also settable in `wrangler.jsonc` `vars`):

|        Variable       | Default |                        Meaning                        |
|-----------------------|---------|-------------------------------------------------------|
| `POW_DIFFICULTY_BITS` | `16`    | Base leading zero bits required on the SHA-256 digest |
| `STAFF_ALLOW_DEVELOPMENT_LOGIN` | `false` | Enable known fixture accounts for local development only |
| `DEFAPI_KEY` | secret | DefAPI moderation credential |
| `STAFF_CREDENTIALS` | secret | Salted production staff-password hashes |

Each search iteration computes one SHA-256 digest. Success probability per attempt
is `2^-difficulty`; at the base difficulty, work is 65,536 attempts on average
and ~45,426 attempts for a 50% chance. Expected work scales with estimated upload
cost (rounded up to a power of two), plus logarithmic global/per-IP congestion
adjustments. Eight-character CP-Codes also add a configurable increment, defaulting to one bit, for each short ID already consumed by the requester's region in its current five-minute tick. That pressure continues after the 16-ID counter rolls into the next timestamp. Hard limits bound bytes, challenge issuance, and admitted cost.
Redemption atomically checks the current price and reserves the budget before
inflation or paid moderation; cheaply prefetched proofs cannot bypass it.
See the formula, assumptions and limits in [doc/REDESIGN.md](doc/REDESIGN.md). The browser splits non-overlapping nonce
ranges across a Web Worker pool sized from the available logical CPU cores (up to
16 workers). Each worker uses native Web Crypto when available and lazily loads a
WebAssembly SHA-256 fallback otherwise. The server uses its native Web Crypto implementation and verifies a proof with
one digest. Challenges are authenticated but not persisted: a Durable Object
generates and stores one HMAC key, and each Worker isolate retrieves and caches
that immutable key. Issuance counters, single-use redemptions and cost admissions
are durable; failed admitted attempts still consume budget.

During proof search, the browser shows elapsed time and a live 50% proof-time
estimate based on the combined workers' reported attempt rate. Actual and median
attempt/time columns are right-aligned for comparison. The estimate is a median
total search time, not a countdown or a guaranteed completion time. Both times
always use three significant digits (including trailing zeros) and scale to seconds/minutes/hours/days
(`s`/`m`/`h`/`d`). Estimated time also scales to weeks (`w`, seven days) and
years (`y`, approximately 365 days).

Fast local iteration:

```bash
npx wrangler dev --var POW_DIFFICULTY_BITS:1
```

## Python CLI

`scripts/paste.py` requires Python 3.9+ and no third-party packages. It reads a
text or binary file (or stdin), encodes binary content as a base64 data URL,
hashes and gzips the resulting UTF-8 body, requests a signed challenge, solves
the SHA-256 proof, and uploads the paste. Required flag
`--consent-all` explicitly agrees to the service collecting and retaining your
IP/location metadata and sending paste text and filename to
DefAPI/TypeSafe for automated moderation.

```bash
python3 scripts/paste.py --consent-all hello.txt
printf 'Hello from stdin\n' | python3 scripts/paste.py --consent-all
python3 scripts/paste.py --consent-all --content-type markdown --unlisted note.md
python3 scripts/paste.py --consent-all --json hello.txt > paste-result.json
python3 scripts/paste.py --consent-all --base-url http://localhost:8787 hello.txt
python3 scripts/paste.py --consent-all photo.png
python3 scripts/paste.py --consent-all photo.webp
python3 scripts/paste.py --consent-all animation.gif
python3 scripts/paste.py --consent-all recording.mp3
python3 scripts/paste.py --consent-all video.mp4
python3 scripts/paste.py --consent-all archive.zip
cat archive.zip | python3 scripts/paste.py --consent-all --binary --filename archive.zip
```

The default output is the paste URL on stdout; progress, the passcode/passphrase,
and moderation warnings go to stderr. `--json` returns the full API response
(including the authorization credentials) on stdout. Keep that response private. Unlisted
pastes stay outside the feed, but are not secret storage. AI-cleared text has a limited
IP audience; unsupported or uncertain content is held for human review.

Text content defaults to `plaintext`; use `--content-type` for Markdown, code,
URLs, or already encoded media data URLs. Raw PNG/JPEG/WebP/GIF, MP3, and MP4 files
are detected by signature, encoded as data URLs, and assigned the matching type.
GIF animation is preserved; MP3/MP4 pastes have audio/video playback controls.
Playback depends on the browser's codec support. Media uploads are held for staff
review because automated moderation currently supports text only.
Other binary input (invalid UTF-8, NUL bytes, or more than eight non-text control
bytes in the first 4096 bytes) is encoded as an `application/octet-stream` data URL
with content type `plaintext`. Use `--binary` to force encoding even for input
that looks like text. Unsupported binary formats cannot use a non-plaintext content type.
Empty files are rejected.

Binary pastes are stored as encoded text, not raw file downloads. To restore a
file, base64-decode the data URL's contents after the first comma. Hashes, sizes,
and proof-of-work costs use the encoded body; base64 adds roughly one-third to
the original size. UTF-8 text is preserved byte-for-byte.

The input file's basename becomes the public filename; `--filename` overrides
it (use `--filename ''` to omit it).
HTTP requests time out after 60 seconds and proof searches after 120 seconds per
challenge; override with `--timeout` and `--pow-timeout`. An expired/rejected proof
is retried once with a fresh challenge; ambiguous network failures are not retried.

Run CLI tests with:

```bash
python3 -m unittest discover -s scripts -p 'test_paste.py'
```

## API

### `POST /api/challenge`

```json
{ "content_hash": "<sha256 hex of utf-8 body>", "byte_length": 123 }
```

Returns:

```json
{
  "version": 2,
  "requester_hash": "<issuer IP digest>",
  "challenge_id": "…",
  "nonce": "<random hex>",
  "difficulty": 16,
  "content_hash": "…",
  "byte_length": 123,
  "algorithm": "sha256",
  "created_at": 0,
  "expires_at": 0,
  "expected_attempts_p50": 45426,
  "signature": "<base64url HMAC-SHA-256>"
}
```

### `POST /api/paste`

```json
{
  "content_gzip": "H4sIAAAAA…",
  "compression": "gzip",
  "content_type": "plaintext",
  "filename": "hello.txt",
  "unlisted": false,
  "consent": true,
  "consent_moderation": true,
  "challenge": {
    "version": 2,
    "requester_hash": "…",
    "challenge_id": "…",
    "nonce": "…",
    "difficulty": 16,
    "content_hash": "…",
    "byte_length": 5,
    "algorithm": "sha256",
    "created_at": 0,
    "expires_at": 0,
    "expected_attempts_p50": 45426,
    "signature": "…"
  },
  "solution": "<decimal counter that satisfies difficulty>",
  "pow_hash": "<sha256 hex>"
}
```

Hash input: `"{content_hash}:{challenge_id}:{nonce}:{solution}"`

The server first authenticates `challenge`, then checks that
`pow_hash` is the SHA-256 digest of that input and has ≥ `difficulty` leading
zero bits. It decodes `content_gzip` from base64 and decompresses it exactly once,
rejecting output beyond the signed `byte_length`. That one decompressed buffer is
used to verify the UTF-8 content length and SHA-256 hash and to create the recent-list
preview. After verification, Jev assesses the text and public descriptive metadata before
the original gzip bytes are published to R2. The initial visibility and machine
assessment are persisted first, so flagged content is never briefly exposed while
classification runs. The challenge is redeemed after a valid proof and current-price check, before
inflation and moderation; unsuccessful admitted payloads still consume cost budget. If the server rejects
a proof as invalid, expired, or already used, the browser requests one fresh
challenge and solves it again before reporting an error. A successful response
also includes a unique server-generated `passcode` and its equivalent `passphrase`.
The passcode is 16 hex characters (eight random bytes); each byte indexes one of
the 256 words in `public/wordlist.js`, producing an eight-word phrase. Only the
passcode is stored server-side, in a private SQLite table with a uniqueness
constraint. Neither credential appears in public reads, listings, staff metadata,
R2 custom metadata, or moderation requests. These credentials have no expiry.
Public reading continues to follow the existing moderation and sharing policy.

The browser saves both credentials under `cp.codes.authorization.v1:<ID>` in
local storage. Only the passphrase is displayed, as a compact two-row, four-column
preformatted grid below the paste content, using eight asterisks per word until
clicked (or activated with Enter or Space) to reveal it. Without a saved credential,
the yellow padlock opens an authorization dialog. Anyone with either credential
can permanently delete the paste. Keep a separate copy if browser storage may be
cleared. Existing pastes without a passcode retain their read behavior and can
still be deleted by staff; expired legacy deletion tokens cannot claim them.

`content_type` must be the client's resolved type: `plaintext`, `url`, `markdown`,
`png`, `jpeg`, `webp`, `gif`, `mp3`, `mp4`, `javascript`, `typescript`, `python`, `java`, `json`, `html`, `css`, `shell`, `sql`,
`yaml`, `xml`, `c`, `cpp`, `csharp`, `go`, `rust`, `ruby`, or `php`. `filename` is optional, and `unlisted` defaults to `false`. Both `consent`
(collection/storage of IP and location) and `consent_moderation` (automated
processing with DefAPI/TypeSafe) must be `true`; missing, false, or non-boolean
consents are rejected with HTTP 403. The browser's auto mode uses the filename extension when supplied and
otherwise inspects the content. File selection, drag-and-drop, and clipboard paste
accept UTF-8 files plus signature-checked PNG/JPEG/WebP/GIF images and MP3/MP4 media.
Media is converted to a base64 data URL (`image/png`, `image/jpeg`, `image/webp`,
`image/gif`, `audio/mpeg`, or `video/mp4`) before hashing, compression, and upload.
Markdown/image rendering, audio/video playback, and the external-URL warning for unreviewed
URL pastes are implemented in the browser. Once staff approve a URL paste, the
server validates its HTTP(S) target and serves its canonical CP-Code as a temporary
redirect.

Listed pastes use short version 0 CP-Codes and appear in recent uploads **after human
approval**. Unlisted pastes use longer version 2 CP-Codes and stay outside the feed.
Both use the same limited-sharing/moderation gates. Unlisted is not access authentication.

For multi-file pastes, use the [`bundle-v1` container API](doc/REDESIGN.md#multi-file-api).
The composer provides named files and main-document selection. Published pastes support sibling references.

Each successful upload privately retains `cf-connecting-ip`, `x-real-ip`, and
`cf-ipcountry`, plus Cloudflare's `asn`, `asOrganization`, `country`,
`isEUCountry`, `city`, `continent`, `region`, `regionCode`, `timezone`,
`longitude`, `latitude`, and `postalCode` request properties. Missing properties
are stored as null. Full metadata is retained in SQLite, not duplicated into R2's
size-limited custom metadata, and is excluded from public paste, recent-upload and
creation responses. Only the trusted edge IP is used for access admission. `GET /client-info` displays the values that
would be retained for the current request.

### `POST /api/paste/:id/authorize`

Verify a credential before saving it in another browser. Accepts either
`passcode` or `passphrase`, returning `{ "authorized": true, "id": "…" }`.
Hex codes and phrases are case-insensitive; phrases accept whitespace or hyphens
between words. Attempts are rate limited per IP. The endpoint does not change
public reading or moderation state.

### `DELETE /api/paste/:id`

Delete a paste at any time by submitting either credential in the JSON body:

```json
{ "passcode": "<passcode returned by POST /api/paste>" }
```

Alternatively submit `{ "passphrase": "<eight-word phrase>" }`.
The paste view shows a delete button when this browser has a saved passcode.
Deletion removes the R2 body and
sets the PasteIndex visibility to `deleted`; the paste metadata is retained for the
audit trail.

### `POST /api/paste/:id/report`

Report a paste as suspected illegal content. Both fields are optional:

```json
{
  "category": "copyright infringement",
  "email": "reporter@example.com"
}
```

Available categories are `copyright infringement`, `CSAM`, `terrorism or violent
extremism`, `threats or harassment`, `personal information`, `malware or phishing`,
`spam`, and `other illegal content`. Reports and contact emails are visible only to
authenticated staff.

PasteIndex stores four separate concerns: retained paste records, immutable user
report events, the current moderation state, and the initial automated assessment.
The moderation state can be initialized by Jev and subsequently overridden by staff. A moderation state has a
`decision` (`unreviewed`, `approved`, or `restricted`), `visibility` (`visible`,
`hidden`, or `deleted`), an optional staff classification reason, and the username
and timestamp of the most recent moderator. It also records the highest report id
covered by that action, so a later report reliably returns the paste to the pending
queue without overwriting the prior staff decision.

Hidden pastes disappear from public views and listings. Every paste read route checks
visibility before returning metadata or content; a hidden paste is available only
when the request has a valid staff session cookie or Basic `Authorization` header.
Merely supplying an invalid cookie or header does not grant access. Deleted pastes have no content body and cannot
be restored; retained metadata includes the original upload metadata.

### Automated upload moderation

Every valid listed or unlisted upload is assessed after PoW/content verification,
before its body is made available. `src/jev.mjs` shares the request, response
validation, and byte limit with the CLI. Uploads wait for the assessment (a
10-second request timeout); no paid requests are made for invalid uploads, and
there are no automatic retries or background jobs.

|                                   Result                                  |                       Initial moderation                      |
|---------------------------------------------------------------------------|---------------------------------------------------------------|
| `spam`, `phishing`, `csam`, or `unsafe` | `restricted` + `hidden`, using a corresponding reason |
| Benign category, aggregate harmful score ≤ 0.01, current prompt | `unreviewed` + `visible`, **limited sharing only** |
| Higher harmful score, API error/missing key, or invalid response | `unreviewed` + `hidden`, pending staff review |
| Image or body over the 248,000-byte single-request cap                    | `unreviewed` + `hidden`, pending staff review                 |

This seven-category assessment is not a certification of legality. Model scores are
not calibrated probabilities. URL **text** is assessed, not its destination; Jev
never marks a paste staff-approved or enables an automatic URL redirect. Image
moderation is unsupported by the documented API. Oversized bodies are retained
intact, not truncated or chunked. Staff can inspect, approve, restrict/hide or delete held pastes. Wider audiences
and exceeded traffic budgets also create review tasks without synthetic user reports.

The new `paste_automoderation` SQLite table retains the assessment JSON (model,
prompt version, timestamp, category, all probabilities, confidence, usage, billing,
status, and sanitized diagnostic), whether review is required, and the reviewing
staff identity/timestamp. It never creates synthetic user reports. The default
`/admin/pastes` pending queue includes both unacknowledged machine-review tasks and
new user reports. A staff action acknowledges the machine task without changing
the original assessment; a later user report still returns the paste to pending.
Assessments are exposed only in authenticated staff responses/pages.

`POST /api/paste` adds a `moderation` object with `visibility`, `requires_review`,
and `assessment_status`. For held uploads the browser stays on the upload form and
shows the assigned ID and review notice instead of navigating to an unavailable
paste. Old prompt assessments no longer grant limited sharing and reopen the review queue;
existing human approval remains valid. The CLI remains read-only.

**Worker key setup:** the CLI shell's `DEFAPI_KEY` is not automatically a Worker
binding. Copy `.dev.vars.example` to `.dev.vars`, set `DEFAPI_KEY` there, and restart
`make dev`. Do not commit this file. For production, set the secret interactively:

```bash
npx wrangler secret put DEFAPI_KEY
```

`wrangler.jsonc` declares the required secret name, not its value. If it is missing
at runtime, new uploads remain hidden for staff review. Local uploads also call the
real, paid DefAPI service. Only text, filename, and content type are
sent; private IP/location/upload audit metadata and PoW are not sent. The upload
separate moderation consent notice discloses this third-party processing.

### Read

Hit counts, audience IP persistence, traffic accounting, and access-log writes run
in `waitUntil` background work after response-path reads finish. Responses use a
hit-count snapshot that can lag the current request. Limited-sharing admission
reserves audience slots and traffic budgets synchronously in memory before serving
content, so concurrent requests include pending reservations. Background failures
are logged without failing a served response; pending reservations can be lost if
the Durable Object restarts before persistence finishes.

A successful `GET` increments a paste's hit count only when it loads the content:
raw responses count in the background, while an HTML view counts when its browser fetches
the content endpoint. An approved URL paste instead returns `302 Found` from its
canonical CP-Code path and increments the hit count with that redirect. Access-log
entries record their timestamp, IP address, Cloudflare location fields, HTTP
`Referer`, and whether the access was an HTML view, JSON metadata request, raw
response, direct compressed-content request, or redirect. Browser HTML requests are logged
separately from hit counting so their original external Referer is retained; their
follow-up content fetch is not logged twice. Initial HTML and JSON metadata requests do not count, and
`HEAD` reports the current count without incrementing it. The HTML response contains
metadata and a loading shell but no paste body. Browser JavaScript fetches the gzip
object, decompresses it, verifies its uncompressed length and SHA-256 hash, and then
renders plaintext/code, Markdown, PNG/JPEG/WebP/GIF images, MP3/MP4 players, or the URL warning for a URL
that has not been approved. The viewer switches bundle files locally after a single
verified download. Multiple files appear as tabs above the content; the selected
filename stays readable while other tabs share the remaining width. Copied links
include a `#file-<URL-encoded filename>` fragment to reopen the selected file.
Copying an image writes PNG image data to the clipboard, not its base64 text;
JPEG/WebP/GIF images are converted at their original resolution. GIF animation is
not copied. Image copying requires browser support and clipboard permission;
otherwise save the displayed image instead. Text copying is unchanged.
Content is always re-fetched/reauthorized on a new visit; only
QR images remain cached. This prevents stale content-cache authorization bypasses. JSON metadata exposes `content_url`,
`content_encoding`, and both compressed and
uncompressed lengths instead of embedding the plaintext content.

|                          Path                          |                                                Result                                               |
|--------------------------------------------------------|-----------------------------------------------------------------------------------------------------|
| `GET /`                                                | New-paste UI                                                                                        |
| `GET /about`                                           | Service information                                                                                 |
| `GET /client-info`                                     | IP, network, and location values retained with an upload                                            |
| `GET /pastes?page=1`                                   | Public approved/listed archive, newest first, 50 pastes per page with Previous/Next navigation |
| `GET /new`                                             | New-paste UI                                                                                        |
| `GET/POST /login`                                      | Staff login form / create a browser session                                                          |
| `POST /logout`                                        | Revoke the current browser session and clear its cookie                                              |
| `GET /CP………`                                           | `302` redirect for approved URL pastes; otherwise HTML view (browsers) or decompressed raw response |
| `GET /CP……….<ext>`                                     | Decompressed raw response at its type-specific extension                                            |
| `GET /api/paste/CP………`                                 | JSON metadata                                                                                       |
| `GET /api/paste/CP………/content`                         | Exact stored gzip bytes (single file or bundle container) |
| `GET /CP………/files/:name[?download]` | Decoded bundle file under the same access gate |
| `GET /api/pastes?limit=40`                             | Recent uploads (newest first, preview, hit count, and PoW difficulty)                               |
| `POST /api/paste/CP………/authorize`                      | Verify a passcode/passphrase before saving browser authorization                                    |
| `DELETE /api/paste/CP………`                              | Delete using a passcode/passphrase at any time while retaining metadata                             |
| `POST /api/paste/CP………/report`                         | Report suspected illegal content with an optional category and email                                |
| `GET /admin/reports`                                   | Redirect to the review panel filtered to all reported pastes                                        |
| `GET /admin/users`                                     | Staff account list                                                                                  |
| `GET /admin/pow`                                       | Current PoW difficulty and admin-only minimum difficulty controls                                    |
| `GET/PATCH /api/admin/pow`                             | PoW difficulty state / update the minimum (admin only for writes)                                    |
| `GET /admin/access-log?limit=100&before_id=…`          | Paginated paste access log                                                                          |
| `GET /admin/pastes?reports=pending&limit=100&offset=…` | Filterable moderation review panel                                                                  |
| `GET /admin/paste/CP………/view`                          | Authenticated content viewer, including hidden/restricted pastes                                    |
| `GET /admin/paste/CP………/raw`                           | Authenticated decompressed content                                                                  |
| `GET /admin/paste/CP………/content`                       | Authenticated stored representation for the viewer                                                  |
| `GET /api/admin/reports?limit=100`                     | Authenticated immutable report events with retained metadata                                        |
| `GET /api/admin/paste/CP………`                           | Authenticated moderation state and retained metadata                                                |
| `PATCH /api/admin/paste/CP………`                         | Apply a moderation action and record the authenticated moderator                                    |
| `GET /api/admin`                                       | Authenticated full paste metadata and user list (JSON)                                              |
| `GET /api/admin/users`                                 | Authenticated staff user list (JSON)                                                                |
| `GET /api/admin/access-log?limit=100&before_id=…`      | Authenticated paginated access log (JSON)                                                           |

### Staff interface

Browser staff login uses `/login` and a server-side session cookie. Anonymous
staff-page requests redirect there and return to the requested local page after
login. Public pages such as `/pastes` and `/about` recognize the same session and
show staff navigation plus a **log out** button. `POST /logout` revokes the session
in storage, not merely in the browser; `GET /logout` does not log anyone out.

Sessions have a fixed eight-hour lifetime, rotate on successful login, and survive
Worker restarts. HTTPS uses a host-only `__Host-cp_session` cookie with `Secure`,
`HttpOnly`, `SameSite=Lax`, and `Path=/`. Loopback HTTP development (`localhost`,
`127.0.0.1`, or `[::1]`) uses a host-only `cp_session` cookie without `Secure`;
non-loopback staff login requires HTTPS. `StaffSession` uses a SQLite-backed
Durable Object per hashed token, storing only the username and expiry, never the
raw bearer token. Storage alarms clean up expired sessions; authentication rejects
expired sessions even before cleanup. The new `STAFF_SESSIONS` binding and `v5`
migration are included in `wrangler.jsonc` and apply on normal deployment.

Cookie-authenticated mutations, login, and logout require same-origin Fetch
Metadata or Origin headers. Login accepts only bounded URL-encoded forms and
allows ten submissions per IP per ten minutes. Personalized pages use
`Cache-Control: no-store, private` and `Vary: Cookie, Authorization`; `/debug`
redacts Cookie and Authorization values. Basic Auth remains supported for explicit
CLI/API requests; unauthenticated CLI calls receive a `401` Basic challenge on
`/api/admin/*` routes, while browser fetches receive `401` without a password popup.
A valid session takes precedence over any Basic header. Log out revokes cookies,
not independently supplied Basic credentials.

Development fixtures (`admin` / `4dm1n`, `moderator` / `hunter2`) require an explicit
`STAFF_ALLOW_DEVELOPMENT_LOGIN=true` override. The deployed default is **false**.
Production requires the `STAFF_CREDENTIALS` secret with salted PBKDF2 hashes;
[generate/provision credentials](doc/REDESIGN.md#staff-credentials--deployment) using
`scripts/staff_credentials.py`. Missing/malformed production credentials fail closed.
Production Basic Auth also consumes login-attempt limits; use sessions for repeated review. Both roles can inspect every listed and unlisted paste, private upload
metadata, proof-of-work and storage fields, hit counts, content links, reports,
the access log, and staff users. Passwords and password hashes are never included
in a response. Run session integration tests with `npm run test:session`.

`/admin/pow` shows the configured minimum, deployment default, current
traffic-adjusted difficulty for a base-size paste, recent upload count, and the
last setting change. Admins can save a minimum from 0–256 leading zero bits or
restore the deployment default (`POW_DIFFICULTY_BITS`). Moderators can view but
cannot change the setting. The override is stored in the existing PoW Durable
Object and persists across Worker restarts and deployments without a new binding
or migration. Each extra bit doubles expected work; very high settings effectively
prevent uploads. Paste-size and traffic adjustments still apply, capped at 256 bits.
Changes are checked at issuance and redemption; previously signed challenges
remain authentic until expiry but require a fresh proof if the current price is higher. Refresh the page to update the current traffic snapshot.

`GET /api/admin/pow` returns the same state. Admins may `PATCH` or `POST` a JSON
body such as `{"minimum_difficulty_bits": 18}`; use `null` instead of a number to
restore the deployment default. Updates use the same origin checks as moderation
forms and record the authenticated admin's username. Responses are not cached.
Run the integration tests with `npm run test:pow-settings`.

`/admin/pastes` is the single moderation workspace. It defaults to user reports and automated assessments that are
pending review and can filter all reported, never-reported, or all pastes, plus
reporter reason, staff decision, visibility, and content type. Each row shows every
reporter-supplied reason and the most recent moderator. **Approve** is one click and
also permits public access. Choosing a classification does not immediately mutate state:
choose a reason and explicitly click **Restrict & hide**. Visibility controls preserve the
classification and cannot bypass audience/traffic policy. Traffic review is identified
separately from AI/media review and user reports; approval controls also appear in the viewer. Paste links open an authenticated `/admin/paste/:id/view` viewer;
its raw and stored-content requests use the same staff session cookie. Staff can inspect hidden/restricted bodies without making
them public or incrementing hit counts. Deleted bodies remain unavailable to everyone.
URL pastes are displayed for review, never followed automatically.
`/admin/reports` remains as a compatibility redirect to the same
workspace filtered to reported pastes.

The JSON moderation endpoint accepts quick actions (`approve`, `classify`, or
`toggle_visibility`) or explicit `decision`, `visibility`, and `reason` fields. The
moderator identity always comes from the authenticated account, never the request
body. HTML review pages default to 100 records; `limit` accepts 1–1000. Use
**Previous** and **Next** to page through results. The access-log page similarly uses
**Older events**, or the API's `next_before_id`, for pagination.

Raw/individual-file routes decompress the stored object. Legacy single-file media
raw responses remain data-URL text; bundle media routes return decoded, MIME-checked bytes.
The `/content` endpoint returns the exact stored representation so browser code can
decompress and verify it itself.

## Jev classification CLI

Requires Node.js 22+ or `uvx deno`, and an exported `DEFAPI_KEY` (a DefAPI key,
not a Cloudflare key). If you added it to `~/.bashrc`, use `export DEFAPI_KEY=...`
there and open a new shell or run `source ~/.bashrc` so child processes can read it.

The Make targets use `uvx deno` and default to the local development server:

```bash
make dev                          # keep running in another terminal
make classify                     # latest 20 local public listed pastes
make classify-paste PASTE_ID=CP0A1B2C
make classify BASE_URL=https://cp.codes
make classify BASE_URL=http://127.0.0.1:8787
```

They access the development Durable Object index and R2 bodies through Wrangler's
HTTP API, not by opening `.wrangler/state` directly. Override `BASE_URL` for another
server or port; Deno's network permission follows that host. DefAPI requests still
go to the real third-party API and incur charges, even for local pastes.

The standalone CLI defaults to `https://cp.codes`; use `--base-url` for local data:

```bash
npm run classify -- CP0A1B2C       # one paste
npm run classify                  # latest 20 public listed pastes on https://cp.codes
npm run classify -- --base-url http://localhost:8787
node scripts/classify-pastes.mjs > classifications.jsonl
```

The full suite uses Miniflare/Workerd integration tests, browser-unit tests, Python
CLI tests and Deno policy tests. Install npm dependencies and Python; Deno runs through `uvx`:

```bash
make test                         # all regression tests
npm test                          # equivalent
make test-classify                # Deno CLI tests only, no Node/npm needed
make test-moderation              # Deno moderation policy tests only
```

Tests use injected provider fixtures and make no paid API calls. Optional Chromium
end-to-end coverage is available with `npm run test:browser`; see
[doc/REDESIGN.md](doc/REDESIGN.md#verification) for setup.

`scripts/classify-pastes.mjs` reads each paste's metadata and body, verifies its
length and SHA-256, and calls `typesafe/jev-1.13` via DefAPI's Decisions API.
One `choice` question selects **spam**, **phishing**, **csam**, **unsafe**, **code**,
**plaintext**, or **ascii**. `ascii` means text art, not merely ASCII-encoded
text; `plaintext` is the fallback. For overlapping categories, the prompt gives
CSAM, phishing, spam, and unsafe content priority over format labels. The result includes all seven
probabilities, confidence, token usage, and billing fields. These are model
estimates, not calibrated probabilities or certifications of safety.

The CLI prints one JSON object per paste to stdout (`classified`, `skipped`, or
`error`), with diagnostics on stderr. Use the direct `node` command when saving
JSONL, to avoid npm's script banner. A failed paste does not stop the batch, but
any error makes the process exit nonzero. This is read-only: it does not change
staff moderation state. Normal content reads increment paste hit counts.

Only text is assessed. Text-only bundles are assessed together; any bundle with media
or encoded binary is skipped as a whole. PNG/JPEG/WebP/GIF and MP3/MP4 pastes are explicitly skipped
because the provided Jev API documentation does not establish image, audio, or video support. URL destinations
are not fetched. Bodies larger than **248,000 bytes (~242 KiB)** are skipped rather
than silently truncated. This default estimates Jev's listed 64,000-token context
at 4 bytes/token, reserving 2,000 tokens for questions, serialization, and output.
It is not exact token counting: token-dense code, text art, or other content may
still exceed the model's context. There is no chunking; use `--max-bytes N` to
adjust the byte cap. Each HTTP request has a 60-second timeout; there are no
automatic retries or duplicate paid requests. The key is sent only to DefAPI; request IP,
location, and other private upload metadata are not included in classification.
Paste content is sent to a third-party service, so review its data handling terms
before using this on sensitive content. See `doc/jev-1.13.txt` for the API reference.

## Deploy

**Provision real staff credentials and `DEFAPI_KEY`, review retention/WAF/billing
controls, and use a Paid Workers plan for the configured 250 ms CPU limit.**
The storage estimate assumes a 30-day R2 lifecycle; enabling expiration can also
purge matching **existing** older bodies. See the
[deployment checklist](doc/REDESIGN.md#staff-credentials--deployment).

```bash
npm run cf-typegen
npm run check
npm test
npx wrangler deploy --dry-run
# Only after provisioning/review:
make deploy
```

No deployment or remote lifecycle modification is performed by the redesign.
