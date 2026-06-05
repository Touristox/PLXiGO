# Five in Row Online

Realtime 2-player Five in Row game with email-code account login, profile display names, and Gravatar-style email avatars.

## Run locally

```bash
npm install
PORT=3005 SESSION_SECRET=dev-secret APP_URL=http://localhost:3005 npm start
```

Open:

```text
http://localhost:3005
```

## Notes

- User data is stored in `data/users.json` when the server runs.
- Email sending is currently test-mode: verification codes are shown in the UI and logged by the server.
- To use real email delivery, connect an email provider in `server.js` inside `sendVerificationEmail()`.
- For subpath deployment like `/5inrow`, proxy the app to this server and use WebSocket path `/5inrow-ws`.
