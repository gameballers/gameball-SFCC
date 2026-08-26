# Gameball and the right to be forgotten

This document is for the merchant operating the Gameball cartridge. It describes what the cartridge
does when a customer is deleted from SFCC, **which deletion paths it cannot see**, and the three gaps
the SFCC and Gameball platforms leave open that no amount of cartridge code can close.

Read sections 1, 3, 4 and 5 before you enable the feature.

---

## 1. What Gameball's delete does

The cartridge calls `POST {base}/integrations/customers/{customerId}/delete`, the documented alias of
`DELETE {base}/integrations/customers/{customerId}`.

- It is a **hard delete**. Gameball removes the customer profile and the associated data.
- There is **no anonymize endpoint** and **no soft delete**. There is nothing to call that keeps a
  pseudonymised shell of the record.
- There is **no undo**. Nothing in Gameball or in this cartridge can restore a deleted loyalty
  profile, its points balance or its history.

`gameballErasureEnabled` ships **off** for that reason. Nothing is deleted until you turn it on.

---

## 2. Which SFCC deletions are captured, and which are not

| Deletion path | Captured? | What happens |
|---|---|---|
| OCAPI / SCAPI **Data API** customer delete | **Yes**, automatically | The `beforeDELETE` hook records the Gameball customer id before the profile is destroyed. |
| Business Manager customer deletion | **No** | SFCC exposes no hook. Nothing is recorded and the cartridge cannot detect it afterwards. |
| `CustomerMgr.removeCustomer` from any script or job | **No** | SFCC exposes no hook. Call `gameballPrivacyApi.requestErasure(profile, 'HELPER_API')` yourself, immediately before you delete. |
| The platform data-retention / anonymization job | **No** | SFCC exposes no hook. See gap 1. |
| A shopper deleting their own storefront account | n/a | SFRA has no such route out of the box. If you have built one, treat it as the script case above. |

**The one automatic path has a switch in front of it that is off by default.**
OCAPI/SCAPI hooks only execute when *Administration → Global Preferences → Feature Switches → API
hook execution* is turned on. It is **off on a new instance**, it cannot be read from script, and
with it off the erasure capture silently does nothing. Turn it on and verify it before you rely on
this feature; see the go-live checklist in section 8.

---

## 3. Gap 1 — the platform data-retention and anonymization job is hookless

> SFCC provides no hook on the platform data-retention and anonymization job, and none on Business
> Manager customer deletion. If you rely on either to remove customers, **Gameball will not be told,
> and this cartridge cannot detect it.** Customers removed that way remain in Gameball indefinitely.
> Route erasures through the OCAPI/SCAPI Data API, or call
> `gameballPrivacyApi.requestErasure(profile, 'HELPER_API')` from your own code immediately before
> you delete the profile. If the profile is already gone, read the customer id from the Gameball
> dashboard and call `gameballPrivacyApi.requestErasureById(id, 'BM_MANUAL')`.

## 4. Gap 2 — delete-then-re-register under Gameball channel merging

> Gameball merges customer profiles on email (or mobile). Where an erasure was never captured, the
> old Gameball profile survives under the old id with the old email address. If anyone later
> registers on that same email — including the erased person themselves, or an unrelated person who
> inherits a recycled corporate mailbox — **Gameball may merge the new registration into the erased
> person's profile, and their points and purchase history reappear attached to a different natural
> person.** This cartridge cannot prevent it: preventing it would require retaining the erased email
> address, which is precisely what the erasure request was meant to remove. Your mitigations are to
> capture erasures reliably (section 2), and/or to review your Gameball channel-merging
> configuration with Gameball support.

## 5. Gap 3 — an erasure is durable only if the SFCC customer is deleted too

> **If the SFCC customer record survives the erasure, the Gameball profile comes back.** Not as a
> defect — as the normal operation of every sync path this cartridge and the Gameball SDK provide.
> An erasure request removes the shopper from Gameball; it does not mark them as someone who must
> never be sent again, because SFCC has no such flag and this cartridge deliberately does not invent
> one (see section 10). Treat `requestErasure` as safe **only** when you delete the SFCC customer in
> the same operation.

Three paths recreate the profile, and they differ in how quickly:

| Path | When it fires | Suppressed while a request is on record? |
|---|---|---|
| **The Gameball widget** (`GbSdk.init`) | The shopper's very next page view while logged in | **No.** It runs in the shopper's browser with the public API key, entirely outside the cartridge's sync gate. |
| Storefront registration / save-profile, and the `Gameball Customer Delta` job | Within one job interval of the profile being touched | Yes, while the `GameballErasureRequest` row exists — see below. |
| A tracked order for that customer | At order placement | Yes, same rule. |

Gameball's own documentation is explicit that initialising the widget with customer data **creates or
updates the customer profile**. It is a write path, it uses the same `customerNo` the erasure job just
deleted, and nothing server-side sees it.

