EDDYS KITCHEN — ONLINE DEPLOYMENT PACK
=====================================

This package is prepared for one shared HTTPS website on Render. Customers use the public home page; the administrator uses /admin; staff use /staff; riders use /rider.html. All use the same backend and persistent database.

IMPORTANT: This ZIP is source-only. It intentionally excludes the local SQLite database and local uploads so private customer/order records and images are not accidentally committed to GitHub. A new deployment therefore starts with a new empty database and the first administrator must create the private admin account. If your current computer has customer/order records that must be retained, stop before launch and arrange a secure database migration; do not overwrite your existing local database.

WHAT IS CONFIGURED
- Render Blueprint: render.yaml
- Node.js runtime (Node 20 or later)
- Express serves the customer site, admin, staff, rider and API from one HTTPS origin
- Persistent disk mounted at /var/data
- Database path /var/data/eddys-kitchen.db
- Uploaded images path /var/data/uploads
- Generated SESSION_SECRET
- Health check at /api/health
- SQLite-backed sessions and database

DEPLOY STEPS
1. Extract this ZIP into a new folder.
2. Create a PRIVATE GitHub repository. Do not make it public.
3. Upload the contents of this folder to that private repository. The .gitignore excludes local databases, backups, uploads, node_modules and .env files. Keep .env.example only as a template.
4. Create/sign in to a Render account and choose New > Blueprint. Connect the private GitHub repository and select its render.yaml.
5. Review the service before creating it. Confirm that the persistent disk is mounted at /var/data and that the service plan supports persistent disks.
6. Deploy. Wait for the build and health check to complete. Open the service URL followed by /api/health. The response should contain ok:true and database:"ok".
7. Open /admin and create the first private administrator account immediately. First-admin registration closes after the first account is created. Do not share this login with employees.
8. Sign in as admin. Create staff accounts and set each person's role and permitted sections. Create rider accounts separately.
9. Test customer registration, a test order, admin order updates, staff sign-in, rider assignment and rider GPS from separate devices before sharing the site publicly. GPS and browser notifications require HTTPS, user permission and an active browser/device.
10. Add a custom domain in Render only after the generated onrender.com address has passed the tests. Configure DNS exactly as Render instructs.

LIVE PAYMENTS
Flutterwave integration is present but will remain unavailable until the business has an approved merchant account and the provider has enabled the required UGX Mobile Money/card channels. Add these values only in Render's private Environment settings, never in GitHub or chat:
- FLW_SECRET_KEY (start with a TEST key)
- FLW_WEBHOOK_SECRET_HASH (a long random secret also entered in the Flutterwave webhook settings)
- APP_BASE_URL (exact HTTPS origin, without a trailing slash)
- SESSION_SECRET (Render generates this in the Blueprint)

Configure the Flutterwave webhook to: https://YOUR-SERVICE-URL/api/payments/flutterwave/webhook and set its secret hash to the exact FLW_WEBHOOK_SECRET_HASH. The payment callback is https://YOUR-SERVICE-URL/payment-callback. Complete test transactions and verify them in the merchant dashboard before switching to live credentials. Never place gateway secrets in frontend files.

MTN MOMO / AIRTEL
The presence of environment-variable names does not activate direct MTN MoMo or Airtel Money APIs. Those require separate merchant approval, credentials and provider-specific integration. Do not tell customers those methods are automatic until they have been implemented and tested.

EMAIL / SMS / BACKGROUND NOTIFICATIONS
These require an email/SMS/push provider account and integration/configuration. Browser notifications currently depend on user permission and browser/device availability; they are not a substitute for guaranteed SMS or background push.

DATABASE AND BACKUPS
- Render's persistent disk is essential. Do not remove it or deploy to a plan without persistent-disk support.
- Do not upload a populated local database to a public repository.
- Before any schema update or migration, make a separate backup of /var/data/eddys-kitchen.db.
- Test restore procedures before taking real orders.
- A persistent disk protects against ordinary redeploys, but it is not a complete off-site backup strategy.

GO-LIVE CHECKLIST
[ ] /api/health reports ok:true and database:"ok"
[ ] First admin account created and credentials stored securely
[ ] Customer registration and sign-in tested on another device
[ ] Test order appears in admin and customer order history
[ ] Staff account can access only its assigned sections
[ ] Admin can see all business sections and staff activity
[ ] Rider can accept an assigned delivery and share GPS over HTTPS
[ ] Food image upload survives a redeploy
[ ] Database backup and restore tested
[ ] Flutterwave TEST payment verified end-to-end (if enabled)
[ ] Refund test completed in provider test environment (if enabled)
[ ] Privacy notice, terms, delivery and refund policies published

LIMITS
This package prepares the deployment configuration; it does not create your GitHub/Render accounts, publish the site, register a domain, approve merchant accounts, or supply secrets. A live deployment and end-to-end testing still have to be completed in those accounts. Do not accept real orders or payments until the checklist is passed.
