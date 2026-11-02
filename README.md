# Eddys Kitchen — Online Deployment Package

This repository contains the application source and Render deployment configuration. It is prepared for upload to GitHub and hosting setup; it is **not live yet**.

## Folder guide

- `backend/` — Express server and database maintenance scripts.
- `frontend/` — customer website, admin interface, staff workspace and rider pages/assets.
- `scripts/` — workflow checks.
- `docs/` — hosting instructions and the original detailed project notes.
- `package.json` — Node.js dependencies and commands.
- `render.yaml` — Render service configuration with persistent disk settings.
- `.env.example` — names of environment variables; replace placeholders in the hosting dashboard, never commit real secrets.

## Upload to your existing GitHub repository

1. Extract this ZIP.
2. Open the extracted `Eddys-Kitchen-Online-Ready` folder. The `package.json` and `render.yaml` should be directly inside it (not hidden inside another project folder).
3. Upload the **contents** of that folder to the root of your private repository `eddy-kitchen`.
4. Do not upload `.env`, real API keys, passwords, database files, database backups, or customer data to GitHub.

## Deploy on Render

1. In Render, create a new Blueprint or Web Service connected to the GitHub repository.
2. If using Blueprint, Render reads `render.yaml`.
3. Confirm the persistent disk is mounted at `/var/data`. The app expects the database at `/var/data/eddys-kitchen.db` and uploads at `/var/data/uploads`.
4. Set required payment and notification credentials only in the Render environment settings after you have the approved merchant/provider accounts.
5. Deploy, then test customer registration, admin setup, order creation, payment callbacks, notifications, uploads, rider assignment and tracking.

## Database preservation — important

This source ZIP intentionally does not contain your live/local database. Before going online, make a separate backup of your existing database and migrate it to the persistent disk using a safe migration procedure. Do not overwrite an existing production database with an empty starter database. Keep a second backup before every migration.

## Commands

- `npm install` — install dependencies.
- `npm start` — start the server.
- `npm run check` — run JavaScript syntax checks.
- `npm run check:db` — inspect the configured database (requires the database to be present).
- `npm run check:workflow` — run workflow checks.

A successful ZIP integrity or syntax check does not prove that payment gateways, notifications, GPS tracking, or the production database are live. Those require provider credentials and end-to-end testing after deployment.
