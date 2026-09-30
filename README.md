# Shlen Box app

Stages 1–2 of V1 (see ../CURRENT_STATUS.md). Node.js 22.13 or newer, with its built-in SQLite. Two small libraries: `@simplewebauthn/server` (passkeys) and `web-push` (notifications).

    npm install --no-bin-links   # the shared project folder does not support symlinks

    npm test        # automated tests
    npm start       # runs at http://127.0.0.1:8080 (database: ./shlen-box.db)

Settings (environment variables): `SHLEN_DB`, `PORT`, `HOST`, `ORIGIN` (the address phones use; passkeys are tied to it), `SECURE=1` when served over HTTPS, `CONTACT` (email for notification services).

## Layout
- `server/db.js`: database schema. There is deliberately no drafts table.
- `server/rules.js`: pause rules and limits (pure functions).
- `server/coach.js`: the **stand-in** coach. It is rule-based, with the same interface the real AI helper will have.
- `server/passkeys.js`: Face ID / fingerprint sign-in and the 5-minute app lock. Only public keys are stored.
- `server/notify.js`: content-free notifications. Payloads never include message text.
- `server/app.js`: the HTTP API and static files, plus all "who may do what" checks.
- `public/`: the phone app (plain HTML, CSS and JS) and its service worker. Drafts are kept in the phone's own storage only. Colors are CSS variables at the top of `app.css`, so a new look can be swapped in there.
- `test/`: automated tests (node:test).

## Privacy rules the code enforces
- Draft text sent for checking is never stored and never logged. Logs contain only the method, path and status.
- Each person can delete only their own messages. Deleting a topic, or everything, needs both people.
- A pause is enforced by the server, not the phone.
- The app loads nothing from other websites (a strict Content-Security-Policy).
