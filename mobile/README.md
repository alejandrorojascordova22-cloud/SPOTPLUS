# SpotPlus frontend

The browser frontend uses React, TypeScript, and Vite. The Android and iOS apps
continue to use Expo.

## Run the local web app and API

From VS Code, open the Command Palette with `Ctrl+Shift+P`, run **Tasks: Run
Task**, and choose **SpotPlus: iniciar local**. This starts the backend and web
frontend as VS Code-managed tasks. Do not start duplicate instances in
separate PowerShell terminals. The workspace disables terminal-session
persistence so these local services are not restored as lingering terminals
when VS Code reopens; closing VS Code stops the task-managed services. The
backend then closes MT5 if it started that terminal. If you started the
backend or frontend manually before using this task, stop those old instances
first.

Start the backend from the repository root in one PowerShell terminal:

```powershell
.\venv\Scripts\Activate.ps1
python -m uvicorn backend.servidor:app --host 127.0.0.1 --port 8000
```

The backend needs a valid `API_KEY` in the repository-root `.env` file and a
MetaTrader 5 terminal logged into the configured account. If the backend starts
the terminal, it closes that terminal when the backend stops. If the MT5
connection is lost while the backend is running, it will not restart the
terminal automatically; restart the backend to reconnect. A terminal that was
already open before the backend started is left open when the backend stops.

In a second terminal, start Vite:

```powershell
cd .\mobile
npm run web
```

Open the address printed by Vite (normally http://localhost:5173). If that
port is already in use, Vite automatically selects the next available port.
During local development, requests use the current Vite address; Vite proxies
`/api` requests to the backend and adds `API_KEY` on the server side. The key
is not embedded in the browser bundle.

The production web bundle is checked and generated with:

```powershell
npm run build:web
```

## Manual grouped risk actions

The **Riesgo** tab can manually close or move the stop loss for open positions
filtered by symbol and BUY/SELL direction. Both actions require confirmation;
there is no automatic grouped close. Moving SL requires a positive buffer in
symbol points and only improves an existing stop. The buffer does not calculate
or guarantee coverage of broker commission, swap, or spread. Positions that
cannot safely accept the requested stop are reported as skipped.

## Analyst visual backtest

The Strategy tab's backtest uses the saved configuration from the Analyst
panel, including its enabled timeframes, confirmation rules, risk settings,
stop loss, and targets. Save changes in the Analyst panel before starting a
backtest. The replay displays simulated entries and exits progressively; it
does not place or modify MT5 orders. Historical candles must be available from
MT5 or the project's local CSV exports.

For a deployed web build or native app, configure `EXPO_PUBLIC_API_URL` and
`EXPO_PUBLIC_API_KEY` in a local environment file. Public `EXPO_PUBLIC_*`
values are included in the client bundle, so do not treat them as server-only
secrets.
