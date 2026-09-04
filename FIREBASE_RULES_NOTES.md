# Molt Website Build 06 — Firebase Watch rules

Build 06 moves browser viewer grants to a dedicated RTDB path:

`watchViewers/<moltId>/<anonymousUid>`

The browser submits the Molt code in its own grant record. Realtime Database rules compare it with the host-written `liveMolts/<moltId>/watchCode` without exposing the watch code through a public read. After the grant exists, the authenticated browser may read that one `liveMolts/<moltId>` session.

Publish the complete `database.rules.json` file in Firebase Console → Realtime Database → Rules.

The existing nested `liveMolts/<moltId>/viewers` rule is retained temporarily for Build 05 compatibility.
