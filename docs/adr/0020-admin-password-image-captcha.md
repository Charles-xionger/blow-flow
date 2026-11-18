---
status: accepted
---

# Administrator login uses password and image CAPTCHA

Go API continues to own account identity and issue 15-minute signed JWTs, but the administrator login now uses a password and a single-use image CAPTCHA instead of TOTP. The user explicitly chose image verification and removed the authenticator code field. Image CAPTCHA limits simple automated submissions but is not a second authentication factor; this accepts lower assurance than ADR-0019. The API checks role and account status on every protected request, records administrator login, and requires a login no more than ten minutes old before disabling an account. Public creator registration remains separate and is not enabled by this decision.
