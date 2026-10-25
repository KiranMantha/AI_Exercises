# Auth

Sessions expire after 24 hours of inactivity. Users are logged out when the session expires.

If a login fails with error ERR_AUTH_417, the token has been revoked. Ask the user to sign in again.

A password reset link is valid for 30 minutes. A refresh token can be used once to obtain a new session.
