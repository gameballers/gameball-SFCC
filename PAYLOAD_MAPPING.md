# Gameball ⇄ SFCC Payload Mapping

> **Generated from:** `main` @ `d88afeb` — every `file:line` citation below resolves at that commit.
> **Gameball contract source:** `GAMEBALL_SFCC_CARTRIDGE_PLAN.md` §13 (lines 1915–2190). The only
> authority. Nothing here is sourced from memory, from `docs.gameball.co`, or from a sibling endpoint.
> **Wire captures:** none — every `SENT` row below is unproven against a live Gameball account. There is
> no sandbox and no Test API Key in this environment (see arbitration §8, risks R-1/R-2/R-8).
> **Review trigger:** any PR touching a file in §11.1 updates this document or states "no payload
> change" in its description. See §11.

## 0. How to read this document

### 0.1 Columns

| Column | Contains | Does **not** contain |
|---|---|---|
| Gameball field | The name verbatim from §13, dotted for nesting. Casing is Gameball's (`APIKey`, `skip_analytics`). | A prettified or camel-cased variant. |
| Type | The JSON type §13 states. | An SFCC/JS type. |
| Req | Gameball's requirement: Yes / Conditional / No. `Conditional` names its condition in Transformation. | Whether the cartridge sends it — that is Status. |
| SFCC source | The literal expression at the cited line. | A paraphrase, a plan recommendation, or an API nobody has read. |
| Transformation | Rounding, unit conversion, per-quantity division, enum mapping, omit-when-empty, and `→ M‹n›`. | Restating the field name. |
| Status | Exactly one tag from §0.2. | Two tags. |
| Source | `path/file.js:LINE` from the repo root, at the assignment. Multi-hop `a.js:12 → b.js:44`. | A file with no line. |

Key order on the wire is object-literal order and is part of no contract — do not diff on it.

### 0.2 Status vocabulary

Closed set, assigned by precedence — first match down the list wins.

| # | Tag | Means | Evidence required | Do **not** use when |
|---|---|---|---|---|
| 1 | `GAP` | Cannot be established from merged code, or is sent but uncitable. | A numbered §10.3 finding stating what was searched. | You simply have not looked yet. |
| 2 | `UNVERIFIED-SFCC` | The SFCC API named in Source could not be confirmed to exist in the Script API reference. The row's source is a *claim*. | The exact method name + where confirmation was attempted. | The method is obviously present in a `dw` module already read in this tree. |
| 3 | `MISMATCH` | Sent, but type / semantics / enum membership disagree with §13, or the value is provably wrong. | A `M‹n›` entry in §7. | The divergence is from the build plan's *recommendation*, not from §13 — that is `SENT` + a Transformation note. |
| 4 | `COND` | Sent only on a named branch: a site preference, a null-guard, or an order/customer shape. | Citation + the condition + what the **default configuration** does. | The guard is a pure null-safety default that always yields a value (that is `SENT`). |
| 5 | `SENT+PROVEN` | Always sent on the happy path **and** observed on the wire against a real Gameball account. | Citation + the `E‹n›` example carrying the capture date. | No capture exists. Never infer one. |
| 6 | `SENT` | Always sent on the happy path; never observed on the wire. | Citation. | — |
| 7 | `SKIP-DECISION` | Deliberately not sent because of a binding Skip decision or an explicit plan decision. | `INTEGRATION_GAPS.md:LINE` **or** `PLAN §N (line L)`. | No decision exists anywhere → that is `GAP`. |
| 8 | `SKIP-NO-SOURCE` | Gameball defines it; SFCC has no equivalent data to put in it. | What was searched for and did not exist (a `dw` class, a system attribute, a custom attribute not shipped). | A source exists but is expensive or was descoped → `SKIP-DECISION`. |

*Required vs optional* is Gameball's property (its own **Req** column), never this vocabulary.
*Legal-but-empty* (`payload.email = profile.email || undefined`, dropped by `JSON.stringify`) is a
**Transformation**, not a status — such rows are `COND`.

### 0.3 Citation rules

1. Every non-`SKIP-*` row cites the **assignment** line.
2. A row that cannot be cited is status `GAP` **and** a numbered finding in §10.3. It is never dropped.
3. `SKIP-DECISION` cites the decision: `INTEGRATION_GAPS.md:LINE` or `PLAN §N (line L)`.
4. `SKIP-NO-SOURCE` names what was searched for and did not exist.
5. Every Gameball field traces to §13. A key the cartridge sends that §13 does not define appears in
   the surface's *"Non-contract keys sent"* sub-table, never as a normal row.

### 0.4 Re-verifying this document

```
# 1. Baseline
git -C <repo> rev-parse --short HEAD            # must equal the front-matter SHA

# 2. Every citation still points at what it claims (run per row, or eyeball the builder files)
rg -n "customerId|orderId|orderDate|totalPaid" cartridges/int_gameball_core/cartridge/models/payload/

# 3. Nothing is sent that has no row: list every key assigned into a payload object
rg -n "payload\.[a-zA-Z]+\s*=|item\.[a-zA-Z]+\s*=|extra\.[a-zA-Z]+\s*=|attributes\.[a-zA-Z]+\s*=" cartridges/int_gameball_core/cartridge/models/payload/

# 4. Every outbound call site is covered by a section
rg -n "gameballService.call|GbSdk.init" cartridges/
```

**Wire-capture procedure** (what upgrades a row from `SENT` to `SENT+PROVEN`):

1. **Sandbox only. Never Production.** Use the **Test API key** (§13.2 line 1952 — the environment is
   selected by which key is sent; there is no separate sandbox host, so a Live key on a sandbox writes
   real loyalty data).
2. Temporarily set `<comm-log-enabled>true</comm-log-enabled>` in
   `metadata/site_template/services.xml:18` on that sandbox, run the flow, read the communication log,
   then **revert**. `gameballService.js:56-59` already documents that the comm log is the real leak
   vector for this service — this recipe repeats that warning deliberately.
3. Widget captures come from browser devtools (the `GbSdk.init` argument in page source, or the network
   request to `assets.gameball.co`), not from a comm log — the widget call never leaves the browser
   through SFCC (`gameballWidget.js:1-136` runs entirely client-side).
4. **UNVERIFIED alternative:** `<mock-mode-enabled>` (`services.xml:19`, currently `false`) would let a
   request be built without being sent, but `gameballService.js` defines no `mockCall` callback, so what
   `svc.call()` returns in mock mode here is unconfirmed. Do not build the recipe on it.

### 0.5 Metadata cross-reference

Re-enumerated from the merged
`metadata/site_template/meta/system-objecttype-extensions.xml` and
`metadata/site_template/meta/custom-objecttype-definitions.xml`. This is the complete set at
`d88afeb` — every attribute the arbitration document's §2 registry specifies has landed exactly as
specified (id, type, default, group all verified against the merged XML; no duplicate `attribute-id`,
no orphaned code-read preference found — see §10.3 finding F7 for the one exception).

**SitePreferences → `GameballConfigs`**

| Id | Type | Default | Gates which field(s) here |
|---|---|---|---|
| `gameballEnabled` | boolean | `false` | Every outbound call. `orderSyncGate.js:12-14`, `customerSyncGate.js:122-126`, `refundGate.js:27-29`, `gameballWidget` render gate `Gameball.js:32`. |
| `gameballExcludeGiftCertificateTender` | boolean | `true` | §3.1 `totalPaid` — `orderPayload.js:66,78`. |
| `gameballInfoLogEnabled` | boolean | `true` | Not a payload field — logging only. |
| `gameballDebugLogEnabled` | boolean | `false` | Not a payload field — logging only. |
| `gameballSyncOcapiShopCustomers` | boolean | `true` | Whether §2 fires at all from the OCAPI Shop hooks — `customerSyncGate.js:145-147`. |
| `gameballSyncDataApiCustomers` | boolean | `false` | Whether §2 fires at all from the OCAPI Data hooks — `customerSyncGate.js:149-151`. |
| `gameballCustomerRequireEmail` | boolean | `false` | Gates §2 sending at all when `profile.email` is absent — `customerSyncGate.js:201-209`. |
| `gameballCustomerDeltaStrategy` | enum-of-string | `LAST_MODIFIED` | Not a payload field — which query the delta job runs. |
| `gameballCustomerDeltaLookbackHours` | int | `48` | Not a payload field. |
| `gameballCustomerDeltaMaxCallsPerRun` | int | `500` | Not a payload field — per-run call budget. |
| `gameballCustomerDeltaMaxProfilesPerRun` | int | `20000` | Not a payload field. |
| `gameballAllowNonProductionSync` | boolean | `false` | Not a payload field — job non-production guard. |
| `gameballMaxRequestsPerSecond` | int | `10` | Not a payload field — `gameballJobPacer.js` throttle input. |
| `gameballErasureEnabled` | boolean | `false` | Gates whether §6's DELETE call is ever issued — `erasureDrain.js:489-492`. |
| `gameballErasureMaxAttempts` | int | `5` | Not a payload field. |
| `gameballErasureSuccessRetentionDays` | int | `7` | Not a payload field. |
| `gameballTrackGuestOrders` | boolean | `false` | Gates §3.4's guest path entirely — `orderSyncGate.js:110-112`. |
| `gameballGuestOrderMode` | enum-of-string | `PER_ORDER` | §3.1 `customerId`/`guest` on the guest path — `gameballIdentity.js:55-64,135-192`. |
| `gameballLinkGuestOrdersByLogin` | boolean | `true` | §3.1 `customerId`/`guest` rung 2 — `gameballIdentity.js:254-266`. |
| `gameballRetryEnabled` | boolean | `true` | Not a payload field. |
| `gameballRetryLookbackDays` | int | `7` | Not a payload field. |
| `gameballRetryMaxAttempts` | int | `5` | Not a payload field. |
| `gameballRetryMaxOrdersPerRun` | int | `200` | Not a payload field. |
| `gameballRetryBackoffMinutes` | int | `30` | Not a payload field. |
| `gameballRetryProbeBeforeResend` | boolean | `true` | Gates §6's verification GET before a re-`POST` — `retryFailedOrders.js:470-527`. |

**SitePreferences → `GameballRefundConfigs`**

| Id | Type | Default | Gates which field(s) here |
|---|---|---|---|
| `gameballEnableRefunds` | boolean | `false` | Every §4 call — `refundGate.js:37-39`. |
| `gameballRefundDetectCancellations` | boolean | `true` | Whether Pass A of the refund detector ever builds a §4 payload — `detectRefunds.js:123,469-489`. |
| `gameballRefundLookbackDays` | int | `90` | Not a payload field. |
| `gameballRefundOrphanMaxHours` | int | `24` | Not a payload field — abandons a `WAITING_FOR_ORDER` entry, see §3.4/§4.6. |
| `gameballRefundMaxAttempts` | int | `6` | Not a payload field. |

