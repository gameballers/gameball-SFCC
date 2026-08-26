# Gameball SFCC Cartridge — Remaining Integration Gaps

Snapshot as of `main` after PR #1–#4 (customer sync, widget injection, order tracking).
Customer sync and order tracking are solid for the single-site, registered-customer,
standard-checkout case. Everything below is what's still missing to call the
integration complete.

**How to use this file:** the `Recommendation` column is my own judgment call, not a
decision — fill in `Decision` yourself (`Keep` / `Defer` / `Skip`) as you plan future
work, and treat this as a living doc (edit it as scope changes).

**Legend:** Must-have = blocks calling this a real production loyalty integration ·
Should-have = real gap, but the integration functions without it · Nice-to-have =
convenience/operability, not functional · Conditional = depends on your rollout plan

---

## Known issues (bugs, not missing scenarios — worth fixing regardless of scope decisions)

| Issue | Where | Impact | Decision |
|---|---|---|---|
| Widget XSS + `gameballEnabled` preference name mismatch | `cartridges/int_gameball_sfra/cartridge/templates/default/gameball/widget.isml` | The widget could not render at all: the enable check read `Gameball_Enabled`, an id that does not exist in `system-objecttype-extensions.xml`. Repairing that check alone would have activated a stored-XSS injection point (`encoding="off"` on customer-controlled name/email), so both halves had to ship together | [ Keep] |
| `Account.js` dispatches customer sync through `HookMgr.callHook('app.customer.registered'/'updated', ...)`, a private extension point in the SFRA-reserved `app.*` namespace | `cartridges/int_gameball_sfra/cartridge/controllers/Account.js` | **Corrected diagnosis — there is no double-post today.** `hooks.json` makes an extension point *resolvable*; `HookMgr.callHook` is what *fires* it, and there is exactly one `callHook` per route. `app.customer.*` is not an SFRA extension point either — it is a name this cartridge invented, so the `server.append` blocks are load-bearing. The real defect is architectural: the moment any other cartridge or a future SFRA release fires that name, `HookMgr` runs our script on top of our own `callHook` and every registration silently double-posts — and `sendCustomer` logged only on failure, so nobody could tell either way | [Keep ] |

---

## Customers

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Referral code capture (`referrerCode`) | Referral-based rewards never trigger | Should-have | [Skip ] |
| GDPR / right-to-be-forgotten sync | Deleted SFCC customers leave orphaned data in Gameball indefinitely | Conditional — Must-have if you operate in the EU/UK or anywhere else GDPR-equivalent rules apply | [Keep ] |
| BM-created / imported / Data-API customers | Only storefront register/save-profile is covered — admin-created or bulk-imported customers never sync | Should-have | [Keep ] |
| Backfill for pre-existing customers | Anyone who registered before the cartridge went live has no Gameball profile until their next save | Conditional — depends on whether you want pre-launch customers included at all | [Skip ] |
| Identity collision safety (multi-site) | Still uses raw `customerNo`; two sites sharing one Gameball workspace would collide on the same IDs | Conditional — Skip if single-site, Must-have before any multi-site rollout | [Skip ] |

## Widget

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Signed session token / identity verification | Raw `customerNo` as `playerUniqueId` with no signature — anyone who can guess another customer's ID can view their balance | Must-have before wide rollout | [skip ] |
| Consent gating before sending PII | Customer name/email are broadcast into every page unconditionally | Should-have | [ skip] |
| Redemption / coupon UI (spend points at checkout) | Customers can earn points but have no way to actually redeem them in the storefront | Must-have — without this there's no real "loyalty program" from the shopper's side | [skip ] |

## Orders

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Guest order tracking | Every guest checkout earns zero points, silently | Conditional — Must-have if guest checkout is common on your storefront | [keep] |
| Replacement-order handling (reverse original, track replacement) | Currently skipped entirely — a legitimate order edit/replacement earns no points | Should-have | [skip ] |
| Reconciliation job (catch orders cancelled/refunded *after* being tracked) | Points awarded on an order later cancelled are never clawed back | Must-have (overlaps with Refunds below — same underlying job) | [skip ] |
| Backfill for historical orders | Orders placed before cartridge install never sync | Conditional — same call as customer backfill | [skip ] |
| Retry for `FAILED` orders | A transient API failure marks the order `FAILED` permanently, no automatic or manual retry | Should-have | [keep ] |
| Redemption on orders (`redemption.pointsHoldReference`/`couponCodes`) | Can't report a checkout-time points redemption even once the widget supports it | Must-have (pairs with widget redemption UI above) | [skip ] |

