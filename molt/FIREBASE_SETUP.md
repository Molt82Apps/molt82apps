# Molt Web Firebase connection — Build 04

Build 04 uses Molt's existing Firebase data model.

## Firestore

- `joinCodes/{CODE}` resolves a public Molt code to `moltId`.
- `molts/{moltId}` supplies the trip/session record and destination.
- `molts/{moltId}/participants/*` is read as supplementary participant information.

Observed join-code fields include:

- `moltId`
- `hostName`
- `hostUid`
- `destination`
- `destinationLatitude`
- `destinationLongitude`

## Realtime Database

The browser subscribes to:

`liveMolts/{moltId}`

Observed live location structure:

`liveMolts/{moltId}/locations/{uid}`

- `heading`
- `latitude`
- `longitude`
- `speedKmh`
- `uid`
- `updatedAt`
- `vehicleColour`

Members are read from:

`liveMolts/{moltId}/members/{uid}`

## Authentication / Security Rules

The browser attempts Firebase Anonymous Authentication first. If Anonymous Authentication is not enabled, it continues unauthenticated so existing rules can decide whether the required reads are permitted.

Do not broadly make the databases public just to enable Molt Watch. Review the existing Android/iOS rules first, then add the narrowest browser-watch access compatible with the app's existing security model.

## Map

The live browser viewer uses Leaflet with OpenStreetMap tiles. This avoids adding a second Google Maps browser key while the live tracking/Firebase flow is being verified. The Molt app can continue using its existing map provider independently.
