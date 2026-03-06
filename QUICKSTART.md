# Running Sentinel Locally

This guide is for running the current Sentinel prototype on Windows with PowerShell.

## What You Need

- Docker Desktop running with Linux containers enabled
- Python 3.12
- Node.js 20+
- Chrome

Optional:

- `OPENAI_API_KEY` for live outreach suggestions

Without an OpenAI key, the backend uses fallback outreach messages, which is fine for demo use.

## Project Components

Sentinel has three moving parts:

1. Redis
2. FastAPI backend
3. Next.js dashboard
4. Chrome extension

For local development, the simplest path is:

- run Redis with Docker
- run backend locally
- run dashboard locally
- build and load the extension in Chrome

## 1. Start Redis

Open PowerShell in the repo root:

```powershell
cd c:\Users\poonj\OneDrive\sentinel
docker compose up -d redis
```

If you get an error like:

```text
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified
```

Docker Desktop is not running. Start Docker Desktop first, wait for it to say the engine is running, then retry.

## 2. Start The Backend

Open a second PowerShell window:

```powershell
cd c:\Users\poonj\OneDrive\sentinel\backend
python -m pip install -r requirements.txt
```

Create `backend/.env` from `backend/.env.example` if you want config stored in a file:

```env
REDIS_URL=redis://localhost:6379/0
API_KEY=sentinel-hackathon-key
DASHBOARD_URL=http://localhost:3000
OPENAI_API_KEY=
```

Or set env vars in PowerShell and start the API directly:

```powershell
$env:REDIS_URL="redis://localhost:6379/0"
$env:API_KEY="sentinel-hackathon-key"
$env:DASHBOARD_URL="http://localhost:3000"
$env:OPENAI_API_KEY=""
python -m uvicorn app.main:app --reload
```

Backend health check:

```text
http://localhost:8000/api/v1/health
```

Expected response:

```json
{"status":"ok","service":"sentinel-api"}
```

## 3. Seed Demo Data

Optional, but useful to prove the dashboard is working before extension testing.

In the backend terminal:

```powershell
cd c:\Users\poonj\OneDrive\sentinel\backend
$env:REDIS_URL="redis://localhost:6379/0"
python scripts/seed_demo.py
```

## 4. Start The Dashboard

Open a third PowerShell window:

```powershell
cd c:\Users\poonj\OneDrive\sentinel\dashboard
```

If `node_modules` in this repo came from another machine or operating system, reinstall locally first:

```powershell
Remove-Item -Recurse -Force node_modules
npm install
```

Then start the dev server:

```powershell
$env:NEXT_PUBLIC_API_URL="http://localhost:8000"
npm run dev
```

Open:

```text
http://localhost:3000/dashboard
```

If you seeded demo data, you should already see accounts in the dashboard.

## 5. Build The Chrome Extension

Open a fourth PowerShell window:

```powershell
cd c:\Users\poonj\OneDrive\sentinel\extension
```

To avoid stale or cross-platform dependencies, reinstall locally:

```powershell
Remove-Item -Recurse -Force node_modules
npm install
```

Build the extension:

```powershell
npm run build
```

If `npm run build` fails because of a missing Rollup optional dependency on Windows, run:

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item -Force package-lock.json
npm install
npm run build
```

The built extension output should end up in:

[extension/dist](/c:/Users/poonj/OneDrive/sentinel/extension/dist)

## 6. Load The Extension In Chrome

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Remove any older unpacked Sentinel extension
4. Click `Load unpacked`
5. Select [extension/dist](/c:/Users/poonj/OneDrive/sentinel/extension/dist)

Important:

Chrome should load `dist`, not `src`.

## 7. Make Sure Chrome Is Using The Latest Build

The current popup should contain these buttons:

- `Save Configuration`
- `Test API`
- `Analyse Story`

If those buttons are missing, Chrome is still using an old `dist` build.

To fix that:

1. rebuild the extension
2. reload it in `chrome://extensions`
3. reopen the popup and confirm those buttons exist

## 8. Configure The Extension

In the Sentinel popup, use:

- API URL: `http://localhost:8000`
- API Key: `sentinel-hackathon-key`
- Risk Threshold: `40` for testing
- Score Weights: leave at `50 / 50`

Click `Save Configuration`.

Then click `Test API`.

Expected result:

```text
Backend API is reachable.
```

## 9. Test On Real Instagram

1. Open `https://www.instagram.com/`
2. Open browser DevTools on the Instagram tab
3. Open a Story
4. Open the Sentinel popup
5. Click `Analyse Story`

What success looks like:

- popup says something like `Analysed @username (NN/100)`
- the Instagram console shows Sentinel logs
- the backend receives a `POST /api/v1/scores`
- the dashboard updates

For automatic detection, move between Stories and watch for new scores without pressing the button again.

## 10. Useful Debug Views

### Backend

- Swagger docs: `http://localhost:8000/docs`
- Health: `http://localhost:8000/api/v1/health`

### Dashboard

- Queue: `http://localhost:3000/dashboard`

### Extension

- `chrome://extensions`
- click the Sentinel `service worker` link to view background logs

## Troubleshooting

## Docker Compose Cannot Pull Redis

Problem:

```text
open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified
```

Fix:

- start Docker Desktop
- wait until the engine is running
- retry `docker compose up -d redis`

## Dashboard Or Extension Uses The Wrong Node Modules

Problem:

- `next` or `tsc` is not recognized
- Rollup optional dependency errors
- `node_modules` came from another OS

Fix:

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item -Force package-lock.json
npm install
```

Use this inside the affected folder:

- [dashboard](/c:/Users/poonj/OneDrive/sentinel/dashboard)
- [extension](/c:/Users/poonj/OneDrive/sentinel/extension)

## Extension Popup Does Not Show `Test API` And `Analyse Story`

Problem:

- Chrome is loading an older `dist`

Fix:

1. rebuild the extension
2. reload the unpacked extension
3. make sure you loaded [extension/dist](/c:/Users/poonj/OneDrive/sentinel/extension/dist)

## `Analyse Story` Fails

Check these in order:

1. the active tab is Instagram
2. a Story is actually open
3. the content script is loaded
4. the extension was reloaded after rebuilding
5. the backend is reachable

## Minimal Demo Flow

If you need the fastest path to a working demo:

1. start Redis
2. start backend
3. seed demo data
4. start dashboard
5. rebuild and load the extension
6. verify popup has `Test API` and `Analyse Story`
7. run `Test API`
8. open a real Instagram Story
9. run `Analyse Story`
10. confirm the dashboard updates