## Refunds

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Everything — detection, payload, API call, BM tooling (currently only an inert stub file exists) | Points are never reversed on any refund; Gameball balances only ever drift upward | Must-have | [keep ] |

## Redemption / spend flow

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Hold points, release points, apply-as-coupon | No mechanism for a customer to actually spend earned points anywhere in the storefront | Must-have | [skip ] |

## Reliability

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Queue + retry/backoff for every integration point | Every call today is synchronous and fire-once; a slow or down Gameball API is simply lost with no recovery | Should-have — more urgent at higher order volume | [skip ] |

## Business Manager

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Admin dashboard (Test Connection, sync status, manual retry/refund tools) | No merchant-facing visibility beyond raw Service Credential fields and Order custom attributes | Nice-to-have | [skip ] |

## Multi-site / locale

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Per-site/per-locale credential and config overrides | One flat config for the whole instance; no per-site Gameball workspace support | Conditional — Skip unless you actually run multiple sites/locales needing distinct Gameball configs | [skip ] |

## Testing / CI

| Scenario | Impact if left unbuilt | Recommendation | Decision |
|---|---|---|---|
| Unit tests, integration tests, CI gate | Zero automated verification of any of the above | Should-have before scaling the team or maintenance load | [skip ] |

---

## Delivered (Keep items completed)

The `Decision` column above is the binding scope record and is deliberately left untouched — no cell
above this line was edited to produce this section. This is a delivery log: what actually shipped, and
where to read it. Added once every one of the seven `Keep` items above had merged into `main`, by the
one PR that could see all seven at once (the documentation item cannot claim its own row in each of
their PRs, since no earlier PR could see the ones after it).

| Scenario (row above) | PR | Landed in | Mapping rows |
|---|---|---|---|
| Widget XSS + `gameballEnabled` preference name mismatch (Known issues) | #5 | `cartridges/int_gameball_sfra/cartridge/templates/default/gameball/widget.isml`, `controllers/Gameball.js`, `static/default/js/gameballWidget.js` | `PAYLOAD_MAPPING.md` §5 |
| `Account.js` dispatches customer sync through a private extension point (Known issues) | #6 | `cartridges/int_gameball_sfra/cartridge/controllers/Account.js` | n/a (no payload change — dispatch mechanism only) |
| BM-created / imported / Data-API customers (Customers) | #7 | `cartridges/int_gameball_core/cartridge/scripts/hooks/ocapiShopCustomerHooks.js`, `ocapiDataCustomerHooks.js`, `scripts/customer/customerSyncGate.js`, `scripts/job/customer/deltaCustomers.js` | `PAYLOAD_MAPPING.md` §2 |
| GDPR / right-to-be-forgotten sync (Customers) | #8 | `cartridges/int_gameball_core/cartridge/scripts/api/gameballPrivacyApi.js`, `scripts/privacy/erasureStore.js`, `scripts/job/erasureDrain.js`, `scripts/hooks/ocapiDataCustomerHooks.js` (`beforeDELETE`) | `PAYLOAD_MAPPING.md` §6 |
| Guest order tracking (Orders) | #9 | `cartridges/int_gameball_core/cartridge/scripts/order/orderSyncGate.js`, `models/identity/gameballIdentity.js`, `models/payload/orderPayload.js` | `PAYLOAD_MAPPING.md` §3 |
| Retry for `FAILED` orders (Orders) | #10 | `cartridges/int_gameball_core/cartridge/scripts/job/order/retryFailedOrders.js`, `scripts/api/gameballOrderApi.js` | `PAYLOAD_MAPPING.md` §3, §6 |
| Refunds — detection, payload, API call (Refunds) | #11 | `cartridges/int_gameball_core/cartridge/models/payload/refundPayload.js`, `scripts/api/gameballRefundApi.js`, `scripts/refund/refundGate.js`, `refundStateStore.js`, `refundDelivery.js`, `scripts/job/refund/detectRefunds.js` | `PAYLOAD_MAPPING.md` §4 |

Everything else above this section — referral capture, signed session token, consent gating, redemption/
coupon UI, replacement-order handling, reconciliation job, backfill (customer and order), identity
collision safety, redemption on orders, a general outbound queue, a BM admin dashboard, per-site/
per-locale config, and a test/CI harness — remains `Skip` and was not built. `PAYLOAD_MAPPING.md` records
each as a `SKIP-DECISION` row citing the line above, not as an omission with no explanation.