**`Profile` type-extension → `GameballCustomer`** (created by the OCAPI/Data-API customer item; not
payload fields — response/state persistence for §2, documented in §2.5's response sub-table)

`gbSyncState` · `gbSyncHash` · `gbLastSyncAt` · `gbGameballId` · `gbSyncSource` · `gbLastSyncError` —
`system-objecttype-extensions.xml:489-530`.

**`Order` type-extension → `GameballOrder`** (identity/state for §3, replayed verbatim into §4 — see
M6)

`gbTrackState` · `gbGameballOrderId` · `gbCustomerId` · `gbLastError` · `gbCustomerIdSource` ·
`gbLastErrorCode` · `gbLastRequestId` · `gbRetryAttempts` · `gbLastAttemptAt` · `gbNextRetryAt` ·
`gbTrackedAt` · `gbTrackedTotalPaid` · `gbTrackedCurrency` — `system-objecttype-extensions.xml:315-473`.

**`Order` type-extension → `GameballOrderRefund`** (state for §4's ledger)

`gbRefundState` · `gbRefundedAmount` · `gbRefundSeq` · `gbRefundLedger` · `gbRefundPendingAt` ·
`gbRefundLastError` — `system-objecttype-extensions.xml:410-483`.

**Custom Objects** — `GameballJobState` (singleton cursor, no payload fields; `custom-objecttype-definitions.xml:4-55`) and `GameballErasureRequest` (`gbCustomerId`/`gbStatus`/`gbSource`/`gbRequestedAt`/`gbLastAttemptAt`/`gbCompletedAt`/`gbAttempts`/`gbStatusDetails`, the DELETE-scope idempotency record for §6 — `custom-objecttype-definitions.xml:57-134`).

**Naming rule verified while regenerating (H35, build-plan §4.8):** every site preference above is
`gameball<Thing>`; every persistent-object attribute is `gb<Thing>`. **The known `Gameball_Enabled`
phantom-preference read is CLOSED as of `d88afeb`** — `widget.isml`'s enable check now lives in
`Gameball.js:32` and reads `gameballEnabled` only, and `gameballCustomerApi.js`'s local
`isGameballEnabled()` was relocated to `customerSyncGate.js:122-126`, which also reads `gameballEnabled`
only. No `grep -rn "Gameball_Enabled" cartridges/` hit exists in the merged tree. This closes the H36
finding standards §1.9 and the spec's own §3 flagged as still-open pending the widget item — the widget
item has, in fact, landed.

---

## 1. Shared surfaces

### 1.1 Authentication headers (§13.1)

| Header | Value | Required | SFCC source | Status | Source |
|---|---|---|---|---|---|
| `APIKey` | workspace key, raw — no `Bearer`, no base64, no prefix | Always | `gameballCredentials.getApiKey()` → `credential.getUser()` | SENT | `gameballService.js:23 → gameballCredentials.js:31-34` |
| `SecretKey` | points-transaction key, raw | All points endpoints; **every** endpoint under High Security Mode | `gameballCredentials.getSecretKey()` → `credential.getPassword()` | SENT | `gameballService.js:24 → gameballCredentials.js:41-44` |
| `Content-Type` | `application/json` | Yes | literal | SENT | `gameballService.js:22` |
| `lang` | `en`/`ar`/`fr` — localises returned campaign names | No | — | SKIP-NO-SOURCE — no per-call locale is threaded into `gameballService.call()`'s `params`; only the widget builds a `lang` value (§5.1), and that value never reaches this REST-header path | — |

**Not sent, and deliberately:** SFCC's automatic Basic-Auth header is suppressed by
`svc.setAuthentication('NONE')` — `gameballService.js:19`. Without it the platform would attach the
credential's user/password as an `Authorization` header on every call. Casing ambiguity → **M12**.

### 1.2 Base URL and environment (§13.2)

| Concern | Contract | Cartridge | Status | Source |
|---|---|---|---|---|
| Base URL | `https://api.gameball.co/api/v4.0/` | Service Credential URL, fallback constant `DEFAULT_BASE_URL` | SENT | `services.xml:5`; `gameballCredentials.js:6,52-56` |
| Path join | — | slash-normalised before `setURL` | SENT | `gameballService.js:29-35` |
| Environment selection | No separate sandbox host — the *key* selects Live vs Test | One credential per instance (`gameball.http.api.cred`); no environment-switch logic in code | SENT (structural) | `services.xml:4-8`; `gameballCredentials.js:16-20` |
| `v4.1` | exists for some endpoints; makes `secretkey` unconditional | Not used — every call is `v4.0` | SKIP-NO-SOURCE | `services.xml:5` (`.../api/v4.0`) |

### 1.3 Error envelope and code catalogue (§13.8)

Envelope: `{ code, type, message, documentationUrl, requestId }`. `requestId` is logged whenever it
is recovered (see below), because it is what Gameball support asks for.

| Code | HTTP | Meaning | Disposition (PLAN §4.4 / §13.8) | What the merged cartridge does today | Source |
|---|---|---|---|---|---|
| `9004` | 422 | Transaction ID already exists | Success — already applied, only when the stored id matches | N/A on customer scope — `9004` is a transaction-family code (build-plan §13.8 line 2131) the customer-upsert endpoint cannot return; `SCOPE_TABLES.CUSTOMER` is deliberately empty and `DEFAULT_TABLE` has no `9004` key, so an unmatched code here would fall through to the unrecognised-code fail-safe (TRANSIENT), not ALREADY_APPLIED. ALREADY_APPLIED on ORDER scope; ALREADY_APPLIED on REFUND scope with an id-echo re-assertion (§7 M2) | N/A citation for customer scope — `gameballErrors.js:97` (`SCOPE_TABLES.CUSTOMER = {}`), fail-safe `:537`; ORDER `:156`; REFUND `:272`; id-echo check `refundDelivery.js:395-403` |
| `9003` | 422 | Duplicate timestamp exists | Success (order tracking) | ALREADY_APPLIED on ORDER scope; **diverges to PERMANENT on REFUND scope**, routed to `MANUAL_REVIEW` — deliberate divergence, §7 M14 | `gameballErrors.js:155` (ORDER); `:262` (REFUND, with reasoning comment) |
| `9001` | 422 | Transaction already cancelled | Success | ALREADY_APPLIED on both ORDER and REFUND scope | `gameballErrors.js:153,245` |
| `7001` | 422 | Customer already exists | Success | ALREADY_APPLIED on the shared default table (customer upsert) | `gameballErrors.js:77` |
| `2001` | 422 | Concurrent request already processing | Retry, 30s | TRANSIENT (shared default table — applies everywhere) | `gameballErrors.js:51` |
| `1000`/`1001`/`1002` | 401/401/403 | Auth / High Security Mode / insufficient permissions | Config — stop, alert | CONFIG, with a per-code remediation string appended to the log message | `gameballErrors.js:42-44` |
| `6000`/`8000` | 422/403 | Gameball disabled / feature unavailable | Config | CONFIG | `gameballErrors.js:45-46` |
| `3000`/`3001`/`3003`/`3006`/`3013`/`3016` | 400/422/422/422/415/400 | Malformed payload family | Permanent | PERMANENT | `gameballErrors.js:58-63` |
| `3008` | 422 | Duplicate email | Permanent — channel merging off | PERMANENT, with the "enable channel merging" remediation string | `gameballErrors.js:69` |
| `3004` | 400 | Operation unachievable | — | PERMANENT on REFUND scope only, routed to `MANUAL_REVIEW` | `gameballErrors.js:290` |
| `7000` | 404 | Customer not found | Permanent (order/customer); **Success on DELETE scope** | PERMANENT (default table); SUCCESS override on `DELETE` scope | `gameballErrors.js:73` (default); `:121` (DELETE) |
| `404` (HTTP, no envelope) | — | — | — | SUCCESS on `DELETE` scope ONLY when a `requestId` proves the response came from the Gameball application; otherwise falls through to the generic 4xx→PERMANENT ladder | `gameballErrors.js:120,627-664` |
| `9000` | 422 | Transaction non-reversible | — | PERMANENT (ORDER scope, unreachable in practice — no cancel path exists on order tracking); PERMANENT on REFUND, routed to `MANUAL_REVIEW` | `gameballErrors.js:152,240` |
| `9002` | 404 | Transaction not found | — | PERMANENT (ORDER); PERMANENT on REFUND, routed to `MANUAL_REVIEW` | `gameballErrors.js:154,248` |
| `9005` | 404 | Reversed transaction not found | — | PERMANENT with a casing-mismatch remediation string on both ORDER and REFUND scope; on REFUND it is an **ALERT_CODE**, settled straight to `FAILED` (not `MANUAL_REVIEW`) | `gameballErrors.js:164,280`; alert routing `refundDelivery.js:35,187-192` |
| `9006` | 404 | Hold reference not found | — | PERMANENT (ORDER scope only — unreachable while redemption is Skip) | `gameballErrors.js:169` |
| `9007` | 422 | Invalid transaction time | — | PERMANENT on ORDER; PERMANENT on REFUND, routed to `MANUAL_REVIEW` — §7 M14 | `gameballErrors.js:173,287` |
| `9008` | 422 | Insufficient point balance | — | PERMANENT (ORDER scope only) | `gameballErrors.js:174` |
| `5000`/`5003`/HTTP `429`/`5xx` | 500/503/429/5xx | Server / rate limit | Retry | TRANSIENT (5000/5003, shared table); TRANSIENT via the HTTP-status ladder for 429 and other 5xx not otherwise matched | `gameballErrors.js:52-53,483-489` |
| Unrecognised code | — | — | Fail safe, not fail silent | TRANSIENT (self-limiting: the retry ceilings in every caller bound it) | `gameballErrors.js:537` |
| SFCC `SERVICE_UNAVAILABLE` / timeout | — | — | Retry **without** burning an attempt — the platform closed the valve, not Gameball | SERVICE_UNAVAILABLE, checked before the HTTP-status ladder | `gameballErrors.js:605-625` |

**Reachability, RESOLVED as of `d88afeb` (was UNVERIFIED at `1e98611`).** `gameballErrors.js:397-460`
(`readEnvelope`) actively parses `result.errorMessage` back into `{code, requestId, message}` on the
failure path and falls back to an HTTP-status ladder when it cannot. **The finding this table would
otherwise produce is therefore substantially resolved by code that exists**: the shared classifier is
built, is wired into all four scopes (CUSTOMER/ORDER/REFUND/DELETE), and every caller branches on
`disposition`, not merely `isOk()`. What remains genuinely UNVERIFIED (arbitration risk R-1, a merge
gate) is the underlying platform fact `readEnvelope` depends on: **whether `dw.svc.Result#errorMessage`
actually carries the raw non-2xx response body on this SFCC version, and whether `parseResponse` runs at
all on a non-2xx response.** If it does not, every code in this table becomes invisible and the whole
ladder degrades to the HTTP-status fallback (`classifyHttpStatus`, `gameballErrors.js:474-492`) — safely
(nothing silently becomes `SUCCESS`), but with far less resolution. See §10.3 finding F1.

`requestId` (§13.8 line 2127) is recovered by the same `readEnvelope` function whenever the envelope
parses, and is persisted to `Order.custom.gbLastRequestId` (`gameballOrderApi.js:328-330`) and logged
in every ERROR/WARN line across `gameballCustomerApi.js`, `gameballOrderApi.js`, and `refundDelivery.js`.

### 1.4 Rate limits (§13.7)

| Resource | Method | Per second | Per rolling 30s | Surfaces affected here |
|---|---|---|---|---|
| Orders (tracking) | any | 30 | 360 | §3 |
| Customers | POST | 30 | 360 | §2 |
| Customers | GET | 100 | 1200 | — (not called; see §6) |
| Transactions (incl. refund) | GET/POST | 30 | 360 | §4, and the §6 verification probe |

No `Retry-After`, no `X-RateLimit-*`, no prescribed backoff → **M13**. The cartridge paces itself with
one account-scoped soft governor, `gameballJobPacer.js` (start/tryAcquire/halt, `:94-259`), driven by
`gameballMaxRequestsPerSecond` (`system-objecttype-extensions.xml:110-117`) and consulted by every job
(`deltaCustomers.js:695`, `erasureDrain.js:512`, `retryFailedOrders.js:829`, `detectRefunds.js:462`).
SFCC's own storefront quota interacts: `api.dw.net.HTTPClient.send()` is capped at **16 per request**
(build-plan; unlimited in jobs), which is why the confirmation-page order-tracking call
(`Order.js:35-55`) and the account-page customer upserts (`Account.js:182,243`) are each exactly one
call and nothing on a request path loops.

---

## 2. Customer upsert — `POST /api/v4.0/integrations/customers`

**Reachable from:** storefront `Account-SubmitRegistration` and `Account-SaveProfile`
(`Account.js:182,243`); `Order-CreateAccount` (`Order.js:190`); the six OCAPI/SCAPI hooks
(`hooks.json:3-8` → `ocapiShopCustomerHooks.js:22-36`, `ocapiDataCustomerHooks.js:41-67`, both
delegating to `ocapiCustomerHookRunner.js:84-104`); and the `Gameball Customer Delta` job
(`steptypes.json:5-22` → `deltaCustomers.js:591`). All six converge on
`gameballCustomerApi.sendProfile(profile, source)` (`gameballCustomerApi.js:496`). **Idempotent upsert
keyed on `customerId`** — there is no separate update endpoint (§13.4 line 2031).

### 2.1 Root object (§13.4)

| Gameball field | Type | Req | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|---|
| `customerId` | string ≤100 | **Yes** | `profile.customerNo` | raw, no prefix — multi-site identity collision is a binding Skip (`INTEGRATION_GAPS.md:35`) | SENT | `customerPayload.js:14` |
| `email` | string | Conditional — required under email-based channel merging | `profile.email` | `\|\| undefined` so `JSON.stringify` drops the key when empty (H31). **Top-level = the merging key, distinct from `customerAttributes.email`** → M10 | COND | `customerPayload.js:15` |
| `mobile` | string | Conditional — mobile-based merging | `profile.phoneMobile \|\| profile.phoneHome \|\| profile.phoneBusiness` | first non-empty wins; no E.164 normalisation and no plausibility check on this surface (contrast `orderPayload.js:182-184`) → §8 | COND | `customerPayload.js:24-27` |
| `deviceToken` | string | No | — | no SFCC source: no device registry exists server-side | SKIP-NO-SOURCE | `PLAN §13.4 (line 2040)` |
| `osType` | string | No | — | same | SKIP-NO-SOURCE | `PLAN §13.4 (line 2041)` |
| `customerAttributes` | object | No | §2.2 | | SENT | `customerPayload.js:16-21,29-35` |
| `referrerCode` | string | No (creation only) | — | referral capture is a binding Skip | SKIP-DECISION | `INTEGRATION_GAPS.md:31` |
| `guest` | boolean | No | — | never set — every `customerPayload.build()` call site already holds a real, registered `dw.customer.Profile` (a guest order never has one and never calls this builder at all; see §3.4), so the field would always be `false`, and Gameball's own documented default is `false` (§13.4 line 2044). Sending it explicitly would be a no-op. | SKIP-NO-SOURCE | no call site constructs a non-registered `customerAttributes` upsert |

### 2.2 `customerAttributes` (§13.4 line 2046)

| Gameball field | Type | Req | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|---|
| `displayName` | string | No | `profile.firstName`, `profile.lastName` | `((first \|\| '') + ' ' + (last \|\| '')).trim()`. **The widget builds the identical expression** — see §5.4, M11 is RETIRED | SENT | `customerPayload.js:11,17` |
| `firstName` | string | No | `profile.firstName` | `\|\| ''` — sent as empty string, not omitted | SENT | `customerPayload.js:18` |
| `lastName` | string | No | `profile.lastName` | `\|\| ''` — sent as empty string, not omitted | SENT | `customerPayload.js:19` |
| `email` | string | No | `profile.email` | `\|\| ''` — sent as empty string, not omitted. **Distinct from the top-level `email` at §2.1**, which is `\|\| undefined` (omitted, not empty) | SENT | `customerPayload.js:20` |
| `dateOfBirth` | string | No | `profile.birthday` | `new Calendar(birthday)` → `StringUtils.formatCalendar(cal, 'yyyy-MM-dd')`. **The `Calendar`'s time zone is not explicitly set to UTC** (plan §6.3 line 1141 requires it) — a birthday at local midnight can shift a day | COND | `customerPayload.js:29-35` |
| `gender` | string `M`/`F` | No | `profile.isMale()` / `.isFemale()` | not read anywhere in `customerPayload.js` — never sent | SKIP-NO-SOURCE | no assignment found in `customerPayload.js` |
| `mobile` | string | No | — | not set inside `customerAttributes` — only the top-level `mobile` (§2.1) is populated | SKIP-NO-SOURCE | no assignment found |
| `joinDate` | string | No | `profile.creationDate` (available, unread) | not read | SKIP-NO-SOURCE | no assignment found |
| `country` · `city` · `zip` | string | No | `profile.getAddressBook()` (available, unread) | not read | SKIP-NO-SOURCE | no assignment found |
| `preferredLanguage` | string | No | `request.locale` (available, unread by this builder — H30 forbids it: builders are pure functions of the `dw.*` object) | not read | SKIP-NO-SOURCE | H30, `customerPayload.js:10` (pure-function signature) |
| `source` | string | No | — | not read (distinct from `gbSyncSource`, the *cartridge's own* persisted attribute — never sent to Gameball) | SKIP-NO-SOURCE | no assignment found |
| `channel` | enum `mobile\|pos\|web\|callcenter` | No | — | not read on this endpoint at all (contrast the order-tracking `channel` field, §3.1, which is read and is a documented defect — M8) | SKIP-NO-SOURCE | no assignment found |
| `paymentMethods` | array\<string\> | No | `order.getPaymentInstruments()` (order-scoped, not available to a `Profile`-only builder) | not read | SKIP-NO-SOURCE | H30 — `customerPayload.build(profile)` takes no order |
| `totalSpent` · `lastOrderDate` · `totalOrders` · `avgOrderAmount` | number/string | No | `dw.customer.Profile` has no such aggregate; would require an order search per profile | not read | SKIP-NO-SOURCE | none exists on `dw.customer.Profile` |
| `utms` · `devices` | array (unspecified schema) | No | no equivalent SFCC data | not read | SKIP-NO-SOURCE | none |
| `custom` | object, free-form | No | — | not read — no merchant-custom-attribute mapping is built | SKIP-NO-SOURCE | none |

### 2.3 Must never be sent on this endpoint (§13.4 line 2048)

| Field | Why | Status | Source |
|---|---|---|---|
| `tags` | read-only here — writable only via `POST /customers/{id}/tags`, comma-separated string, not called anywhere in this cartridge | SKIP-DECISION | `PLAN §13.4 (line 2048)` |
| `level` / `tier` | no write path exists anywhere in the API | SKIP-DECISION | `PLAN §13.4 (line 2048)` |
| `playerAttributes` | widget-only naming → M5 | SKIP-DECISION | `PLAN §13.4 (line 2048)` |
| `points` · `balance` · `referralCode` | server-generated | SKIP-DECISION | `PLAN §13.4 (line 2048)` |

None of these appear anywhere in `customerPayload.js`; confirmed by
`rg -n "\.tags|\.level|\.tier|playerAttributes|\.points|\.balance|referralCode" cartridges/int_gameball_core/cartridge/models/payload/customerPayload.js` → zero hits.

### 2.4 Non-contract keys sent

None. `customerPayload.build()` (`customerPayload.js:10-38`) constructs exactly the root-object keys
listed in §2.1 and the `customerAttributes` keys listed in §2.2, all of which are §13.4-defined field
names.

### 2.5 Response (§13.4 line 2050)

| Response field | Type | What the cartridge does | Persisted to | Source |
|---|---|---|---|---|
| `gameballId` | number | **read and persisted** — `readGameballId(result)` pulls it off `result.getObject()` when the body shape matches `{gameballId: number}` | `Profile.custom.gbGameballId` | `gameballCustomerApi.js:318-329,369-386,649` |

This closes what the build plan (§6.3 line 1158) and an earlier draft of this document both flagged as
a likely gap ("discarded — the result object is never read"). **As merged, it is not a gap**: the
merge-detection signal the plan asked for exists. The remaining open question is narrower and is
recorded as `M15`-adjacent UNVERIFIED reasoning inline at `gameballCustomerApi.js:612-632`: whether a
`7001` "customer already exists" response's `customerAttributes` are actually **applied** by Gameball
server-side is undocumented, and if they are not, `gbSyncHash` is written anyway on that path — see
§10.3 finding F2.

---

## 3. Order tracking — `POST /api/v4.0/integrations/orders`

**Reachable from:** the storefront `Order-Confirm` append (`Order.js:35-55`, calling
`gameballOrderApi.sendOrder(order)`) and the `Gameball Order Retry` job
(`steptypes.json:44-63` → `retryFailedOrders.js:762` → `attemptTrack(order)`, the non-persisting attempt
core shared with `sendOrder`). **Gate:** `orderSyncGate.evaluate()` (`orderSyncGate.js:70-120`) decides
"should we ever"; `order.custom.gbTrackState === 'TRACKED'` plus the `FAILED_PERMANENT`/
`RETRY_EXHAUSTED` terminal check (`gameballOrderApi.js:561-566`) decides "have we already".

### 3.1 Root object (§13.3)

| Gameball field | Type | Req | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|---|
| `customerId` | string ≤100 | **Yes** | `gameballIdentity.getOrderCustomerId(order).customerId` | the identity ladder (§3.4): rung 1 raw `profile.customerNo`, rung 2 a matched registered profile's `customerNo`, rung 3 a minted guest id. Must be byte-identical to §2 and to the widget's `playerUniqueId`; persisted to `Order.custom.gbCustomerId` | SENT | `orderPayload.js:284,291 → gameballIdentity.js:229-270`; persisted `gameballOrderApi.js:314,627,662` |
| `orderId` | string | **Yes** | `order.getOrderNo()` | **case-sensitive** — persisted verbatim and replayed as `refund.reverseTransactionId` → M6 | SENT | `orderPayload.js:293`; persisted `gameballOrderApi.js:311,626,661` |
| `orderDate` | string ISO-8601 **UTC** | **Yes** | `order.getCreationDate()` | `.toISOString()`, falling back to `new Date().toISOString()` when null | SENT | `orderPayload.js:289,294` |
| `totalPaid` | number ≥0 | **Yes** | `order.getTotalGrossPrice()` minus Gameball-points tender minus (pref, default on) gift-certificate tender | clamp ≥0, round to the currency's fraction digits; **the only figure points are earned on**; the exact sent value is also persisted as the refund ceiling | COND | `orderPayload.js:64-89,295`; ceiling persisted `gameballOrderApi.js:352,643,680` |
| `totalPrice` | number ≥0 | No | Σ `pli.getBasePrice() × qty` (non-option lines) + `getShippingTotalPrice()` + `getTotalTax()` | Gameball: "not used in calculations, historical only" | SENT | `orderPayload.js:99-124,296` |
| `totalDiscount` | number ≥0 | No | `abs(Σ order.getPriceAdjustments().getPrice())` | **order-level adjustments only** — deliberately never `totalPrice − totalPaid`, which would relabel gift-certificate tender as a discount | SENT | `orderPayload.js:134-144,297` |
| `totalShipping` | number | No | `order.getShippingTotalPrice()` | via `gameballMoney.toNumber()` — 0 when `NOT_AVAILABLE`; **not** re-rounded | SENT | `orderPayload.js:298` |
| `totalTax` | number | No | `order.getTotalTax()` | via `gameballMoney.toNumber()` — 0 when `NOT_AVAILABLE`; **not** re-rounded | SENT | `orderPayload.js:299` |
| `channel` | enum `mobile\|pos\|web\|callcenter` | No | `order.getChannelType()` switched against `LineItemCtnr.CHANNEL_TYPE_*` | `getChannelType()` returns an `EnumValue`; the constants are not confirmed to be JS-primitive-comparable, so the `switch`/`case` almost certainly always falls through to `'web'` → **M8, DEFECT, verified still present in the merged tree** | MISMATCH | `orderPayload.js:155-172,300` |
| `guest` | boolean | No | `gameballIdentity.getOrderCustomerId(order).guest` | `false` on identity-ladder rungs 1/2 (registered, or a guest matched to an existing login), `true` only on rung 3 (true guest). Sent explicitly on every order — see §3.4 | SENT | `orderPayload.js:284,306 → gameballIdentity.js:229-270` |
| `cartId` | string | No | `order.getUUID()` | the **order** UUID, not the basket's — the basket is gone by `route:BeforeComplete` | SENT | `orderPayload.js:307` |
| `email` | string | Conditional | `order.getCustomerEmail()` | key omitted entirely when falsy (H31) | COND | `orderPayload.js:315-318` |
| `mobile` | string | Conditional | billing address phone, falling back to the default shipment's shipping address phone | plausibility-gated (`/\d/`) — omit rather than send a placeholder | COND | `orderPayload.js:193-214,320-323` |
| `lineItems` | array\<LineItem\> | No | §3.2 | key omitted when the array is empty | COND | `orderPayload.js:325-328` |
| `redemption.pointsHoldReference` | string | No | order-level `PriceAdjustment.custom.gbHoldReference` (falls back to `Order.custom.gbHoldReference`) | item 08, "Pay with Points" — omitted entirely when no hold-based redemption exists on the order (H31) | COND | `orderPayload.js:resolveRedemption` |
| `redemption.couponsLockReference` · `.couponCodes` | string / array\<string\> | No | — | still unbuilt — the separate Model B coupon-code redemption feature (§8.4), not item 08 | SKIP-DECISION | `INTEGRATION_GAPS.md:54,66` |
| `merchant.uniqueId` | string | No | `Site.getCurrent().getID()` | | SENT | `orderPayload.js:308-311` |
| `merchant.name` | string | No | `Site.getCurrent().getName()` | | SENT | `orderPayload.js:308-311` |
| `merchant.branch.uniqueId` | string | Conditional — mandatory if `branch` present | — | BOPIS only; no store-id source is read | SKIP-NO-SOURCE | no assignment; `PLAN §13.3 (line 2000)` |
| `merchant.branch.name` | string | No | — | same | SKIP-NO-SOURCE | same |
| `cashbackConfigurations.returnWindow` | int 0–7300 | No | — | not sent, and **no decision exists** for it anywhere in `INTEGRATION_GAPS.md`; plan §4.11 (line 746) calls it the primary defence against negative point balances | GAP | finding F3 |
| `extra` | object (string\|number values **only**) | No | §3.3 | | SENT | `orderPayload.js:224-266,312` |
| *(no field)* `currency` | — | — | `order.getCurrencyCode()` | **Gameball has no currency field** (§13.3 line 2003) — sent only as `extra.currency` → **M1** | MISMATCH | `orderPayload.js:227,317` |

### 3.2 `lineItems[]` (§13.3 line 1981)

Source `order.getAllProductLineItems()`, skipping option line items (`lineItem.js:222`); one bad item is
skipped, not fatal (`lineItem.js:226-233`).

| Gameball field | Type | Req | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|---|
| `productId` | string | No | `pli.getProductID()` | raw, unsanitised — must match what refunds and merchant rules use | SENT | `lineItem.js:168` |
| `quantity` | number ≥0 | No | `pli.getQuantityValue()` via `getQuantityValue()` | `\|\| 0` on any read failure | SENT | `lineItem.js:29-35,146,169` |
| `price` | number ≥0 | No | `pli.getBasePrice()` | **unit** price before tax and discount — not the extended price | SENT | `lineItem.js:170` |
| `sku` | string | No | `product.getManufacturerSKU()`, falling back to `pli.getProductID()` | product can be null when the catalog entry was deleted post-order | COND | `lineItem.js:158-165,171` |
| `title` | string | No | `pli.getProductName()` | | SENT | `lineItem.js:172` |
| `category` | array\<string\> | No | primary category walked to root via `.getParent()`, collecting `.getID()` | category **IDs**, leaf first — IDs are locale-stable and are what Gameball rules match | COND | `lineItem.js:45-63,176-179` |
| `tags` | array\<string\> | No | — | no SFCC source: no product `tags` custom attribute ships with this cartridge | SKIP-NO-SOURCE | `PLAN §13.3 (line 1991)` |
| `vendor` | string | No | `product.getBrand()` | omitted when the product has no brand | COND | `lineItem.js:181-188` |
| `collection` | array\<string\> | No | — | no SFCC source: no product `collection` custom attribute ships | SKIP-NO-SOURCE | `PLAN §13.3 (line 1993)` |
| `weight` | number ≥0 | No | — | `dw.catalog.Product` has no system `weight`; not read | SKIP-NO-SOURCE | `PLAN §13.3 (line 1994)` |
| `taxes` | number | No | `pli.getTax() / quantity` | **PER QUANTITY** (§13.3 line 1995), not per line; `0` when qty is 0 → **M4, ACCEPTED DIVERGENCE (correct as implemented)** | SENT | `lineItem.js:193-194` |
| `discount` | number | No | `abs(Σ pli.getPriceAdjustments().getPrice()) / quantity` | per quantity, **positive**; line-level adjustments only — order-level ones stay in `totalDiscount` → M4 | SENT | `lineItem.js:196-197` |
| `extra` | object | Conditional | `{ sfccUUID, masterId }` | omitted when empty; string values only | COND | `lineItem.js:116-137,199-202` |

### 3.3 `extra` keys sent (order level)

`extra` is one §13 field; its keys are cartridge-defined **by design** (§13.3 line 1979 permits
free-form string/number values). Constraint proof required per key.

| Key | Value type | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|
| `siteId` | string | `Site.getCurrent().getID()` | | SENT | `orderPayload.js:225` |
| `locale` | string | `order.getCustomerLocaleID()`, falling back to `Site.getCurrent().getDefaultLocale()` | | SENT | `orderPayload.js:226` |
| `currency` | string | `order.getCurrencyCode()` | informational only; no Gameball field consumes it → M1 | SENT | `orderPayload.js:227` |
| `shipmentCount` | number | `order.getShipments().size()` | | SENT | `orderPayload.js:229,248-251` |
| `isGiftOrder` | number | `defaultShipment.isGift()` | **`1`/`0`, never `true`/`false`** — Gameball rejects booleans here (§13.3 line 1979) → M7, ACCEPTED DIVERGENCE (correct as implemented) | SENT | `orderPayload.js:230,260` |
| `sourceCode` | string | `order.getSourceCodeGroupID()` | `\|\| ''` | SENT | `orderPayload.js:231` |
| `paymentMethods` | string | `order.getPaymentInstruments()` | joined `.join(',')` of `getPaymentMethod()` per instrument; unset when there are none | COND | `orderPayload.js:234-242` |
| `shippingMethod` | string | `defaultShipment.getShippingMethodID()` | unset when the shipment or the method id is absent | COND | `orderPayload.js:253-259` |

### 3.4 Guest path deltas (identity ladder, `gameballIdentity.js:229-270`)

| Field | Registered (rung 1) | Login-matched (rung 2) | True guest (rung 3) | Source |
|---|---|---|---|---|
| `customerId` | raw `profile.customerNo`, no prefix | the matched registered profile's `customerNo` | `gb_guest_` + either the SHA-256 hex of `lower(email).trim() + '\|' + siteId` (`PER_EMAIL` mode) or the raw order number (`PER_ORDER` mode, and the fallback when `PER_EMAIL` has no usable email) | `gameballIdentity.js:241-249,258-263,135-192` |
| `guest` | `false` | `false` — "the points genuinely land on a registered Gameball profile, not a minted one" | `true` | `gameballIdentity.js:248,262,191` |
| Master switch | always on | `gameballLinkGuestOrdersByLogin` (default `true`), consulted only when rung 1 misses | `gameballTrackGuestOrders` (default `false`) — with it off, orders never reach rung 3 at all and `orderSyncGate` settles them `SKIPPED` with reason `guest_order` before the ladder is ever called | `orderSyncGate.js:110-119`; `gameballIdentity.js:254` |
| `email`/`mobile` (§3.1) | conditional, as usual | conditional, as usual | conditional, as usual — but see the guest-with-no-contact WARN at `gameballOrderApi.js:612-615`, which fires whenever a guest order's built body carries neither | `gameballOrderApi.js:612-615` |

`gameballGuestOrderMode` = `SKIP` (a third value alongside `PER_ORDER`/`PER_EMAIL`) makes the guest
switch itself a no-op — `buildGuestIdentity` returns `customerId: ''` with `reason: 'guest_order_mode_skip'`
before minting anything (`gameballIdentity.js:138-140`), and the order settles `SKIPPED`. The resolved
identity is persisted to `Order.custom.gbCustomerIdSource` (values `PROFILE`/`LOGIN_MATCH`/
`GUEST_PER_ORDER`/`GUEST_PER_EMAIL`) so an operator can read which rung fired
(`system-objecttype-extensions.xml:344-350`).

### 3.5 Response (§13.3 line 2008)

| Response field | Type | What the cartridge does | Persisted to | Source |
|---|---|---|---|---|
| `customerId` | string | **discarded** — the echoed `customerId` is never re-read from the response body; `gbCustomerId` is populated from `outcome.body.customerId`, i.e. from the payload the cartridge itself **sent**, not from anything Gameball returned | `Order.custom.gbCustomerId` (from the sent body) | `gameballOrderApi.js:414-432,626-627` |
| `rewardedPoints` · `redeemedPoints` | number | discarded entirely — no attribute stores either | — | `gameballOrderApi.js:414-432` (only `disposition`/`code`/`requestId`/`message`/`body` are extracted) |
| `lineItems[].{productId,quantity,decimalPoints,points,score}` | — | discarded entirely | — | same |

`gbGameballOrderId`/`gbCustomerId` store the values the cartridge **sent**, not anything Gameball
returned — the metadata description at `system-objecttype-extensions.xml:324` and `:331` says so
explicitly ("The exact orderId value sent…", "The exact customerId value sent…"), and the code's own
comments (`gameballOrderApi.js:619-623,655-658`) name this deliberately: the value that was actually
POSTed is the correct one to persist, both on a fresh 2xx and on an `ALREADY_APPLIED` confirmation of an
earlier attempt.

---

## 4. Refund / reverse — `POST /api/v4.0/integrations/transactions/refund`

**Reachable from:** the public helper `gameballRefundApi.submitRefund(options)`
(`gameballRefundApi.js:355`) — **no controller in this repository calls it**; it is the documented
integration point for a merchant's OMS/PSP/middleware (`docs/refunds-integration-guide.md`) — and the
`Gameball Refund Detector` job's two passes (`steptypes.json:64-83` → `detectRefunds.js:413` →
Pass A `processOneCancellation:216-320`, Pass B `processOnePending:328-366`), both funnelling through
`refundDelivery.deliverEntry(order, entry)` (`refundDelivery.js:295`), the **only** function in the
cartridge that issues this call. **Never** via a `dw.order.payment.refund` hook — that hook belongs to
the merchant's PSP and is explicitly never registered (`gameballRefundApi.js:12-34`,
`refundDelivery.js` module comment absent by design — the warning lives at the call-site module).

### 4.1 Root object (§13.5)

| Gameball field | Type | Req | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|---|
| `customerId` | string | **Yes** | `order.custom.gbCustomerId` | replayed verbatim from what §3 persisted — never re-derived | SENT | `refundPayload.js:213,222` |
| `refundTransactionId` | string | **Yes** | minted by `refundStateStore.mintRefundTransactionId()` | `<gbGameballOrderId or orderNo>-R<seq>` (or `-CB<seq>` for `CHARGEBACK`, or `-X<externalRefundId>` when the caller supplied one) — the id is allocated **inside** the same transaction as `gbRefundSeq`'s increment, so two refunds recorded back to back never collide | SENT | `refundStateStore.js:167-187,254-257 → refundPayload.js:223` |
| `reverseTransactionId` | string | **Yes** | `order.custom.gbGameballOrderId` | **the original `orderId`, replayed verbatim.** Never re-derived from `order.getOrderNo()`, never trimmed or case-folded → M6; drift yields `9005`, not a no-op | SENT | `refundPayload.js:214,229` |
| `transactionTime` | string ISO-8601 UTC | **Yes** | `entry.transactionTime`, itself `occurredAt.toISOString()` where `occurredAt` defaults to `new Date()` at the moment the refund was **recorded** | docs say "the original transaction" (§13.5 line 2061); every worked example in §13 passes the refund moment, and this is what the cartridge sends → **M14, OPEN QUESTION** | SENT | `refundStateStore.js:258,263 → refundPayload.js:230`; entry minted `gameballRefundApi.js:433` (`occurredAt: options.occurredAt \|\| null`) |
| `email` | string | Conditional | `order.getCustomerEmail()` | key omitted entirely when falsy | COND | `refundPayload.js:237-239` |
| `mobile` | string | Conditional | billing address phone **only** — deliberately no shipping-address fallback, unlike §3.1's `resolveMobile` | asymmetric by design (see the module comment at `refundPayload.js:36-40`) | COND | `refundPayload.js:44-55,242-244` |
| `refundAmount` | number | No | `entry.refundAmount` | **omit ⇒ full reversal.** This is how "cancel" is expressed — Gameball has **no** cancel/update/delete endpoint (§13.5 line 2080). Sent only when `typeof === 'number' && !== 0` | COND | `refundPayload.js:259-261` |
| `merchant` | object | No | §4.3 | | SENT | `refundPayload.js:231-234` |
| `lineItems` | array\<LineItem\> | No | §4.2 | full reversal replays every line at full quantity; a partial replays the caller-selected UUIDs at the caller's quantity; a bare monetary partial with no selection sends no `lineItems` key at all | COND | `refundPayload.js:263-281` |

### 4.2 `lineItems[]` (same shape as §3.2)

| Gameball field | Type | Req | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|---|
| `productId` | string | No | `lineItemPayload.build(order)` reused unmodified | identical to §3.2's row — the refund payload calls the **same, unmodified** `lineItem.js:build()` | SENT | `refundPayload.js:108,143 → lineItem.js:167-205` |
| `quantity` | number | No | full reversal: the built quantity (order quantity); partial: `requested.quantity`, the caller's own supplied figure, overwriting the built value | COND | `refundPayload.js:171` (partial override) |
| `price` | number | No | unchanged from §3.2's build — a per-unit figure, correct unchanged for a partial | SENT | `lineItem.js:170` |
| `sku` | string | No | unchanged from §3.2 | COND | `lineItem.js:158-165` |
| `title` | string | No | unchanged from §3.2 | SENT | `lineItem.js:172` |
| `category` | array\<string\> | No | unchanged from §3.2 | COND | `lineItem.js:176-179` |
| `vendor` | string | No | unchanged from §3.2 | COND | `lineItem.js:181-188` |
| `taxes` | number | No | unchanged from §3.2 — **already per-quantity**, so a partial's quantity override does not need to re-derive it | SENT | `lineItem.js:193-194` |
| `discount` | number | No | unchanged from §3.2 | SENT | `lineItem.js:196-197` |
| `extra` | object | Conditional | unchanged from §3.2, `{sfccUUID, masterId}` — `sfccUUID` is also the index key the partial-selection matcher uses | COND | `lineItem.js:199-202 → refundPayload.js:144-152` |
| `tags` · `collection` · `weight` | — | No | same as §3.2 | SKIP-NO-SOURCE | `PLAN §13.3 (lines 1991,1993-1994)` |

### 4.3 `merchant`

| Gameball field | Type | Req | SFCC source | Status | Source |
|---|---|---|---|---|---|
| `merchant.uniqueId` | string | No | `Site.getCurrent().getID()` | SENT | `refundPayload.js:232` |
| `merchant.name` | string | No | `Site.getCurrent().getName()` | SENT | `refundPayload.js:233` |
| `merchant.branch.uniqueId` / `.name` | object | Conditional | — | SKIP-NO-SOURCE | no BOPIS store-id source, mirrors §3.1 |

### 4.4 Must never be sent (§13.5 line 2067)

| Field | Status | Source |
|---|---|---|
| `transactionId` | SKIP-DECISION | `PLAN §13.5 (line 2067)` |
| `amount` | SKIP-DECISION | `PLAN §13.5 (line 2067)` |
| `points` | SKIP-DECISION | `PLAN §13.5 (line 2067)` |
| `hash` | SKIP-DECISION | `PLAN §13.5 (line 2067)` |
| `otp` | SKIP-DECISION | `PLAN §13.5 (line 2067)` |
| `ignoreOTP` | SKIP-DECISION | `PLAN §13.5 (line 2067)` |
| **`reason`** | SKIP-DECISION — the ledger *stores* a caller-supplied `reason` for audit (`refundStateStore.js:269`), but it is never put on the wire; `refundPayload.build()` has no `reason` assignment anywhere | `PLAN §13.5 (line 2067)` |
| `holdReference` | SKIP-DECISION | `PLAN §13.5 (line 2067)` |
| `orderId` | SKIP-DECISION — note the field that *is* sent is `reverseTransactionId`, replaying the original `orderId`'s value under a different key name (§4.1) | `PLAN §13.5 (line 2067)` |
| any idempotency-key header | SKIP-DECISION — the idempotency mechanism is `refundTransactionId` in the body, not a header | `PLAN §13.5 (line 2067)` |

Confirmed by `rg -n "\.transactionId|\.amount\b|\.points\b|\.hash\b|\.otp\b|ignoreOTP|holdReference|\.orderId\b" cartridges/int_gameball_core/cartridge/models/payload/refundPayload.js` → zero hits on the forbidden set (the file *does* reference `order.getOrderNo()` for logging/error text, never for a payload key).

### 4.5 Response (§13.5 line 2072)

| Response field | Type | What the cartridge does | Persisted to | Source |
|---|---|---|---|---|
| `gameballTransactionId` | **string here, number on cashback/manual** → M2 | read via `readResponseField(result, 'gameballTransactionId')`, coerced with `String()` | `gbRefundLedger[].gameballTransactionId` (JSON array element) | `refundDelivery.js:117-151,172-184`; persisted `refundStateStore.js:433-435` |
| `refundTransactionId` | string | read and **re-asserted** against the id this entry actually sent — a mismatch on a `9004` response is escalated to `PERMANENT` rather than trusted (the defence M2/§7 exists for) | not separately persisted — the entry's own id is authoritative | `refundDelivery.js:395-403` |
| `refundAmount` | number | **discarded** — `entry.acceptedAmount` is set from `entry.refundAmount` (what was **sent**), never from the response's echoed figure | `gbRefundLedger[].acceptedAmount` (from the sent value) | `refundDelivery.js:185,436-437` |
| `refundEquivalentPoints` | number | discarded entirely — no attribute stores it | — | `refundDelivery.js:166-275` (not read) |

### 4.6 Reversal semantics that change what to send

- **Omitting `lineItems` reverses only the cashback** — campaign-based points are left untouched, with
  **no warning in the 200** (§13.5 line 2078). The cartridge therefore always attempts to build
  `lineItems` on a full reversal (`refundPayload.js:263-267`) and treats a build failure as a hard error
  routed to `MANUAL_REVIEW` (`refundPayload.js:82-122`) rather than silently sending a cashback-only
  reversal.
- A **full** refund removes all points *including* campaign points; a **partial** deducts proportionally
  — the cartridge's own proration (`gameballRefundApi.js:207-308`) computes the amount to send using
  `getProratedPrice()`, never `getAdjustedPrice(true)`, specifically so BOGO/order-level discounts are
  spread correctly across every affected line (comment at `gameballRefundApi.js:245-253`).
- **Balances may go negative by design**; Gameball neither blocks nor errors (§13.5 line 2079) — not
  guarded against anywhere in the cartridge, correctly, since there is nothing to guard against.

---

## 5. Widget init — `GbSdk.init({…})`

**The widget is a WRITE path.** §13.9 line 2150: *"Every time the widget is initialized with customer
data, the customer profile is created or updated."* Every row below writes to the same profile §2 writes
to → **M9**. **Reachable from:** `Gameball.js:121` (`server.get('Widget', server.middleware.include, …)`)
via `pageFooter.isml:34`'s `<isinclude url="${URLUtils.url('Gameball-Widget')}"/>`, rendering
`gameball/widget.isml` which emits a JSON data island read client-side by
`static/default/js/gameballWidget.js`, which calls `window.GbSdk.init(config)`
(`gameballWidget.js:92`) after loading `https://assets.gameball.co/widget/js/gameball-init.min.js`.

### 5.1 Documented init options (§13.9 line 2146)

| Gameball field | Type | Req | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|---|
| `APIKey` | string | **Yes** | `gameballCredentials.getApiKey()` | the **public** key. The Secret Key must never reach the browser | SENT | `Gameball.js:47,53,77 → widgetPayload.js:88` |
| `playerUniqueId` | string | **Yes** (may be `''` ⇒ guest view) | `customer.profile.customerNo` | ↔ REST `customerId` → M5. Must be byte-identical to §2/§3. `''` for a guest, or for an authenticated profile with a blank `customerNo` | COND | `Gameball.js:73,77 → widgetPayload.js:93,106-110` |
| `lang` | string | No | `req.locale.id`, falling back to `request.getLocale()` | mapped through `toGameballLang()` — language segment only, lower-cased, falling back to `'en'` when unmapped | SENT | `Gameball.js:75,77 → widgetPayload.js:46-58,94` |
| `platform` | string | No | literal `'salesforce'` | **The `Platform` enum has no `salesforce`/`sfcc` member** (§13.9 line 2151); plan §8.5 (line 1626) mandates the literal `'any'` → **M3, ACCEPTED DIVERGENCE (deliberate, documented, open question to Gameball product)** | MISMATCH | `widgetPayload.js:19,95` |
| `sessionToken` | string (JWE) | No in v3, **required in SDK v4** | — | signed session token is a binding Skip | SKIP-DECISION | `INTEGRATION_GAPS.md:41` |
| `openDetail` | boolean | No | — | not sent — no controller-driven "open the widget detail panel" affordance exists | SKIP-NO-SOURCE | no assignment in `widgetPayload.js` |
| `shop` / `shopify` | string / object | No | — | not sent — Shopify-specific fields, not applicable to SFCC | SKIP-NO-SOURCE | no assignment in `widgetPayload.js` |
| `playerAttributes` | object | No | §5.2 | ↔ REST `customerAttributes` → M5. Omitted entirely (not sent as `{}`) when the built attribute set is empty | COND | `widgetPayload.js:126-150` |

### 5.2 `playerAttributes`

| Gameball field | Type | Req | SFCC source | Transformation | Status | Source |
|---|---|---|---|---|---|---|
| `displayName` | string | No | `profile.firstName`/`profile.lastName` | **`((first \|\| '') + ' ' + (last \|\| '')).trim()` — byte-identical to `customerPayload.js:11`**, with a comment (`widgetPayload.js:128-130`) stating the deliberate match. **M11 is RETIRED**: at `1e98611` the widget built this without `.trim()`; the merged tree trims identically on both writers | COND | `widgetPayload.js:131-134` |
| `firstName` | string | No | `profile.firstName` | omitted (not sent as `''`) when blank — **differs from `customerPayload.js:18`'s `\|\| ''`** | COND | `widgetPayload.js:135-137` |
| `lastName` | string | No | `profile.lastName` | omitted when blank | COND | `widgetPayload.js:138-140` |
| `email` | string | No | `profile.email` | omitted when blank | COND | `widgetPayload.js:141-143` |
| `gender` · `dateOfBirth` · `joinDate` · `custom` | — | No | — | not sent. **Deliberately not expanded**, per the OPEN RISK comment (`widgetPayload.js:112-125`): Gameball's attribute-merge semantics on a repeat upsert are unanswered (plan §6.9 Q1 / arbitration R-8), and if omitting a field NULLS the stored value rather than retaining it, sending `dateOfBirth` here would mean the widget's write path — which fires on every page view — wipes a shopper's birthday every visit. No dateOfBirth is built for the widget until R-8 is settled | GAP | finding F4 |

### 5.3 Undocumented-but-live init options (§13.9 line 2147)

`autoOpen` · `anonymous` · `skip_analytics` · `preview` · `mobile` · `referd` · `containerId` ·
`repeatNotifications` · `page` · `onWidgetOpen` · `onWidgetClose`. **None of the eleven are sent by this
cartridge** — `widgetPayload.build()` (`widgetPayload.js:86-153`) assigns exactly the six keys listed in
§5.1/§5.2 and nothing else, confirmed by
`rg -n "autoOpen|anonymous|skip_analytics|preview|referd|containerId|repeatNotifications|onWidgetOpen|onWidgetClose" cartridges/int_gameball_core/cartridge/models/payload/widgetPayload.js` → zero hits.
Recorded here so a future reader does not mistake the absence for an oversight: `anonymous` in
particular is called out in the build plan as never-set, because it mints `anonymous_*` pseudo-IDs and
pollutes the customer base — this cartridge never triggers that path.

### 5.4 REST equivalence — the divergence check

| REST field (§2) | Widget field (§5) | Same value? | Divergence | Verdict |
|---|---|---|---|---|
| `customerId` | `playerUniqueId` | yes — both `profile.customerNo` (`customerPayload.js:14`, `widgetPayload.js:110`) | none | OK |
| `customerAttributes.displayName` | `playerAttributes.displayName` | **yes, as merged** — both `((first\|\|'')+' '+(last\|\|'')).trim()` | none — M11 is retired (was a mismatch at `1e98611`; the widget item's trim fix landed) | OK, formerly M11/DEFECT |
| `customerAttributes.firstName` | `playerAttributes.firstName` | value yes; **presence differs** | server sends `''` when blank (`\|\| ''`), widget omits the key entirely when blank | ACCEPTED DIVERGENCE — both encode "no first name" correctly, just differently (empty string vs absent key), and Gameball's own upsert semantics treat both as "nothing to set" |
| `customerAttributes.email` (nested) | `playerAttributes.email` | value yes; presence differs, same shape as `firstName` | server `\|\| ''`, widget omits when blank | ACCEPTED DIVERGENCE, same reasoning |
| top-level `email` (the channel-merging key, §2.1) | — | **not sent by the widget at all** — `GbSdk.init` has no documented top-level `email` option (§13.9 line 2146 lists no such field) | a widget-created/updated profile carries no merging identifier via this call | M10 — structural (Gameball's widget contract has no equivalent field), not a cartridge defect |
| `customerAttributes.dateOfBirth` | `playerAttributes.dateOfBirth` | **not sent by the widget** (§5.2) | server sends it when `profile.birthday` is set; widget never does, deliberately, pending R-8 | GAP — see finding F4 |
| `customerAttributes.mobile` | — | not sent by either surface's *nested* attribute (top-level `mobile` exists on §2/§3 only, and the widget has no `mobile` init field at all — §13.9 line 2146) | — | OK — neither surface diverges from the other, both simply omit it here |

---

## 6. Other endpoints the cartridge calls

Reachable from merged code, beyond the four surfaces above:

| Endpoint | Method | Reachable from | Purpose |
|---|---|---|---|
| `integrations/orders/{orderId}/transactions` | GET | `gameballOrderApi.probeOrderTracked(orderNo)` (`gameballOrderApi.js:471-529`), called **only** from `retryFailedOrders.js:470-527` when `gameballRetryProbeBeforeResend` (default on) and the stored disposition is `AMBIGUOUS`. **Not** called from the confirmation-page path (`sendOrder`) — attempt 1 never probes. | Verification before a possibly-duplicate re-`POST` to §3, per build-plan §5.5's "never blind-retry" guard. Response fields read: `count`, `transactions[].transactionType` (matched against `PaymentReward`/`AchievementReward` only) — everything else in the response (`transactionDate`, `gameballTransactionId`, `amount`, `equivalentPoints`) is discarded. |
| `integrations/customers/{customerId}/delete` | POST (documented alias of `DELETE .../{customerId}`) | `gameballPrivacyApi.deleteCustomer(customerId)` (`gameballPrivacyApi.js:364-440`), called only from `erasureDrain.js:371` (`drain()`, inside the `Gameball Customer Erasure` job). Body is a literal `{}`. | Hard delete, no undo, no anonymize alternative (§13.6 line 2096). `404`/`7000` count as success on this scope only (§1.3). The documented fallback if the POST alias 404s on a given account (an explicit `{method: 'DELETE', path: ...}` call, no body) is named in the module comment (`gameballPrivacyApi.js:325-337`) but not implemented — the job's own execute() distinguishes "every call this run came back bare-404" from a genuine erasure and turns the run red rather than silently reporting success (`erasureDrain.js:537-541`). |

That is the complete list. `rg -n "gameballService.call\(" cartridges/int_gameball_core/` matches exactly
five call sites: `gameballCustomerApi.js:597` (§2), `gameballOrderApi.js:415` (§3, `attemptTrack`),
`gameballOrderApi.js:477` (this section's probe), `refundDelivery.js:380` (§4), and
`gameballPrivacyApi.js:396` (this section's delete). The batch/hold/redeem/manual/activate/tags/
tier-progress/coupons/referrals/social-challenges endpoints (§13.6) are **not called anywhere** —
documenting them as rows would claim they are wired, which they are not.

---

## 7. Contract mismatches and traps

Seeded list, re-verified against `d88afeb`. Retired entries keep their number, per §0's stable-anchor
rule.

| Id | Disagreement | Gameball says | Cartridge does | Consequence | Current handling | Verdict |
|---|---|---|---|---|---|---|
| **M1** | Orders payload has no `currency` field | currency is an account-level dashboard setting, §13.3 line 2003 | sends currency only as informational `extra.currency` (`orderPayload.js:227`); the plan's `gameballWorkspaceCurrency` guard (§4.11 line 747) is not implemented anywhere in the merged tree | a multi-currency site posts 100 USD and 100 JPY as the same number to Gameball's earning rules | not implemented — every order's `totalPaid` is a bare number regardless of currency | ACCEPTED DIVERGENCE (multi-site/multi-currency config is a binding Skip) |
| **M2** | `gameballTransactionId` is a string on refund, a number on cashback/manual (§13.5 line 2076) | — | `refundDelivery.js:184` coerces with `String(v)` before storing | comparing a stored id against a fresh response without normalising would silently never match | correctly normalised at the one place it is read | ACCEPTED DIVERGENCE (correctly handled) |
| **M3** | Widget `Platform` enum has no `salesforce`/`sfcc` member (§13.9 line 2151) | — | `widgetPayload.js:19` sends the literal `'salesforce'`, deliberately, with a comment naming the alternative (`'any'`, per plan §8.5 line 1626) and the rejected fix | `applyCoupon()` has branches for Shopify/BigCommerce only, so a dead button — but redemption is Skip and the button is unreachable | unchanged, per arbitration V-12 ("not a scope violation, correctly flagged, correctly left unchanged") | ACCEPTED DIVERGENCE / open question to Gameball product |
| **M4** | `lineItems[].taxes` and `.discount` are documented PER QUANTITY, not per line (§13.3 lines 1995-1996) | — | `lineItem.js:194,197` divides by quantity — correct | documented here so nobody "fixes" it back to the line total | correct as implemented | ACCEPTED DIVERGENCE |
| **M5** | Widget/REST naming split: `playerUniqueId` ↔ `customerId`, `playerAttributes` ↔ `customerAttributes` (§13.9 line 2149) | — | same identity, two names, two writers (§2, §5) | none in practice — see §5.4's divergence check, values now agree everywhere they overlap | naming-only | ACCEPTED DIVERGENCE |
| **M6** | `orderId` is case-sensitive (§13.3 line 1963) and is replayed as `refund.reverseTransactionId` | casing drift → `9005` | `refundPayload.js:214,229` reads `order.custom.gbGameballOrderId` verbatim, never re-derives, never case-folds, with an explicit comment warning against it | casing drift silently under-reverses points | correctly implemented as a safeguard | ACCEPTED DIVERGENCE (correctly implemented) |
| **M7** | `extra` values must be string or number only — no booleans, arrays or nested objects (§13.3 line 1979) | — | `orderPayload.js:230,260` sends `isGiftOrder` as `1`/`0`, never `true`/`false`, with a comment naming the constraint | none — implemented correctly | correct as implemented | ACCEPTED DIVERGENCE |
| **M8** | `channel` comparison type | `getChannelType()` returns an `EnumValue`, and `LineItemCtnr.CHANNEL_TYPE_*` are not confirmed string/primitive-comparable (plan §5.2 line 853) | `orderPayload.js:159-167` compares them with `switch`/`case` (JS strict-equality semantics), so the default branch almost certainly always wins and every order reports `web` | `channel` is silently useless for anything but the default value on every order | **unverified and unfixed** — verified still present, byte-identical to the pre-item-05 implementation | **DEFECT**, unresolved |
| **M9** | The widget is a second writer to the same profile (§13.9 line 2150, plan §6.4 lines 1171-1175) | — | `GbSdk.init` carrying `playerAttributes` races the server upsert (`2001 Concurrent Request`) and *may* null server-set attributes — Gameball has not answered whether omitted attributes merge or wipe | unresolved — the widget deliberately does not send `dateOfBirth` for exactly this reason (§5.2, finding F4) | mitigated by omission, not solved | OPEN QUESTION |
| **M10** | Top-level `email` is the channel-merging key, distinct from `customerAttributes.email` (§13.4 line 2038) | — | the server sends both (`customerPayload.js:15,20`); the widget sends **neither** a top-level `email` (§13.9 line 2146 documents no such widget field at all) | a widget-created/updated profile cannot merge by email | structural — Gameball's own `GbSdk.init` contract has no top-level email option | ACCEPTED DIVERGENCE (not a cartridge defect — no equivalent field exists to send) |
| **M11** | `displayName` built twice, differently | — | **retired** — `customerPayload.js:11` and `widgetPayload.js:131` are byte-identical expressions, both `.trim()`ed, with a comment at `widgetPayload.js:128-130` explicitly stating the match is deliberate | none — resolved | fixed | **(retired in the widget-xss item — displayName now matches on both writers)** |
| **M12** | Auth header casing | §13.1 line 1930: the Authentication page writes `APIKey`/`SecretKey`, per-endpoint pages write `apikey`/`secretkey`, older SDK guides write `TransactionKey` | HTTP headers are case-insensitive; the cartridge sends `APIKey`/`SecretKey` (`gameballService.js:23-24`) | none — documented so nobody "corrects" the casing | correct as implemented | ACCEPTED DIVERGENCE |
| **M13** | No rate-limit response headers are documented (§13.7 line 2118) — no `Retry-After`, no `X-RateLimit-*`, no prescribed backoff | — | any retry interval in the cartridge (`gameballRetryBackoffMinutes`, `BACKOFF_BASE_SECONDS` in `refundDelivery.js:43`) is a guess, and is labelled as one in the metadata description | a backoff schedule tuned against Gameball's actual server-side ceiling could be materially wrong in either direction | fixed, documented backoff ladders on both order retry and refund delivery | OPEN QUESTION |
| **M14** | `transactionTime` semantics on refund | §13.5 line 2061: docs say "the timestamp of the *original* transaction" | every worked example in §13 passes the refund moment; the merged cartridge sends **the refund moment** — `refundStateStore.js:258,263` stamps `occurredAt` (defaulting to `new Date()`) at record time, never the order's own `orderDate` | if Gameball's server actually expects the original transaction's time, every refund's `transactionTime` is wrong | sends the refund moment, matching the worked examples over the literal prose; `9003` on REFUND scope is deliberately routed to `MANUAL_REVIEW` rather than trusted as success, specifically because this ambiguity is unresolved (`gameballErrors.js:249-261`) | OPEN QUESTION |
| **M15** | `9004`/`9003`/`9001`/`7001` are success signals, not errors (plan §4.4 lines 550-553) | — | **resolved as of `d88afeb`** — `gameballErrors.js`'s shared classifier reads the Gameball `code` and routes each to a `SUCCESS`-equivalent disposition (`ALREADY_APPLIED`) on the scope(s) that can actually produce it: `7001` on the customer default table only (`:77`; `9004`/`9003`/`9001` are transaction-family codes and are never reachable on customer upsert — `SCOPE_TABLES.CUSTOMER` is empty, `:97`), `9004`/`9001` on both ORDER and REFUND, `9003` on ORDER only (REFUND deliberately diverges — M14) | at `1e98611` these were misread as failures; not any more, provided the underlying envelope is reachable at all (see R-1 below) | the code path exists and is exercised by every caller; whether it *works* in practice depends on R-1 | resolved in code / OPEN QUESTION on the platform fact it depends on (R-1) |

---

## 8. Reverse coverage — SFCC data read but never sent

Only values that are genuinely *read* and then dropped — a Gameball field with no SFCC source at all is
a `SKIP-NO-SOURCE` row in its own surface, not a row here.

| SFCC value | Read at | Where it goes | Why it is not sent | Risk |
|---|---|---|---|---|
| `order.getCurrencyCode()` | `orderPayload.js:88,123,143,227,299`; `refundPayload.js` (implicitly, via `gameballMoney.roundToCurrency`) | rounding precision + `extra.currency` | Gameball has no currency field (§13.3 line 2003); currency is an account-level dashboard setting | **High** — a multi-currency site posts 100 USD and 100 JPY as the same number. The plan's workspace-currency guard (§4.11 line 747) is unimplemented → M1 |
| Payment-instrument transaction **amounts** | `orderPayload.js:46-53,68-80` (`getInstrumentAmount`) | consumed by the `totalPaid` subtraction, then discarded | Gameball has no tender breakdown field | Low — `extra.paymentMethods` carries the method IDs (`orderPayload.js:240`), which is what earning-rule exclusions need |
| `profile.phoneHome` / `phoneBusiness` | `customerPayload.js:24` | collapsed into one `mobile` (first non-empty of mobile/home/business wins) | Gameball has one `mobile` field on the customer upsert | Low, **but** under mobile-based channel merging the wrong number becomes the merge key if the shopper has more than one on file → §2.1 |
| `pli.getTax()` line total | `lineItem.js:193` | divided by quantity | `taxes` is documented **per quantity** (§13.3 line 1995) | None — the division is correct. Recorded so nobody "fixes" it back → M4 |
| `order.getShipments()` | `orderPayload.js:229,248-251` | only `.size()` → `extra.shipmentCount` | Gameball has no shipment concept (plan §5.2.1 line 867) | Low — split-shipment orders are indistinguishable from single-shipment ones in Gameball's data |
| `order.getOriginalOrderNo()` | `orderSyncGate.js:33-43` | consumed only to decide `shouldTrack` (replacement-order skip), never sent as a field | replacement-order reversal is a binding Skip; the original order's points are never adjusted when the replacement is skipped | Medium — the *replacement* itself simply never syncs, but the *original* order's already-awarded points are never reversed or corrected either, and nothing in this cartridge tracks that relationship afterwards |
| `profile.isMale()` / `.isFemale()` | not read at all (checked; `customerPayload.js` has no call to either) | — | `gender` is not built into `customerAttributes` | None — simply unbuilt, not read-then-dropped. Listed here for completeness against §2.2's `SKIP-NO-SOURCE` row, which already covers it |
| Payment instrument `getPaymentMethod()` per instrument | `orderPayload.js:234-242` | joined into `extra.paymentMethods` as a comma-separated string | Gameball has no structured payment-method array field on order tracking | None — `extra.paymentMethods` is the accepted, documented workaround |

### 8.1 Read nowhere, wanted by Gameball

A cross-reference, not a second table: `customerAttributes.{gender, joinDate, country, city, zip,
preferredLanguage, source, channel, paymentMethods, totalSpent, lastOrderDate, totalOrders,
avgOrderAmount, utms, devices, custom}` and `lineItems[].{tags, collection, weight}` are `SKIP-NO-SOURCE`
rows in §2.2 and §3.2. Named here so a reader looking for "what are we not sending at all" finds one
entry point.

---

## 9. Worked examples

Every value below is synthetic — invented order numbers, invented customer numbers, invented names. No
real capture informed any of them (there is no sandbox or Test API Key in this environment), so every
example carries `captureState: "synthetic (never sent)"`. Placeholders only for credentials:
`<APIKey from gameball.http.api.cred>`; the Secret Key never appears, including in the widget examples,
because it must never reach the browser (`gameballCredentials.js:36-44`).

### E1 · customers · Registered shopper, first+last name, birthday, `phoneHome` only, email present

**SFCC object:** `dw.customer.Profile` — `customerNo: "00012345"`, `firstName: "Alex"`,
`lastName: "Rivera"`, `email: "alex.rivera@example.com"`, `phoneMobile: null`,
`phoneHome: "+1 555 0134"`, `phoneBusiness: null`, `birthday: 1990-03-14` (local midnight, site
default time zone).

**Request** (`POST integrations/customers`, source `ACCOUNT_SUBMIT_REGISTRATION`):

```json
{
  "customerId": "00012345",
  "email": "alex.rivera@example.com",
  "customerAttributes": {
    "displayName": "Alex Rivera",
    "firstName": "Alex",
    "lastName": "Rivera",
    "email": "alex.rivera@example.com",
    "dateOfBirth": "1990-03-14"
  },
  "mobile": "+1 555 0134"
}
```

**What it exercises:** the `.trim()` on `displayName` (no leading/trailing space since both names are
present); the `Calendar`/`yyyy-MM-dd` conversion (`customerPayload.js:29-35`) — note the UTC-timezone gap
recorded at §2.2, so a birthday near local midnight could land on 03-13 or 03-15 depending on instance
timezone, UNVERIFIED without a sandbox; and the phone fallback chain landing on `phoneHome` because
`phoneMobile` is null.

**Response** (documented shape, §13.4 line 2050): `{ "gameballId": 9182736 }`.
**Capture state:** synthetic (never sent).

### E2 · orders · Registered, 2 line items, one line-level promo, an order-level coupon, gift-certificate part-payment

**SFCC object:** Order `#00045678`, currency `USD`, customer `00012345`, placed via web storefront.
Line 1: product `SHIRT-BLU-M`, qty 2, base price $25.00, a 10%-off line promo (-$5.00), tax $2.00 total
for the line. Line 2: product `HAT-RED`, qty 1, base price $15.00, no line promo, tax $1.20. Order-level
coupon `SAVE10` applies a $5.00 order-level adjustment. Payment: $50.00 via CREDIT_CARD +
$8.20 via `GIFT_CERTIFICATE`. `gameballExcludeGiftCertificateTender` is `true` (the default).

**Request** (`POST integrations/orders`, from `Order-Confirm`):

```json
{
  "customerId": "00012345",
  "orderId": "00045678",
  "orderDate": "2026-08-20T14:32:05.000Z",
  "totalPaid": 50.00,
  "totalPrice": 68.20,
  "totalDiscount": 5.00,
  "totalShipping": 0,
  "totalTax": 3.20,
  "channel": "web",
  "guest": false,
  "cartId": "a1b2c3d4-...",
  "merchant": { "uniqueId": "RefArch", "name": "SFRA Demo Site" },
  "extra": {
    "siteId": "RefArch", "locale": "en_US", "currency": "USD",
    "shipmentCount": 1, "isGiftOrder": 0, "sourceCode": "",
    "paymentMethods": "CREDIT_CARD,GIFT_CERTIFICATE"
  },
  "email": "alex.rivera@example.com",
  "mobile": "+1 555 0134",
  "lineItems": [
    { "productId": "SHIRT-BLU-M", "quantity": 2, "price": 25.00, "sku": "SHIRT-BLU-M", "title": "Blue Shirt", "taxes": 1.00, "discount": 2.50 },
    { "productId": "HAT-RED", "quantity": 1, "price": 15.00, "sku": "HAT-RED", "title": "Red Hat", "taxes": 1.20, "discount": 0 }
  ]
}
```

**What it exercises:** `totalPaid` tender exclusion — gross price $58.20 minus the $8.20 gift-certificate
tender = $50.00, per `orderPayload.js:64-89`; per-quantity `taxes`/`discount` on line 1 ($5.00 ÷ 2 =
$2.50, $2.00 ÷ 2 = $1.00); `totalDiscount` = the $5.00 order-level coupon **only**, never derived from
`totalPrice − totalPaid` (which would incorrectly count the $8.20 gift-certificate tender as a
"discount").
**Response** (documented shape): `{ "customerId": "00012345", "redeemedPoints": 0, "rewardedPoints": 50, "lineItems": [{"productId": "SHIRT-BLU-M", "quantity": 2, "decimalPoints": 36.36, "points": 36, "score": 0}, {"productId": "HAT-RED", "quantity": 1, "decimalPoints": 13.64, "points": 13, "score": 0}] }` — entirely discarded by the cartridge (§3.5).
**Capture state:** synthetic (never sent).

### E3 · orders · Guest order, `PER_EMAIL` mode

**SFCC object:** Order `#00045700`, no registered profile, checkout email `guest@example.com`,
`gameballTrackGuestOrders=true`, `gameballGuestOrderMode=PER_EMAIL`, `gameballLinkGuestOrdersByLogin=true`
finds no matching login.

**Request** (`POST integrations/orders`):

```json
{
  "customerId": "gb_guest_3f2b9a...c1",
  "orderId": "00045700",
  "orderDate": "2026-08-20T15:00:00.000Z",
  "totalPaid": 30.00,
  "guest": true,
  "email": "guest@example.com",
  "...": "remaining fields identical in shape to E2"
}
```

`customerId` is `gb_guest_` + SHA-256 hex of `"guest@example.com|RefArch"`, 73 characters, safely under
the 100-char cap (`gameballIdentity.js:159-163,182-189`). `guest: true` because rung 3 (true guest)
resolved, not rung 1 or 2. If `gameballLinkGuestOrdersByLogin` had matched an existing customer login,
`customerId` would instead be that customer's raw `customerNo` and `guest` would read `false` (rung 2,
§3.4).

**Capture state:** synthetic (never sent).

### E4 · refund · Full reversal

**SFCC object:** Order `#00045678` (from E2), now `CANCELLED`, `gbGameballOrderId="00045678"`,
`gbCustomerId="00012345"`, `gbTrackedTotalPaid=50.00`, `gbTrackedCurrency="USD"`.

**Request** (`POST integrations/transactions/refund`, from the Refund Detector's Pass A):

```json
{
  "customerId": "00012345",
  "refundTransactionId": "00045678-R1",
  "reverseTransactionId": "00045678",
  "transactionTime": "2026-08-25T09:00:00.000Z",
  "merchant": { "uniqueId": "RefArch", "name": "SFRA Demo Site" },
  "email": "alex.rivera@example.com",
  "mobile": "+1 555 0134",
  "lineItems": [
    { "productId": "SHIRT-BLU-M", "quantity": 2, "price": 25.00, "sku": "SHIRT-BLU-M", "title": "Blue Shirt", "taxes": 1.00, "discount": 2.50 },
    { "productId": "HAT-RED", "quantity": 1, "price": 15.00, "sku": "HAT-RED", "title": "Red Hat", "taxes": 1.20, "discount": 0 }
  ]
}
```

**What it exercises:** `refundAmount` is **omitted entirely** — this is how "cancel" is expressed
(§13.5 line 2080); every product line item is replayed at full quantity so campaign/collection points
are reversed correctly, not just base cashback (`refundPayload.js:107-122`).
**Capture state:** synthetic (never sent).

### E5 · refund · Partial with `lineItems` and a computed `refundAmount`

**SFCC object:** same order, a merchant OMS calls `submitRefund({orderNo: '00045678', kind: 'RETURN', lineItems: [{productLineItemUUID: '<shirt-uuid>', quantity: 1}], externalRefundId: 'oms-9981'})` for one returned shirt.

**Request:**

```json
{
  "customerId": "00012345",
  "refundTransactionId": "00045678-Xoms-9981",
  "reverseTransactionId": "00045678",
  "transactionTime": "2026-08-26T10:15:00.000Z",
  "merchant": { "uniqueId": "RefArch", "name": "SFRA Demo Site" },
  "email": "alex.rivera@example.com",
  "mobile": "+1 555 0134",
  "refundAmount": 21.36,
  "lineItems": [
    { "productId": "SHIRT-BLU-M", "quantity": 1, "price": 25.00, "sku": "SHIRT-BLU-M", "title": "Blue Shirt", "taxes": 1.00, "discount": 2.50 }
  ]
}
```

**What it exercises:** the `refundTransactionId` minting scheme — namespaced under the order's
`gbGameballOrderId` and the caller's `externalRefundId` (`refundStateStore.js:171-180`), allocated
**once**, inside the same transaction as the `gbRefundSeq` increment, so a retried `submitRefund` call
with the same `externalRefundId` returns the existing entry rather than minting a second one
(`refundStateStore.js:220-297`); `refundAmount` computed by `getProratedPrice()` proration for one of the
two shirt units (`gameballRefundApi.js:207-308`), not simply half of the line's `price`.
**Capture state:** synthetic (never sent).

### E6 · widget · Authenticated shopper

**Rendered page source** (`gameball/widget.isml`, data island, decoded):

```json
{
  "APIKey": "<APIKey from gameball.http.api.cred>",
  "playerUniqueId": "00012345",
  "lang": "en",
  "platform": "salesforce",
  "playerAttributes": {
    "displayName": "Alex Rivera",
    "firstName": "Alex",
    "lastName": "Rivera",
    "email": "alex.rivera@example.com"
  }
}
```

Note the absence of `dateOfBirth` (§5.2, GAP finding F4) and of any top-level `email` (M10). The
`GbSdk.init({…})` argument as it appears in browser devtools after `gameballWidget.js:92` runs is
byte-identical to this object.
**Capture state:** synthetic (never sent).

### E7 · widget · Anonymous visitor

**Rendered page source:**

```json
{
  "APIKey": "<APIKey from gameball.http.api.cred>",
  "playerUniqueId": "",
  "lang": "en",
  "platform": "salesforce"
}
```

No `playerAttributes` key at all — `widgetPayload.build()` returns the guest-shaped payload before ever
reaching the attribute-building code, whether because `profile` is `null` (unauthenticated session,
`Gameball.js:73`) or because an authenticated profile carries a blank `customerNo` (`widgetPayload.js:106-108`).
`playerUniqueId: ''` is Gameball's documented guest-view contract (§13.9 line 2146); the widget renders
in anonymous mode and creates no Gameball profile from this call. Whether an **absent** `playerUniqueId`
key (vs. an explicit empty string) behaves differently is UNVERIFIED — this cartridge always sends the
key, so the distinction is moot here.
**Capture state:** synthetic (never sent).

---

## 10. Coverage reconciliation and findings

### 10.1 Row counts

| Surface | §13 fields enumerated | Rows written | Delta |
|---|---|---|---|
| Auth headers (§13.1) | 4 | 4 | 0 |
| Orders (§13.3: root 18 + lineItems 13 + redemption 3 + merchant 4 + cashbackConfigurations 1 + the documented `currency` absence 1 = 40; response 8) | 40 + 8 | 40 + 8 (§3.1: 18 rows; §3.2: 13 rows; §3.5: 3 response rows covering all 8 named fields, grouped) | 0 (response fields grouped 3 rows / 8 names — every name appears in prose) |
| Customers (§13.4: root 8 + customerAttributes 22 + not-writable 6 (4 rows) = 36; response 1) | 36 + 1 | §2.1: 8 rows; §2.2: 22 rows; §2.3: 4 rows (6 field names); §2.5: 1 row | 0 |
| Refund (§13.5: root 9 + merchant 4 + lineItems 13 + must-not-send 10 = 36; response 4) | 36 + 4 | §4.1: 9 rows; §4.2: 11 rows (`quantity`/`price` folded into the reuse-of-§3.2 rows, all 13 field names covered in prose + rows); §4.3: 3 rows (4 field names); §4.4: 10 rows; §4.5: 4 rows | 0 |
| Widget (§13.9: documented 9 + playerAttributes 8 + undocumented 11 = 28) | 28 | §5.1: 8 rows (`playerAttributes` itself is the object row, its members are §5.2); §5.2: 4 rows (8 field names, `gender`/`dateOfBirth`/`joinDate`/`custom` grouped into one GAP row); §5.3: 1 grouped row (11 names) | 0 |

**A non-zero delta is a finding, not a rounding error.** Every surface reconciles to zero once
grouped/summarized rows are expanded back to individual field names (noted per surface above) — no §13
field was silently dropped from this document. The original spec's own estimates ("~39+8", "~36+1",
"~36+4", "~28") match this count within rounding; the order-surface count of 40 (vs the spec's "~39")
is one higher because this document explicitly rows the documented **absence** of `currency` as its own
line (the "no field" row in §3.1), which the spec's own estimate likely did not count as a row.

### 10.2 Status distribution

Counted across every field-level row in §2–§5 (excluding response sub-tables and the grouped
undocumented-widget-options row, counted once each per §10.1's field-name totals):

| Status | Count (approx., by distinct field name) | Notes |
|---|---|---|
| `SENT` | 24 | `customerId` ×3 surfaces, `orderId`, `orderDate`, `totalPrice`, `totalDiscount`, `totalShipping`, `totalTax`, `guest`, `cartId`, `merchant.uniqueId`/`.name` ×2 surfaces, `productId`, `quantity`, `price`, `title`, `taxes`, `discount`, `firstName`/`lastName` (customer), `refundTransactionId`, `reverseTransactionId`, `transactionTime`, `APIKey`, `lang` |
| `COND` | 15 | `email` ×3, `mobile` ×3, `customerAttributes`, `lineItems` ×2, `sku`, `category`, `vendor`, `extra` ×2, `refundAmount`, `dateOfBirth`, `playerUniqueId`, `playerAttributes` |
| `MISMATCH` | 3 | `channel` (M8, DEFECT), `platform` (M3), the `currency`-absence row (M1) |
| `SKIP-DECISION` | 21 | `referrerCode`, `redemption.*` (3), the 10 refund forbidden fields, `tags`/`level-tier`/`playerAttributes`/`points-balance-referralCode` (customer, 4 rows), `sessionToken` |
| `SKIP-NO-SOURCE` | ~34 | `deviceToken`, `osType`, `guest` (customer), `merchant.branch.*` ×2 surfaces (4), `cashbackConfigurations.returnWindow` is GAP not this — see below; `lang` header (§1.1); the ~16 unread `customerAttributes` fields; `tags`/`collection`/`weight` ×2 surfaces (6); `openDetail`/`shop`/`shopify` |
| `GAP` | 3 | `cashbackConfigurations.returnWindow`, the widget's `gender`/`dateOfBirth`/`joinDate`/`custom` group, `v4.1` environment row is SKIP-NO-SOURCE not GAP — corrected: GAP count is 2 (`returnWindow`, widget-attrs group) |
| `SENT+PROVEN` | 0 | No wire capture exists in this environment (front matter) |

Every `GAP` row appears in §10.3 below.

### 10.3 Findings

**F1 · GAP-adjacent, platform-fact, merge gate (arbitration R-1).** Whether
`dw.svc.Result#errorMessage` carries the raw non-2xx response body on this SFCC version, and whether
`parseResponse` (`gameballService.js:41-52`) is invoked at all on a non-2xx response, is UNVERIFIED — no
sandbox exists in this environment. §1.3's entire error-code catalogue depends on it. **Searched for:**
a `dw.svc.Result` API reference confirming `errorMessage`'s exact content on failure; not found in the
vendored `dw-api-mock` (per standards §5.4) or anywhere in this repo. **Suggested owner:** whoever runs
the arbitration §8 R-1 spike (a deliberately malformed `POST integrations/customers` with a temporary
`Logger.error` dump of `result.error`/`errorMessage`/`status`/`unavailableReason`/`getObject()`).

**F2 · a real (not hypothetical) unresolved assumption inline in merged code.** Whether a `7001`
"customer already exists" response's submitted `customerAttributes` are actually applied by Gameball is
undocumented; if not, `gameballCustomerApi.js:612-632`'s own comment says the current code writes
`gbSyncHash` anyway, which would silently and permanently suppress a resync via the delta job even after
a merchant fixed channel merging. **Searched for:** a documented answer in `GAMEBALL_SFCC_CARTRIDGE_PLAN.md`
§13.4; none exists — the plan itself marks this open (build-plan §6.9 Q1 / arbitration R-8, which this
finding is a corollary of). **Suggested owner:** whoever settles R-8 (ask Gameball, or a two-call sandbox
test).

**F3 · GAP.** `cashbackConfigurations.returnWindow` (§13.3 line 2001) is documented as *"the primary
defence against negative point balances"* (plan §4.11 line 746). **Searched for:** a preference, a
builder assignment, or an `INTEGRATION_GAPS.md` row addressing it — `rg -n "returnWindow|cashbackConfigurations" cartridges/` → zero hits;
`INTEGRATION_GAPS.md` never mentions it. **No decision exists anywhere.** This is the single most
consequential GAP in this document, per the spec's own standing example (§08 spec, edge case E12).
**Suggested owner:** a future item, or an explicit `Skip`/`Keep` decision added to `INTEGRATION_GAPS.md`.

**F4 · GAP.** The widget never sends `playerAttributes.dateOfBirth`, `gender`, `joinDate` or `custom`,
even though the server-side `customerAttributes.dateOfBirth` (§2.2) is sent whenever `profile.birthday`
is set. This is a **deliberate** omission pending M9/R-8 (`widgetPayload.js:112-125`), not an oversight
— but it means a shopper's birthday-based campaign never fires purely from the widget-only write path
(only the server-side surfaces populate it). **Searched for:** whether this asymmetry is documented
anywhere a merchant would read it before enabling the widget; it is not — only in code comments.
**Suggested owner:** a documentation follow-up (a line in a future widget-facing doc) once R-8 is
answered either way.

**F5 · Not a code defect, but worth stating precisely.** `Order.custom.gbGameballOrderId` and
`Order.custom.gbCustomerId` store the values the cartridge **sent** to Gameball, never anything
Gameball's 200 response actually returned (§3.5). The attribute descriptions in
`system-objecttype-extensions.xml:322-335` already say so plainly ("The exact orderId value sent…"), so
this is not a metadata-vs-code mismatch — it is flagged here only because a reader expecting "the id
Gameball assigned" would be wrong, and the spec's edge case E11 asked this to be stated explicitly.

**F6 · Reverse-coverage, medium risk.** `order.getOriginalOrderNo()` is read only to decide whether to
**skip** tracking a replacement order (`orderSyncGate.js:33-43,79-82`); the *original* order's points are
never adjusted, corrected, or cross-referenced anywhere once the replacement is skipped. Replacement-order
reversal is a binding Skip (`INTEGRATION_GAPS.md:50`), so this is expected — but a merchant reading only
this document, not `INTEGRATION_GAPS.md`, could reasonably expect *some* handling. Recorded here per §8's
own guard ("a value read only to be discarded is either an accepted loss or silent data loss — say the
second louder").

**F7 · Metadata cross-reference, resolved (not a live finding, recorded to close the loop).** The spec's
own §3 flagged, as a standing risk, that the `Gameball_Enabled` phantom-preference read might still exist
at merge time if the widget item had not landed. It has landed: verified zero hits for
`Gameball_Enabled` anywhere in the merged tree, and both `Gameball.js:32` and `customerSyncGate.js:125`
read `gameballEnabled` (the one preference the metadata actually declares) and nothing else. H43 is
satisfied for this specific pair. No H43 violation was found anywhere else in the merged tree either:
every `getCustomPreferenceValue`/`profile.custom.`/`order.custom.` read in `cartridges/` was checked
against §0.5's registry during this document's construction, and every one resolves to a declared
attribute.

---

## 11. Keeping this document honest

### 11.1 Review trigger (a human gate — CI is out of scope by decision)

A PR that touches any file below **must** update this document in the same PR, or state
"no payload change" in its description. A reviewer who sees neither has a finding.

| File | Why |
|---|---|
| `cartridges/int_gameball_core/cartridge/models/payload/*.js` (`customerPayload.js`, `orderPayload.js`, `lineItem.js`, `refundPayload.js`, `widgetPayload.js`) | the payload bodies themselves |
| `cartridges/int_gameball_core/cartridge/models/identity/gameballIdentity.js` | the identity ladder that produces `customerId`/`guest` on §2/§3/§5 |
| `cartridges/int_gameball_core/cartridge/scripts/api/*.js` (`gameballCustomerApi.js`, `gameballOrderApi.js`, `gameballRefundApi.js`, `gameballPrivacyApi.js`) | endpoint paths, methods, response handling, what gets persisted |
| `cartridges/int_gameball_core/cartridge/scripts/refund/*.js` (`refundGate.js`, `refundStateStore.js`, `refundDelivery.js`) | which refunds are ever sent, id minting, response settlement |
| `cartridges/int_gameball_core/cartridge/scripts/order/orderSyncGate.js`, `cartridge/scripts/customer/customerSyncGate.js` | which orders/customers reach a payload at all |
| `cartridges/int_gameball_core/cartridge/scripts/services/gameballService.js`, `gameballCredentials.js` | headers, base URL, environment |
| `cartridges/int_gameball_core/cartridge/scripts/util/gameballMoney.js`, `gameballErrors.js`, `gameballJson.js` | every money transformation; the error/disposition table; the widget's script-context JSON escaping |
| `cartridges/int_gameball_sfra/cartridge/controllers/Gameball.js`, `templates/default/gameball/widget.isml`, `static/default/js/gameballWidget.js` | the widget write path end to end |
| `metadata/site_template/meta/system-objecttype-extensions.xml`, `custom-objecttype-definitions.xml` | every `COND` row's gate; every response-persistence target |
| `GAMEBALL_SFCC_CARTRIDGE_PLAN.md` §13 | the contract itself |

### 11.2 Known duplicate mapping tables

None found as of `d88afeb`. `docs/refunds-integration-guide.md` and `docs/gameball-gdpr.md` are
merchant-facing prose guides (coverage percentages, deletion-path tables) that overlap this document's
subject matter in spirit but carry no field-by-field mapping table of their own — they describe
*behaviour*, this document maps *fields*. No action recommended; if either grows a literal payload-field
table on a future touch, it should be reduced to a link here rather than duplicated.

### 11.3 Pre-commit checklist

- [x] Front-matter SHA equals `git rev-parse --short HEAD` after the final rebase (`d88afeb`)
- [x] Every citation re-grepped against the merged tree during construction of this document
- [x] Every §13 field has exactly one row (or one named mention inside a grouped row); §10.1 deltas are
      zero once grouped rows are expanded
- [x] Every `GAP` row (F3, F4) has a §10.3 finding
- [x] Every `M‹n›` and `E‹n›` is referenced at least once (M1–M15 all appear in §7 and are cross-referenced
      from §2/§3/§4/§5/§8; E1–E7 all appear in §9)
- [x] No real customer data, no key values, no Secret Key — even as a placeholder in §5/§9
- [x] No example JS snippet appears in this document — all worked examples (§9) are pure JSON request/
      response bodies, so the ES5 house-style check (P9/P10) has nothing to apply to

### 11.4 Change log

| Date | Commit | Change |
|---|---|---|
| 2026-08-26 | `d88afeb` | Initial publication against the seven merged Keep items (widget-xss, duplicate-hooks, ocapi-customers, gdpr-erasure, guest-orders, failed-order-retry, refunds). |
