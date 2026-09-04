# Molt Watch — Firebase-ready contract

Build 03 is prepared to read public Watch sessions from Firestore when the Molt Firebase project is connected.

## Web configuration
Fill the six web-app values in `molt/firebase-config.js`. Do not put Firebase Admin/service-account credentials in the website.

## Firestore path
`moltSessions/{MOLT_CODE}`

Recommended session document shape:

```json
{
  "shareEnabled": true,
  "status": "driving",
  "tripType": "meet_and_drive",
  "destination": {"name": "Destination", "lat": 0, "lng": 0},
  "meetup": {"name": "Meeting point", "lat": 0, "lng": 0, "status": "approaching"},
  "etaMinutes": 18,
  "distanceKm": 14.2,
  "participants": [
    {"id": "uid", "name": "Driver 1", "role": "host", "lat": 0, "lng": 0, "heading": 0, "etaMinutes": 18, "distanceKm": 14.2}
  ],
  "updatedAt": "server timestamp",
  "expiresAt": "timestamp"
}
```

The document ID should be the uppercase Molt share code. The Watch site reads only the requested document and subscribes to live changes.

## Security requirement
Before enabling live codes, add Firestore rules that expose only the minimum trip-scoped Watch data needed for a valid shared session. Never make the whole database publicly readable.
