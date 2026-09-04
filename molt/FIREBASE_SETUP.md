# Molt browser Watch — Build 05

The website is connected to Firebase project `molt-e822a`.

## Live Watch flow

1. Browser signs in with Firebase Anonymous Authentication.
2. It gets the exact `joinCodes/{CODE}` document from Firestore.
3. The document supplies the matching `moltId`.
4. The browser writes only its own viewer request to:
   `liveMolts/<moltId>/viewers/<anonymousUid>`
5. Realtime Database Security Rules compare the submitted code with the host-written:
   `liveMolts/<moltId>/watchCode`
6. Once validated, the browser can read that Molt's live members and locations.

The website does not join the Molt as a participant and does not get permission to change vehicle locations, members, messages, or host data.

## Required

- Anonymous Authentication enabled in Firebase Authentication.
- Molt Build 21 or later used to create a new Meet & Drive session.
- Watch-compatible Realtime Database rules published.

Old sessions created before `watchCode` was added will not be browser-watchable with this flow.
