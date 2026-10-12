# 📹 Voice & Video Calls — Setup Guide

Messenger-style 1:1 calls inside GBHub chat. Media goes peer-to-peer (WebRTC);
Firestore is only used to exchange the connection details ("signaling").
No extra server, no extra SDK.

## What was added / changed

| File | Change |
|------|--------|
| `js/call.js` | **New.** Whole call engine + UI (ringing, in-call screen, controls, call log). |
| `js/chat.js` | 📞 / 📹 buttons in the chat header, and call entries in the thread ("📹 Video call · 05:32", "Missed video call" + *Call back*). |
| `firestore.rules` | New `calls` rules (+ `callerCandidates` / `calleeCandidates`). |
| all `*.html` | `<script src="js/call.js">` added after `notification.js`, so **incoming calls ring on any page**. |

## Features

- Voice call and video call from the chat header
- Incoming-call banner with Accept / Decline, ringtone (WebAudio, no audio file), vibration on mobile, tab-title flash
- Mute mic, camera on/off, flip front/back camera (phones), **share screen** (desktop) — the other side sees when your mic/camera is off
- Draggable self-view, call timer, controls auto-hide on video calls
- No camera? A video call automatically continues as voice-only
- Busy signal if the person is already on a call; "No answer" after 45 s
- Every call leaves an entry in the chat; missed calls bump the unread badge
- Only people who already share a chat can call each other (enforced in the rules)

## Deploy (do this or calls will get `permission-denied`)

```bash
firebase deploy --only firestore:rules
firebase deploy --only hosting
```

Run from the folder that contains `firebase.json`.

## Testing

Calls need **HTTPS** (Firebase Hosting is fine) or `localhost`.
Use two different accounts in two different browsers/devices — same browser
profile with the same account will not work. Open a chat between them, press 📹.

## Important: TURN server (recommended before real users)

The defaults use free public STUN servers. That connects most people, but
**fails on some networks** (strict Wi-Fi / office firewalls, some mobile carriers).
For those you need a TURN relay. Get credentials from a provider
(e.g. Metered, Twilio, Cloudflare) or run your own coturn, then add this
**before** `js/call.js` in your pages (or in `navbar-template.js`):

```html
<script>
  window.GBH_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:YOUR_TURN_HOST:3478', username: 'USER', credential: 'PASS' }
  ];
</script>
```

Note: credentials placed in client code are visible to anyone; use a provider
that issues short-lived credentials if abuse becomes a concern.

## Optional: auto-clean old call data

Each call leaves a small doc plus ICE-candidate docs. They carry an `expireAt`
field (7 days). In Firebase Console → Firestore → **TTL**, add policies on
`expireAt` for the collection groups `calls`, `callerCandidates`, `calleeCandidates`.

## Known limits

- The site is multi-page, so **navigating away or refreshing ends the call**
  (the browser asks for confirmation during a live call). Keep the call tab open.
- 1-to-1 only (no group calls). Voice → video upgrade mid-call is not included.
- Calling from the inline trade-offer chat panels is not wired up yet — only from `messages.html`.
