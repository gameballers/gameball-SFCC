# Gameball Integration for Salesforce Commerce Cloud

## Installation & Configuration Guide

This guide provides a comprehensive, step-by-step walkthrough for developers and system administrators to install, configure, and activate the Gameball loyalty integration on a Salesforce B2C Commerce (SFCC) storefront.

### Prerequisites

* Your storefront must be running on **SFRA (Storefront Reference Architecture)**.
* You must have an active Gameball Workspace with your **API Key** and **Transaction Key**.

---

## 1. Merging the Codebase

1. Download or clone the Gameball cartridge package.
2. Copy the following two folders into your SFCC project workspace:
   * `int_gameball_core` (Contains all the backend integration logic)
   * `int_gameball_sfra` (Contains the frontend widget and checkout integration for SFRA)
3. Upload the newly added cartridges to your active Sandbox or Development instance using your preferred deployment tool (e.g., `sgmf-scripts`, `dwupload`, or VS Code Prophet Uploader).

---

## 2. Updating the Cartridge Path

Salesforce Commerce Cloud uses a cartridge path to determine file priority. You must register the Gameball cartridges on your site so SFCC knows to execute them.

1. Log in to **Business Manager**.
2. Navigate to **Administration > Sites > Manage Sites > [Your Site] > Settings**.
3. In the **Cartridges** field, prepend the Gameball cartridges to the very beginning of the path (before `app_storefront_base`).
   * **Format:** `int_gameball_sfra:int_gameball_core:app_storefront_base`
4. Click **Apply**.

![Cartridge Path Configuration](images/1-cartridge-path.png)

---

## 3. Importing the Metadata

The integration relies on Custom Preferences, Custom Objects, Jobs, and Services. You must import these definitions into your database.

> **Set your Site ID before importing!** The `jobs.xml` file uses `RefArch` as a placeholder site ID. Before zipping the metadata, run this command in your terminal to replace it with your actual Site ID:
> ```bash
> npm run set-site YourSiteID
> ```

1. Locate the `metadata/site_template` folder provided in the Gameball package.
2. Compress the `site_template` folder into a `.zip` file (e.g., `site_template.zip`).
3. In Business Manager, navigate to **Administration > Site Development > Site Import & Export**.
4. Under **Import**, upload your `site_template.zip` file.
5. Select the uploaded file and click **Import** to provision the database attributes.

![Metadata Import](images/2-metadata-import.png)

---

## 4. Configuring the API Credentials

You must securely add your Gameball API Key and Transaction Key to the Salesforce Services framework.

1. In Business Manager, navigate to **Administration > Operations > Services**.
2. Click on the **Credentials** tab.
3. Locate and click on the profile named **`gameball.http.api.cred`** (created by the metadata import).
4. In the **User** field, paste your **Gameball API Key**.
5. In the **Password** field, paste your **Gameball Transaction Key** (Secret Key).
6. Ensure the **Enabled** checkbox is checked.
7. Click **Apply**.

![API Credentials Configuration](images/3-api-credentials.png)

---

## 5. Activating the Integration

You must turn on the integration for your specific storefront and configure your baseline settings.

1. Navigate to **Merchant Tools > Site Preferences > Site Custom Preferences**.
2. You will find two configuration groups for Gameball: **GameballConfigs** and **GameballRefundConfigs**.
3. Configure your preferences for both groups based on the tables below.
4. Click **Apply**.

![Custom Preferences Groups](images/4-custom-preferences.png)

### GameballConfigs Table

