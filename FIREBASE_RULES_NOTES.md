# Firebase Watch security notes — Build 05

Build 05 uses the validated viewer-grant design agreed for Molt Watch.

A browser viewer is authenticated anonymously and may only create/delete its own entry under `liveMolts/<moltId>/viewers/<uid>`. The submitted join code is checked by Realtime Database Security Rules against the host-written `watchCode`. The browser never needs to read `watchCode` directly.

Keep these protections in place:

- `joinCodes/{code}`: exact-document GET for authenticated users; no collection LIST.
- `liveMolts/<moltId>`: read only for actual members or validated viewer UIDs.
- Browser viewer: no write permission to hostUid, members, locations, or messages.
- Host app: writes `watchCode` when the live Molt is created.
- Ending/deleting the live Molt removes its Watch access with the session.

App Check can be added after the first end-to-end production test.