**What the cartridge does do.** While a `GameballErasureRequest` row exists for a shopper, every
server-side sync path refuses to send them — including a `SUCCESS` row, deliberately, because
otherwise the delta sweep would recreate the profile within an hour of the deletion and report
nothing. That block lasts as long as the row: `gameballErasureSuccessRetentionDays` (default 7) after
a confirmed deletion, or up to 14 days for a `FAILED` one. After that the shopper is an ordinary
customer again.

**What you must do.** For a shopper who is leaving: delete the SFCC customer, and let the Data-API
hook or `requestErasure` capture it. For a DSAR that erases loyalty data while keeping the storefront
account: expect the widget to recreate the Gameball profile on the shopper's next page view, and
suppress the widget for that shopper (or the whole storefront) if that is not acceptable. There is no
per-shopper widget suppression in this cartridge today; it belongs in the widget controller and is
tracked as a separate change.

## 6. Consent is not erasure

> `PUT /customers/{id}/activate {"isActive": false}` deactivates a Gameball customer and stops
> further updates. **It does not delete anything and it does not satisfy an erasure request.** This
> cartridge does not implement opt-out; do not treat any opt-out mechanism as a substitute for the
> erasure flow described here.

---

## 7. The erasure store itself contains personal data

Captured requests are held in the `GameballErasureRequest` Custom Object.

- Its key is the shopper's **Gameball customer id** — a pseudonymous identifier, and precisely the
  thing an erasure request exists to remove.
- It holds **no name, email, mobile or address**, and its `Status Details` field is restricted to
  four named diagnostic values (disposition, HTTP status, Gameball error code, Gameball requestId).
  The raw response body is never stored, because a response body can echo submitted data back.
- Completed requests are deleted by the job itself after `gameballErasureSuccessRetentionDays`
  (default 7). The type's own `retention-days` of 14 is a backstop, not the policy.
- It is **single-purpose**. It carries no payload column, no event kind, no priority and no backoff
  schedule — the job's 30-minute interval *is* the backoff. Nothing but erasure requests may ever be
  written to it. It is not, and must not become, a general outbound queue.
- Like every Custom Object it **appears in site data exports and is copied by a sandbox refresh**.

That last point is why `gameballAllowNonProductionSync` exists and why it defaults to off. A sandbox
refreshed from production carries production erasure requests; without the guard, a refreshed
sandbox pointed at your live Gameball workspace would **hard-delete real production customers within
one job interval, unattended**. Only enable `gameballAllowNonProductionSync` on an instance pointed
at a Gameball **test** workspace.

---

## 8. Operating the feature

**Install and enable**

1. Import the Gameball metadata (`system-objecttype-extensions.xml` and
   `custom-objecttype-definitions.xml`). Without `GameballErasureRequest` nothing can be captured;
   the cartridge logs `import the Gameball metadata (GameballErasureRequest)` and keeps deletions
   working.
2. Turn on *Administration → Global Preferences → Feature Switches → **API hook execution***.
   Without it the Data-API capture never fires and produces no symptom.
3. Import `jobs.xml`, or create the job by hand. Change the placeholder `<context site-id="RefArch"/>`
   to a real site id.
4. **Schedule `Gameball Customer Erasure` on exactly one site.** The Custom Object is
   organization-scoped, so a second site's instance would only make redundant calls.
5. Set `gameballErasureEnabled` to Yes. Requests captured before this moment drain on the next run,
   provided they are still inside the 14-day retention window.
6. Enable the job trigger. It ships disabled, on a 30-minute interval.
7. **Verify one real deletion in the Gameball dashboard before you trust a green run.** The delete
   endpoint is an alias, and whether it is routed on your Gameball account has to be observed, not
   assumed. Erase one throwaway customer, watch the run report `success=1`, and confirm in the
   Gameball dashboard that the customer is actually gone.

**Watch**

- The job goes **red** in *Administration → Operations → Jobs → job history* in four situations, and
  it names which one in the step's status message. Configure notification under the job's
  *Notification* tab.
  1. **Any `FAILED` request is standing in the store** — not merely one that failed during that run.
     The job stays red on every run until none are left, because a lost erasure mandate needs a
     human and a status that is red for one run out of six hundred is a status nobody sees.
  2. **The run stopped on a credential or account-configuration fault.** Nothing was settled and no
     retry was burned; fix the `gameball.http.api.cred` Service Credential and the backlog drains
     unharmed.
  3. **Every call in the run came back HTTP 404 with no Gameball error envelope.** That is the
     signature of a delete endpoint that is not routed on your account — *not* of customers who are
     already gone. Do not read those requests as erased. See the message for the documented fallback.
  4. **SFCC refused every call before it reached Gameball** (the service is disabled in Business
     Manager, or its circuit breaker is open). No attempt was counted, so nothing was lost — but the
     requests are not moving.
- The Gameball log (category `gameball.job` for the run summary, `gameball.queue` for individual
  requests) carries one summary line per run:
  `erasureDrain~execute finished: scanned=… success=… retry=… failed=… abandoned=… unavailable=… purged=… outstanding=… calls=… ms=… end=…`.
  `outstanding` is the number of `FAILED` requests standing in the store, capped at 200.

**Clearing a `FAILED` request**

There are exactly two ways, and the job stays red until you use one of them:

