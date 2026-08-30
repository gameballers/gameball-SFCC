# Gameball Refunds - How Your Returns Reach Gameball

This cartridge never reverses Gameball points automatically for most refunds. This document exists
so that statement is never a surprise. Read it before enabling `gameballEnableRefunds`.

## 1. The honest coverage number

> With every fix applied, the automatic path catches **roughly 10-20% of refund events by count and
> less by value** - full pre-shipment cancellations that flip `order.status` - and **0% of
> post-shipment returns, partial refunds, appeasements, shipping/tax-only refunds and chargebacks,
> and ~0% at any OMS-backed or Adyen-Customer-Area merchant.** Everything beyond that number is
> merchant code calling `submitRefund()`.

This is not a limitation of this implementation - it is a structural fact about Salesforce B2C
Commerce. Order post-processing (`Return`/`ReturnCase`/`Invoice`) is at **End of Adoption** and is not
enabled for new instances, so there is no SFCC-native representation of "this shopper returned three
of the five items they bought" for this cartridge, or any cartridge, to observe. What SFCC *does*
always have is `order.status`, and that is exactly what the automatic path watches.

Think of this feature as **"automatic cancellation reversal, plus a documented refund API for your
OMS"** - not as "refund sync". "Refund sync" implies a completeness this feature does not have, so
plan your returns process around the API rather than the automatic path.

## 2. What the automatic path does

The **Gameball Refund Detector** job (`custom.Gameball.RefundDetect`, disabled by default, one instance
per site) runs hourly and does two things:

1. **Detects cancellations.** Any order that was successfully tracked to Gameball (`gbTrackState =
   TRACKED`) and has since moved to `CANCELLED` or `FAILED` status gets a **full** points reversal -
   every product line item replayed at full quantity, so campaign and collection-based points are
   reversed correctly, not just base cashback. This is a **full lookback scan** anchored on
   `gbTrackedAt` (default 90 days, `gameballRefundLookbackDays`), re-run every hour - not a moving
   window. An order tracked in January and cancelled in March is still found in April, because the
   scan always reaches back to January.
2. **Retries pending work.** Any refund recorded (by the detector itself, or by `submitRefund()`) that
   was not yet delivered - because Gameball was down, the order was not yet tracked, or a previous run
   hit its per-run call cap - is retried.

Turn `gameballRefundDetectCancellations` off if an external system already reports cancellations to
Gameball via `submitRefund()`, to avoid a harmless-but-wasted duplicate call.

## 3. What the automatic path cannot see, and what to do about each