| Preference Name                                                                            | Description                                                                                | Default           |
| :----------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------- | :---------------- |
| **Enable Gameball** (`gameballEnabled`)                                            | Master switch to turn the Gameball Integration on or off.                                  | No                |
| **Exclude Gift Certificate Tender** (`gameballExcludeGiftCertificateTender`)       | Subtracts Gift Certificate spend from the order total sent to Gameball.                    | Yes               |
| **Gameball Info Logging** (`gameballInfoLogEnabled`)                               | Writes one INFO line to the custom Gameball log for every customer upsert.                 | Yes               |
| **Gameball Debug Logging** (`gameballDebugLogEnabled`)                             | Writes DEBUG lines for troubleshooting.                                                    | No                |
| **Sync OCAPI/SCAPI Shop API Customers** (`gameballSyncOcapiShopCustomers`)         | Syncs customers registered/edited through Headless immediately.                            | Yes               |
| **Sync OCAPI/SCAPI Data API Customers** (`gameballSyncDataApiCustomers`)           | Syncs customers updated via Data API instantly (rather than waiting for Delta job).        | No                |
| **Require an Email Before Syncing** (`gameballCustomerRequireEmail`)               | Skips syncing customers missing an email address.                                          | No                |
| **Customer Delta Job Strategy** (`gameballCustomerDeltaStrategy`)                  | How the Delta job finds changes (`LAST_MODIFIED` or `PAGED_CUSTOMER_NO`).              | `LAST_MODIFIED` |
| **Customer Delta Lookback (Hours)** (`gameballCustomerDeltaLookbackHours`)         | How far back the Delta job looks for modified profiles on each run.                        | 48                |
| **Customer Delta Max Calls Per Run** (`gameballCustomerDeltaMaxCallsPerRun`)       | Upper bound on API calls sent per Delta job run.                                           | 500               |
| **Customer Delta Max Profiles Per Run** (`gameballCustomerDeltaMaxProfilesPerRun`) | Maximum profiles the Delta Job will evaluate in a single execution.                        | 25000             |
| **Allow Gameball Jobs on Non-Production** (`gameballAllowNonProductionSync`)       | Prevents Sandboxes from polluting a live Gameball workspace.                               | No                |
| **Gameball Max Requests Per Second** (`gameballMaxRequestsPerSecond`)              | Throttle ceiling to prevent Salesforce from exceeding Gameball's API rate limits.          | 10                |
| **Enable Gameball Customer Erasure** (`gameballErasureEnabled`)                    | Master switch for GDPR right-to-be-forgotten customer deletions.                           | No                |
| **Gameball Erasure Max Attempts** (`gameballErasureMaxAttempts`)                   | Retry limit for the erasure job before marking a failure.                                  | 5                 |
| **Gameball Erasure Success Retention** (`gameballErasureSuccessRetentionDays`)     | How many days the pseudonymous log of a successful deletion is kept.                       | 7                 |
| **Enable Guest Order Tracking** (`gameballTrackGuestOrders`)                       | Master switch for tracking orders placed by guest shoppers.                                | No                |
| **Guest Order Identity Mode** (`gameballGuestOrderMode`)                           | Determines how a Gameball profile is created for a guest (`PER_ORDER` or `PER_EMAIL`). | `PER_ORDER`     |
| **Resolve Guest to Registered Login** (`gameballResolveGuestLogin`)                | Checks if a guest's email matches an existing registered SFCC account.                     | Yes               |
| **Enable Gameball Order Retry** (`gameballRetryEnabled`)                           | Master switch for the Order Retry job (catches failed syncs).                              | Yes               |
| **Gameball Retry Lookback (Days)** (`gameballRetryLookbackDays`)                   | How far back the Retry job scans for failed orders.                                        | 7                 |
| **Gameball Retry Max Attempts** (`gameballRetryMaxAttempts`)                       | How many attempts one failed order gets before it is abandoned permanently.                | 5                 |
| **Gameball Retry Max Orders Per Run** (`gameballRetryMaxOrdersPerRun`)             | Max failed orders the Retry job will scan in a single run.                                 | 200               |
| **Gameball Retry Backoff (Minutes)** (`gameballRetryBackoffMinutes`)               | How long to wait before retrying an order again.                                           | 30                |
| **Gameball Retry Probe Before Resend** (`gameballRetryProbeBeforeResend`)          | Probes Gameball to see if the order was actually received before retrying.                 | Yes               |

### GameballRefundConfigs Table

| Preference Name                                                                      | Description                                                                     | Default |
| :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ | :------ |
| **Enable Gameball Refunds** (`gameballEnableRefunds`)                        | Master switch for the Gameball refund feature.                                  | No      |
| **Detect Cancellations Automatically** (`gameballRefundDetectCancellations`) | Scans for orders that change to `CANCELLED` status and reverses their points. | Yes     |
| **Gameball Refund Lookback (Days)** (`gameballRefundLookbackDays`)           | How far back the Refund Detector job scans for cancelled orders.                | 90      |
| **Gameball Refund Orphan Max (Hours)** (`gameballRefundOrphanMaxHours`)      | How long a manual API refund waits for a missing order before timing out.       | 24      |
| **Gameball Refund Max Attempts** (`gameballRefundMaxAttempts`)               | How many attempts one refund gets before it stops being retried.                | 6       |

### GameballRedemptionConfigs Table

