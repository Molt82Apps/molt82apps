# Firebase Watch security notes

Build 04 is wired to the real Molt Firebase paths, but this package intentionally does **not** overwrite Firebase Security Rules.

Before changing rules, export/review the current Firestore and Realtime Database rules used by the Molt Android/iOS apps.

Recommended direction for browser Watch:

1. Enable Firebase Authentication > Sign-in method > Anonymous if the current security model permits it.
2. Allow a browser viewer to `get` a specific `joinCodes/{CODE}` document, but do not permit collection listing.
3. Allow only the corresponding Molt/session data and required live path to be read.
4. Do not grant browser write access to trip/session/live-location data.
5. Add App Check after the first end-to-end Watch test is working.

The next configuration step should be based on your *current* rules so the website does not break Molt app access.