| Refund shape | Automatic detection? | What to do |
|---|---|---|
| Order cancelled before shipment (status flips to CANCELLED) | Yes | Nothing - the job handles it. |
| Post-shipment return / RMA processed in an OMS | No | Call `submitRefund({ orderNo, full: true })` (or `refundAmount` for a partial) from your OMS return-completion webhook or batch job. |
| Partial refund / partial return | No | Call `submitRefund({ orderNo, refundAmount, lineItems })`. |
| Appeasement / goodwill credit | No | Call `submitRefund({ orderNo, refundAmount, kind: 'ADJUSTMENT' })`. |
| Shipping-only or tax-only refund | No | Call `submitRefund({ orderNo, refundAmount, kind: 'SHIPPING' })` or `kind: 'TAX'`. |
| Chargeback | No - SFCC has no representation of a chargeback at all | Call `submitRefund({ orderNo, full: true, kind: 'CHARGEBACK' })` from your PSP's chargeback webhook. |
| A refund issued entirely in Adyen's Customer Area (no SFCC record) | No | See the worked example below - call `submitRefund()` from your Adyen webhook consumer. |
| `dw.order.payment.refund` (the platform's payment-refund hook) | **Never** - and never will be | See section 8. |

## 4. The `submitRefund()` contract

```js
var gameballRefundApi = require('*/cartridge/scripts/api/gameballRefundApi');

var result = gameballRefundApi.submitRefund({
    orderNo: '00012345',            // required
    kind: 'RETURN',                 // optional, default RETURN. RETURN|CANCELLATION|CHARGEBACK|SHIPPING|TAX|ADJUSTMENT
    full: false,                    // full XOR refundAmount - exactly one must be set
    refundAmount: 25.00,            // order currency, > 0. Overridden by a lineItems-based proration when lineItems is also given.
    lineItems: [                    // optional - which units were returned
        { productLineItemUUID: 'abc-123', quantity: 1 }
    ],
    externalRefundId: 'oms-ref-9981', // optional but STRONGLY recommended - see idempotency below
    occurredAt: new Date(),         // optional, defaults to now
    reason: 'customer return',      // optional, stored for SFCC-side audit, NEVER sent to Gameball
    deferSend: false                // optional - true records only, the hourly job delivers it
});

// result: { accepted: boolean, refundEventId, refundTransactionId, status, reason?, duplicate? }
// status is one of: SENT | DUPLICATE | PENDING | WAITING_FOR_ORDER | MANUAL_REVIEW | FAILED | REJECTED
```

**Guarantees:**

- **Never throws.** Every failure - a bad argument, an order that does not exist, a Gameball outage -
  is a return value, never an exception. Safe to call from inside a webhook handler with no wrapping
  try/catch of your own.
- **Records before it sends.** The refund is durably written to the order (`Order.custom.gbRefund*`)
  in one transaction *before* any network call. If the outbound call fails, nothing is lost - the
  hourly job retries it.
- **Idempotent on `externalRefundId`.** Calling `submitRefund()` twice with the same
  `externalRefundId` returns the existing refund and makes **no second call**. Always pass your OMS's
  or PSP's own refund/return identifier here - it is what makes this safe to wire into a webhook that
  may be delivered more than once.
- **At most one outbound HTTP call per invocation.** A loop calling `submitRefund()` many times inside
  one storefront request **must** pass `deferSend: true` - the storefront quota is 16 HTTPClient sends
  per request. In a job context there is no such limit.

### Status values, explained

| `status` | Meaning |
|---|---|
| `SENT` | Delivered to Gameball just now. |
| `DUPLICATE` | Gameball already had this exact `refundTransactionId` - counted as delivered. |
| `PENDING` | Recorded, not yet delivered (deferred, or a transient failure). The hourly job will retry. |
| `WAITING_FOR_ORDER` | The order has not reached `gbTrackState = TRACKED` yet. Delivered automatically as soon as it does, up to `gameballRefundOrphanMaxHours` (default 24h), after which it is abandoned rather than sent blind. |
| `MANUAL_REVIEW` | A guard refused to guess. **There is no Business Manager screen for this** - see section 7. |
| `FAILED` | Permanently rejected by Gameball, or retries exhausted (`gameballRefundMaxAttempts`). |
| `REJECTED` | The call itself was refused - bad input, unknown order, or a concurrent write. Check `reason`. |

## 5. Worked example: Adyen Customer Area refunds

Adyen refunds issued from the Customer Area (rather than through an SFCC-initiated flow) never touch
SFCC at all - there is no order status change, no hook, nothing to poll. The only way Gameball hears
about it is your own Adyen webhook consumer calling `submitRefund()`:

```js
// In your Adyen REFUND webhook handler (your own code, not part of this cartridge):
var gameballRefundApi = require('*/cartridge/scripts/api/gameballRefundApi');

exports.onAdyenRefundNotification = function (notification) {
    var orderNo = notification.merchantReference; // however you map Adyen's reference back to an SFCC order
    var amount = notification.amount.value / 100; // Adyen amounts are minor units

    var result = gameballRefundApi.submitRefund({
        orderNo: orderNo,
        refundAmount: amount,
        externalRefundId: notification.pspReference, // Adyen's own reference - the idempotency key
        deferSend: true // webhook handlers should not add a synchronous Gameball round trip
    });

    if (!result.accepted) {
        // Log result.reason (INVALID_INPUT, ORDER_NOT_FOUND, etc.) for your own ops visibility.
        // Gameball is never the reason an Adyen webhook fails to acknowledge.
    }
};
```

## 6. Proration and non-linear promotions

When `submitRefund()` is called with `lineItems` for a partial refund, the amount actually sent to
Gameball is **computed from those line items**, not the `refundAmount` you passed - a per-unit
proration using `dw.order.ProductLineItem.getProratedPrice()`, which correctly spreads Buy-X-Get-Y and
order-level percentage discounts across every affected line.

**This proration is only exact for LINEAR adjustments.** Fixed-amount line adjustments, BXGY and
tiered promotions are non-linear - refunding 1 of 3 units does not always return exactly one third of
the adjustment. The design does not attempt to model that; it prorates linearly. For most catalogs
this is close enough to be invisible; for a catalog leaning heavily on tiered/fixed-amount promotions,
expect occasional cent-level drift.

## 7. `MANUAL_REVIEW` has no button

This cartridge ships with **no Business Manager dashboard and no admin UI** (a binding project scope
decision). When a refund lands in `MANUAL_REVIEW`, resolving it means:

1. An operator opens the order in Business Manager and reads `gbRefundLedger` (a JSON array, one
   object per refund attempt) and `gbRefundLastError`.
2. They decide what actually happened - was this a genuine duplicate, a currency mismatch, a
   double-refund risk after a partial?
3. They either call `submitRefund()` from a support script/console, or clear `Order.custom.gbRefundState`
   by hand once they are certain the situation is resolved.

This is a real operational cost, not a corner case to ignore. Every `MANUAL_REVIEW` reason string is
one of: `no_gameball_order_id`, `no_customer_id`, `currency_mismatch`, `awaiting_manual_review`,
`no_tracked_total`, `exceeds_tracked_total`, `hybrid_partial_undefined`, `full_after_partial`,
`LEDGER_UNREADABLE`, `LEDGER_FULL`, or a Gameball response code the refund scope routes to review
(`9000`, `9002`, `9003`, `9007`, `3004`).

## 8. Why there is no `dw.order.payment.refund` hook, ever

`dw.order.payment.refund(invoice) : Status` is a **single-implementation, value-returning service
hook** - not a broadcast notification. The first cartridge registered on the path wins and every other
implementation is never called. Registering it here, on a post-processing-active instance, ahead of
your real payment service provider's cartridge would **shadow the PSP's refund implementation and stop
refunds from being issued at the processor** - the shopper's money would not move. This is a
correctness rule, not a caution: it will not be revisited.

Refund *detection* is the polling job described above. Refund *submission from code you control* is
`submitRefund()`. There is no third path, and there will not be one.

## 9. Negative Gameball balances

A refund can leave a customer with a negative Gameball points balance - Gameball permits this by
design, and this cartridge does not block, clamp or compensate for it. The recommended mitigation is
upstream, in your Gameball dashboard: set `cashbackConfigurations.returnWindow` to your return-policy
length, so earned points stay pending and unspendable until the return window closes and a refund can
no longer claw back points the customer has already spent.

## 10. Install notes

- The **Gameball Refund Detector** job ships with its trigger **disabled** and a placeholder
  `<context site-id="RefArch"/>` - both must be changed before enabling it on a real site.
- Schedule it on **every** site tracking orders (unlike the Customer Erasure job, this one is
  per-site, not organization-scoped).
- A multi-site merchant sharing one Gameball workspace divides `gameballMaxRequestsPerSecond` across
  sites - the limit is account-scoped and shared with order tracking, customer sync and every other
  Gameball job.
- Orders tracked **before** this feature's metadata was imported have no `gbTrackedAt` and are
  invisible to automatic detection forever. `submitRefund()` still works for them for a **full**
  reversal (no ceiling needed); a **partial** is refused (`no_tracked_total` -> `MANUAL_REVIEW`)
  because the cumulative ceiling is unknowable without `gbTrackedTotalPaid`.