| Preference Name                                                                      | Description                                                                     | Default |
| :----------------------------------------------------------------------------------- | :------------------------------------------------------------------------------ | :------ |
| **Enable Pay with Points** (`gameballEnableRedemption`)                              | Master switch for "Pay with Points" (direct cart/checkout discount).            | No      |
| **Redemption Max Percent of Basket** (`gameballRedemptionMaxPercentOfBasket`)        | Caps how much of the basket's eligible total a points hold may cover (%).       | 100     |
| **Redemption Min Order Amount** (`gameballRedemptionMinOrderAmount`)                 | Minimum amount that must remain payable after a redemption is applied.          | 0       |
| **Redemption Assumed Hold TTL** (`gameballRedemptionAssumedHoldTtlMinutes`)          | Cosmetic countdown for the UI; must manually match your Gameball hold timeout.  | 30      |

---

## 6. Configuring Background Jobs

Gameball relies on automated jobs to catch offline customer modifications, sync missed orders, process refunds, and permanently erase customers to comply with GDPR.

1. Navigate to **Administration > Operations > Jobs**.
2. **Gameball Customer Delta:** Click on the job and schedule it to run periodically (e.g., every 15 minutes). This catches any customers created or edited via XML import or Business Manager.
3. **Gameball Order Track:** Schedule to run every 15-30 minutes. This acts as a safety net for orders that failed to sync during checkout, and syncs orders created externally (like Point of Sale or manual Business Manager orders).
4. **Gameball Refund Detector:** Schedule to run hourly. This job scans for orders that have moved to a `CANCELLED` or `FAILED` status and automatically reverses their points in Gameball.
5. **Gameball Customer Erasure:** Schedule to run daily. This permanently deletes Gameball profiles for any shoppers whose Salesforce account was erased via the Data API or manual privacy requests.

![Background Jobs Configuration](images/5-background-jobs.png)

---

## 7. Frontend Widget Integration

If you are using SFRA, you need to include the Gameball widget in your storefront templates.

1. Open your global footer template, usually located at:
   `app_storefront_base/cartridge/templates/default/components/footer/pageFooter.isml`
2. Add the following line just before the closing `</footer>` or `</body>` tag:
   ```html
   <isinclude url="${URLUtils.url('Gameball-Widget')}"/>
   ```
3. This will securely and dynamically inject the Gameball Floating Widget onto all pages for both guests and logged-in customers using a Remote Include (which ensures it bypasses static page caching).

---

## 8. Specific Feature Configuration

### Guest Checkouts

If you want shoppers who check out as guests to earn points, you must explicitly enable it:

1. Go to **Site Custom Preferences > GameballConfigs**.
2. Set **Enable Guest Order Tracking** (`gameballTrackGuestOrders`) to `Yes`.
3. Choose your **Guest Order Identity Mode**:
   * `PER_ORDER`: Creates a new Gameball profile for every single guest order.
   * `PER_EMAIL`: Hashes the guest's email. Repeat guests accumulate points on one profile.

![Guest Checkout Tracking Setup](images/6-guest-checkouts.png)



### Refunds & Cancellations

To automatically reverse points when an order is cancelled:

1. Go to **Custom Preferences > GameballRefundConfigs**.
2. Set **Enable Gameball Refunds** (`gameballEnableRefunds`) to `Yes`.
3. Set **Detect Cancellations Automatically** (`gameballRefundDetectCancellations`) to `Yes`.
4. Ensure the **Gameball Refund Detector** job is scheduled.

![Refunds and Cancellations Setup](images/7-refunds-cancellations.png)

### Points Redemption (Pay with Points)

This feature allows logged-in shoppers to dynamically slide and apply their Gameball points as a direct price adjustment on the cart and checkout pages.

1. Go to **Custom Preferences > GameballRedemptionConfigs**.
2. Set **Enable Pay with Points** (`gameballEnableRedemption`) to `Yes`.
3. Optionally configure **Redemption Max Percent of Basket** or **Redemption Min Order Amount** to enforce order value limits.

---

## 9. Verification

To verify the installation was successful:

1. **Frontend Widget:** Navigate to your storefront homepage. The Gameball Widget should now be visible in the bottom corner of the screen.

   ![Widget visible on storefront](images/8-frontend-widget-verification.png)
2. **Order Tracking:** Place a test order on the storefront. Navigate to **Merchant Tools > Ordering > Orders**, click your new order, and scroll down to the Custom Attributes tab. The **Gameball Track State** should successfully say `TRACKED`.
3. **Customer Deletion (GDPR):** In **Merchant Tools > Custom Objects > Custom Object Editor**, create a new `GameballErasureRequest` row with a customer ID and set the status to `PENDING`. Run the Customer Erasure Job, and verify the status changes to `SUCCESS`.