- **Re-issue it.** `gameballPrivacyApi.requestErasureById(id, 'BM_MANUAL')` resets a `FAILED` request
  to `PENDING` with a fresh attempt budget, leaving `Requested At` — the response clock — untouched.
- **Delete the row** in *Administration → Site Development → Custom Object Editor →
  GameballErasureRequest*, once you have confirmed in the Gameball dashboard that the customer is
  actually gone.

**The 14-day deadline on a FAILED request**

> A `FAILED` request is removed by platform retention **14 days after it was first captured**. You
> must resolve it inside that window. If you do not, the row disappears, the erasure mandate is
> silently lost, and it can only be re-issued by reading the customer id from the Gameball dashboard
> and calling `gameballPrivacyApi.requestErasureById(id, 'BM_MANUAL')`.

**The seven-day backstop on a stuck request.** An attempt SFCC itself refuses — an open circuit
breaker, the service rate limiter, or the service switched off in Business Manager — deliberately
does not count against the retry budget, so such a request could otherwise sit `PENDING` until
retention destroyed it. Any request still `PENDING` more than **7 days** after it was captured, which
the job has tried at least once, is marked `FAILED` instead. That halves the retention window into
seven days of red job before the row disappears. A backlog that has simply been waiting for
`gameballErasureEnabled` to be switched on is never touched by this rule.

**Known limitation — guest shoppers.** Guest order tracking may create Gameball profiles under a
synthetic identifier with no SFCC `Customer` record at all. No deletion hook can ever fire for them
and no SFCC object holds their id. Erasure for a guest is `requestErasureById` only, driven by
whatever identifier that feature persists.

**Known limitation — SFCC-side residue.** SFCC orders survive customer deletion by platform design,
and an order's `gbCustomerId` attribute survives with them. Scrubbing order attributes is an
SFCC-side data-retention decision for you to make; it is not a Gameball integration concern and this
cartridge does not do it.

---

## 9. Integration points for your own code

All three functions live in
`int_gameball_core/cartridge/scripts/api/gameballPrivacyApi.js`. **None of them ever throws**, none
of them makes an HTTP call, and all of them are idempotent — calling one repeatedly for the same
shopper updates one row and never queues a second deletion.

```js
var gameballPrivacyApi = require('*/cartridge/scripts/api/gameballPrivacyApi');

// Before you delete an SFCC profile from your own code.
// MUST be called while the profile still exists: after deletion the Gameball
// customer id is unrecoverable and Gameball's delete takes no other identifier.
// Accepts a dw.customer.Profile or the dw.customer.Customer that owns it.
gameballPrivacyApi.requestErasure(profile, 'HELPER_API');   // -> boolean

// When the SFCC profile is already gone. Read the id off the Gameball dashboard.
gameballPrivacyApi.requestErasureById(customerId, 'BM_MANUAL');   // -> boolean

// To report progress back to the data subject.
var state = gameballPrivacyApi.getErasureStatus(customerId);
// -> null, or { status, source, requestedAt, completedAt, attempts }
```

**`requestErasure` is only durable when you delete the SFCC customer too.** If the SFCC record
survives, the Gameball profile is recreated — by the widget on the shopper's next page view, and by
the delta sweep once the request row ages out. Read section 5 before you wire this into a DSAR flow
that keeps the account.

`getErasureStatus` returns `null` both when no erasure was ever requested and when a completed one
has already been purged. Those two are deliberately not distinguished: keeping a record of who was
erased, after they were erased, is the thing bounded retention exists to prevent. A `SUCCESS` answer
means Gameball accepted the delete or told us it had never heard of the customer; on a Gameball
account where the delete endpoint alias is not routed, see the third red-job case in section 8.

**Quota ceiling on looping.** A single storefront request may create at most **10 Custom Objects**.
If you need to erase more shoppers than that, do it from a job, or cap the loop at 10 per request.

**Never call `deleteCustomer` yourself.** It is exported for the job step only. Calling it from a
storefront path holds a request open across a Gameball round trip and bypasses the retry accounting
entirely.

---

## 10. What this cartridge deliberately does not build

- **No Business Manager "Forget Customer" form.** `requestErasureById` is the substitute; it accepts
  a raw Gameball id pasted from the Gameball dashboard.
- **No opt-out / consent surface.** See section 6. This is also why the block described in section 5
  is time-bounded rather than permanent: a permanent one would be a consent flag on the profile,
  which is a feature in its own right and is out of scope here.
- **No per-shopper suppression of the Gameball widget.** See section 5. It belongs in the widget
  controller, not in the erasure feature.
- **No automatic retry of a `FAILED` request.** An exhausted erasure needs a human; re-queuing it
  forever would hide that. Re-issue it explicitly.
- **No detection of anonymized profiles.** Detecting them depends on the exact shape SFCC leaves an
  anonymized profile in, which is version-dependent and unverified. Gap 1 is documented, not guessed
  at.
- **No blocking of a re-registration whose predecessor has an unresolved erasure.** It would require
  retaining the erased shopper's email so a later registration could be matched against it, which is
  the same retention gap 2 explains cannot be closed without recreating the harm.
