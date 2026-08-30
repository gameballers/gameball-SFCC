# Gameball for Salesforce B2C Commerce

Loyalty, rewards and points redemption for SFRA storefronts, powered by [Gameball](https://gameball.co).

This repository contains the two cartridges and the site metadata you need to run Gameball on a
Salesforce B2C Commerce (SFCC) instance.

---

## What it does

- **Automatic point earning** — orders are sent to Gameball as they are placed.
- **Customer sync** — SFCC profiles stay in sync with Gameball, including profiles created or edited
  in Business Manager, through imports, and over OCAPI/SCAPI.
- **Pay with Points** — shoppers redeem their balance as a discount directly on the cart and
  checkout pages.
- **Storefront widget** — a loyalty panel shoppers can open from any page to join, sign in and see
  their points.
- **Guest checkout support** — optional point earning for shoppers who do not create an account.
- **Cancellation reversal** — points are clawed back when an order is cancelled, plus a
  `submitRefund()` API your OMS can call for every other refund case.
- **GDPR erasure** — an SFCC customer deletion erases the matching Gameball profile.

## What's in this repository

| Path | Contents |
| :--- | :--- |
| `cartridges/int_gameball_core` | Backend integration logic, Gameball API clients, and the job step definitions. |
| `cartridges/int_gameball_sfra` | SFRA controllers, the storefront widget, and the checkout redemption UI. |
| `metadata/site_template` | Custom preferences, custom objects, jobs and service definitions to import into your instance. |
| `scripts/set-site.js` | Sets your Site ID in `jobs.xml` before you import the metadata. |
| `INSTALLATION.md` | Full step-by-step installation and configuration guide. |

## Requirements

- An SFCC storefront running **SFRA** (Storefront Reference Architecture).
- An active Gameball workspace with an **API Key** and **Transaction Key**.

## Installation

Follow **[INSTALLATION.md](INSTALLATION.md)** for the complete walkthrough. In short:

1. Upload `int_gameball_core` and `int_gameball_sfra` to your instance.
2. Prepend them to your site's cartridge path, ahead of `app_storefront_base`:
   ```
   int_gameball_sfra:int_gameball_core:app_storefront_base
   ```
3. Set your Site ID, then zip and import `metadata/site_template`:
   ```bash
   npm run set-site YourSiteID
   ```
4. Add your API Key and Transaction Key to the `gameball.http.api.cred` service credential.
5. Turn on `gameballEnabled` and configure the site preferences.

The storefront widget needs no template editing — `int_gameball_sfra` overrides `pageFooter.isml`
and injects it, provided the cartridge path in step 2 is correct.

## Background jobs

Four jobs are imported with the metadata:

| Job | Purpose |
| :--- | :--- |
| `Gameball Customer Delta` | Catches profile changes that fire no hook (Business Manager edits, imports) and retries failed customer syncs. |
| `Gameball Order Retry` | Re-sends orders left in a `FAILED` track state by a transient API error. |
| `Gameball Refund Detector` | Reverses points for cancelled orders and retries undelivered refunds. |
| `Gameball Customer Erasure` | Drains right-to-be-forgotten requests to Gameball. |

> **All four triggers ship disabled, and their site ID is a placeholder.** Run `npm run set-site`
> before importing, then review the schedule of each job before enabling it. Schedule
> `Gameball Customer Erasure` on exactly one site — its custom object is organization-scoped.

## Before you enable refunds or erasure

Both features ship **off**, and both have limits worth understanding before you turn them on. Ask
your Gameball contact for the detailed guide on either one.

- **Refunds (`gameballEnableRefunds`)** — automatic detection watches `order.status` and therefore
  covers full pre-shipment cancellations only. Post-shipment returns, partial refunds, appeasements
  and chargebacks have no SFCC-native representation to observe; those reach Gameball through your
  own code calling `submitRefund()`. Plan your returns process around that API, not the automatic
  path.
- **Erasure (`gameballErasureEnabled`)** — Gameball's delete is a **hard delete with no undo**.
  There is no anonymize endpoint and no soft delete, and a deleted profile, its balance and its
  history cannot be restored.

## Support

For installation help, sandbox logs or sync history, contact your Gameball onboarding or support
representative.

## License

Declared as ISC in `package.json`.
