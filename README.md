# Vivo Vendor Onboarding Portal

An enterprise vendor onboarding & management portal for the **Vivo Tamil Nadu Marketing Team (Fangs Technology Pvt Ltd)**.

- **Live site:** https://vivo-vendor-portal-4f7a2.web.app
- **Firebase project:** `vivo-vendor-portal-4f7a2`

## What it does

- **Vendors** register themselves through a 10-step form (no login needed). Documents, GST, website, Instagram and YouTube are optional; everything else is required.
- **Admins** log in (Firebase Authentication) to review, approve/reject, score and manage vendors from a dashboard.
- Vendor submissions are stored in **Firebase Realtime Database**. Security rules allow vendors to *submit only* — only a signed-in admin can *read* vendor data.

## Tech

Plain HTML, CSS and JavaScript. No build step, no frameworks.

| File | Purpose |
|------|---------|
| `index.html` | Page structure |
| `style.css` | Styling |
| `script.js` | App logic |
| `firebase-init.js` | Firebase connection (public web config — safe to commit) |
| `database.rules.json` | Database security rules |
| `firebase.json`, `.firebaserc` | Firebase hosting/database config |

## Redeploy after changes

```bash
firebase deploy --only hosting        # push site changes live
firebase deploy --only database       # push security-rule changes
```
