// ═══════════════════════════════════════════════════════════════
// call.js — Messenger-style 1:1 voice & video calls
//
//   • Media travels peer-to-peer (WebRTC)
//   • Signaling (offer / answer / ICE candidates) goes through Firestore:
//       /calls/{callId}
//       /calls/{callId}/callerCandidates/{id}
//       /calls/{callId}/calleeCandidates/{id}
//   • Loaded on EVERY page, so an incoming call rings wherever the user is.
//   • Optional: define window.GBH_ICE_SERVERS (with a TURN server) BEFORE
//     this script loads to make calls work on strict networks. See CALL_SETUP.md
// ═══════════════════════════════════════════════════════════════
(function () {
  'use strict';
  if (window.GBHCall) return;

  const RING_TIMEOUT_MS    = 45000;   // caller gives up → "missed"
  const STALE_MS           = 90000;   // ignore ringing docs older than this
  const RECONNECT_GRACE_MS = 15000;   // ICE "disconnected" for this long → end
  const TERMINAL           = ['ended', 'declined', 'cancelled', 'missed', 'busy'];
  const ICE_SERVERS = window.GBH_ICE_SERVERS || [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];

  // ── tiny helpers ───────────────────────────────
  const $     = (id) => document.getElementById(id);
  const db    = () => firebase.firestore();
  const FV    = () => firebase.firestore.FieldValue;
  const toast = (m, t) => { if (typeof showToast === 'function') showToast(m, t); else console.log('[call]', m); };
  const esc   = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const pad   = (n) => String(n).padStart(2, '0');
  const fmt   = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return (h ? h + ':' : '') + pad(m) + ':' + pad(s % 60); };
  const expireAt = () => firebase.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 3600 * 1000);

  let myUid = null, incomingUnsub = null, call = null;

  function me() {
    const u = firebase.auth().currentUser;
    if (!u) return null;
    const s = (typeof state !== 'undefined' && state.currentUser) || {};
    return { uid: u.uid, name: s.name || s.displayName || u.displayName || 'User' };
  }

  // ── icons ──────────────────────────────────────
  const IC = {
    mic:      '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
    micoff:   '<line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
    video:    '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>',
    videooff: '<path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"/><line x1="1" y1="1" x2="23" y2="23"/>',
    phone:    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    flip:     '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    share:    '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  };
  IC.hang = '<g transform="rotate(135 12 12)">' + IC.phone + '</g>';
  const ic = (n, s) => '<svg viewBox="0 0 24 24" width="' + (s || 24) + '" height="' + (s || 24) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + IC[n] + '</svg>';

  // ── styles (injected so only this one file is needed) ──
  (function injectCss() {
    if ($('gbhCallCss')) return;
    const st = document.createElement('style');
    st.id = 'gbhCallCss';
    st.textContent = `
.gbh-call{position:fixed;inset:0;z-index:10000;background:#05070d;color:#fff;font-family:var(--font-body,'Inter'),system-ui,sans-serif;overflow:hidden;user-select:none;-webkit-user-select:none}
.gbh-remote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;opacity:0;transition:opacity .3s}
.gbh-call.show-video .gbh-remote{opacity:1}
.gbh-stage{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;background:radial-gradient(circle at 50% 35%,#16223a 0%,#070a12 72%)}
.gbh-call.show-video .gbh-stage{display:none}
.gbh-av{width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,var(--accent-cyan,#00e5ff),var(--accent-purple,#9b5de5));display:flex;align-items:center;justify-content:center;font-size:2.6rem;font-weight:700;color:#0a0e1a;overflow:hidden}
.gbh-av img{width:100%;height:100%;object-fit:cover}
.gbh-call:not(.connected) .gbh-av{animation:gbhPulse 1.8s infinite}
@keyframes gbhPulse{0%{box-shadow:0 0 0 0 rgba(91,108,255,.5)}100%{box-shadow:0 0 0 38px rgba(91,108,255,0)}}
.gbh-pname{font-family:var(--font-head);font-size:1.7rem;font-weight:700;margin-top:8px}
.gbh-pstat{color:#9fb0c8;font-size:.95rem;min-height:1.2em;font-variant-numeric:tabular-nums}
.gbh-top{position:absolute;top:0;left:0;right:0;z-index:3;display:flex;align-items:center;gap:10px;padding:calc(14px + env(safe-area-inset-top,0px)) 18px 34px;background:linear-gradient(#000a,#0000);font-weight:600;transition:opacity .25s}
.gbh-top .gbh-time{margin-left:auto;font-variant-numeric:tabular-nums;opacity:.9}
.gbh-chip{font-size:.72rem;font-weight:600;padding:3px 9px;border-radius:99px;background:rgba(255,255,255,.18)}
.gbh-chip[hidden]{display:none}
.gbh-local{position:absolute;right:16px;bottom:120px;width:120px;aspect-ratio:3/4;object-fit:cover;border-radius:14px;background:#111;border:2px solid rgba(255,255,255,.25);box-shadow:0 6px 24px #000a;z-index:4;touch-action:none;cursor:grab;transform:scaleX(-1)}
.gbh-local.nomirror{transform:none}
.gbh-local.off,.gbh-call.is-audio .gbh-local{display:none}
.gbh-ctrls{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;justify-content:center;flex-wrap:wrap;gap:14px;padding:18px 12px calc(22px + env(safe-area-inset-bottom,0px));background:linear-gradient(#0000,#000b);transition:opacity .25s}
.gbh-call.idle .gbh-ctrls,.gbh-call.idle .gbh-top{opacity:0;pointer-events:none}
.gbh-cbtn{width:56px;height:56px;border-radius:50%;border:none;background:rgba(255,255,255,.16);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .15s,background .15s}
.gbh-cbtn:hover{background:rgba(255,255,255,.28)}
.gbh-cbtn:active{transform:scale(.92)}
.gbh-cbtn.on{background:#fff;color:#111}
.gbh-cbtn.end{background:#ff3b4e}
.gbh-cbtn.end:hover{background:#ff5666}
.gbh-cbtn[hidden]{display:none}
.gbh-cbtn:disabled{opacity:.4;cursor:not-allowed}
@media(max-width:600px){.gbh-local{width:96px;bottom:110px;right:12px}.gbh-av{width:104px;height:104px}}

.gbh-incoming{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:10001;width:min(440px,calc(100vw - 24px));display:flex;align-items:center;gap:12px;padding:12px 14px;background:var(--bg-card,#0f1422);border:1px solid var(--border-hover,rgba(91,108,255,.4));border-radius:16px;box-shadow:0 12px 40px #000c;color:var(--text-primary,#e8eaf6);font-family:var(--font-body,'Inter'),system-ui,sans-serif;animation:gbhDrop .35s cubic-bezier(.2,1.2,.4,1)}
@keyframes gbhDrop{from{transform:translate(-50%,-140%)}to{transform:translate(-50%,0)}}
.gbh-in-av{width:48px;height:48px;border-radius:50%;flex-shrink:0;overflow:hidden;background:linear-gradient(135deg,var(--accent-cyan,#00e5ff),var(--accent-purple,#9b5de5));display:flex;align-items:center;justify-content:center;font-weight:700;color:#0a0e1a;animation:gbhPulse 1.8s infinite}
.gbh-in-av img{width:100%;height:100%;object-fit:cover}
.gbh-in-txt{flex:1;min-width:0;display:flex;flex-direction:column}
.gbh-in-txt b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gbh-in-txt span{font-size:.8rem;color:var(--text-secondary,#8892aa)}
.gbh-rbtn{width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .15s}
.gbh-rbtn:active{transform:scale(.92)}
.gbh-rbtn.accept{background:#19c463}
.gbh-rbtn.decline{background:#ff3b4e}

.call-actions{display:flex;gap:4px;margin-left:auto}
.call-hdr-btn{width:38px;height:38px;border-radius:50%;border:none;background:transparent;color:var(--accent-cyan,#00e5ff);cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s}
.call-hdr-btn:hover{background:rgba(91,108,255,.12)}
.msg-row.call-log{justify-content:center;margin:8px 0}
.call-log-pill{display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;justify-content:center;background:var(--bg-card2,#131828);border:1px solid var(--border,rgba(91,108,255,.15));border-radius:999px;padding:7px 14px;font-size:.8rem;color:var(--text-secondary,#8892aa)}
.call-log-pill.missed{color:#ff6b7a;border-color:rgba(255,80,100,.3)}
.call-log-pill .call-log-time{opacity:.6;font-size:.72rem}
.call-log-pill button{background:none;border:none;color:var(--accent-cyan,#00e5ff);cursor:pointer;font:inherit;font-weight:600;padding:0}
`;
    document.head.appendChild(st);
  })();

  // ── ringtone (WebAudio — no audio asset needed) ───
  // Browsers only allow sound after the user has interacted with the page once.
  let actx = null, ringT = null, titleT = null, origTitle = null;
  function unlockAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (_) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlockAudio, { passive: true }));

  function beep(freq, at, dur, vol) {
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + at;
    o.type = 'sine'; o.frequency.value = freq;
    o.connect(g); g.connect(actx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
    g.gain.setValueAtTime(vol, t + dur - 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function startRing(kind) {
    stopRing();
    const play = () => {
      if (kind === 'in' && navigator.vibrate) navigator.vibrate([350, 150, 350]);
      if (!actx || actx.state !== 'running') return;
      if (kind === 'in') { beep(880, 0, 0.25, 0.18); beep(660, 0.3, 0.25, 0.18); beep(880, 0.9, 0.25, 0.18); beep(660, 1.2, 0.25, 0.18); }
      else beep(440, 0, 0.9, 0.08);
    };
    play();
    ringT = setInterval(play, kind === 'in' ? 2600 : 3200);
  }
  function stopRing() {
    clearInterval(ringT); ringT = null;
    if (navigator.vibrate) navigator.vibrate(0);
  }
  function flashTitle(text) {
    clearInterval(titleT); titleT = null;
    if (origTitle !== null) { document.title = origTitle; origTitle = null; }
    if (!text) return;
    origTitle = document.title;
    let f = false;
    titleT = setInterval(() => { f = !f; document.title = f ? text : origTitle; }, 900);
  }

  // ── media ──────────────────────────────────────
  async function getMedia(wantVideo, facing) {
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio,
        video: wantVideo ? { facingMode: facing || 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
      });
      return { stream, video: wantVideo };
    } catch (e) {
      // No usable camera → fall back to a voice-only call instead of failing
      if (wantVideo && e && ['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError', 'NotReadableError', 'TrackStartError'].indexOf(e.name) !== -1) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio });
        toast('Could not use your camera — continuing with voice only.', 'error');
        return { stream, video: false };
      }
      throw e;
    }
  }
  function mediaError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Please allow microphone/camera access in your browser to make calls.';
    if (n === 'NotFoundError') return 'No microphone was found on this device.';
    return 'Could not start your microphone/camera.';
  }
  const stopStream = (s) => { if (s) s.getTracks().forEach((t) => t.stop()); };

  // ── context ────────────────────────────────────
  function newCtx(role, isVideo, peer, chatId) {
    return {
      role, isVideo, peer, chatId,
      unsubs: [], candQueue: [], pendingCands: [],
      docReady: false, done: false, answered: false,
      phase: role === 'caller' ? 'active' : 'incoming',
      micOn: true, camOn: false, hasVideo: false, facing: 'user',
      connectedAt: null, st: '',
    };
  }

  // ── peer connection ────────────────────────────
  function makePC(c) {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    c.pc = pc;
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const d = e.candidate.toJSON();
      if (c.docReady) sendCand(c, d); else c.candQueue.push(d);
    };
    pc.ontrack = (e) => {
      let s = e.streams && e.streams[0];
      if (!s) { c.remoteStream = c.remoteStream || new MediaStream(); c.remoteStream.addTrack(e.track); s = c.remoteStream; }
      const v = $('gbhRemote');
      if (v && v.srcObject !== s) v.srcObject = s;
      if (v) v.play().catch(() => {});
    };
    pc.oniceconnectionstatechange = () => onIce(c);
    return pc;
  }

  function sendCand(c, d) {
    c.ref.collection(c.role === 'caller' ? 'callerCandidates' : 'calleeCandidates')
      .add(Object.assign({}, d, { expireAt: expireAt() })).catch(() => {});
  }
  function gotRemoteCand(c, d) {
    if (c.pc && c.pc.remoteDescription) {
      c.pc.addIceCandidate(new RTCIceCandidate({
        candidate: d.candidate, sdpMid: d.sdpMid, sdpMLineIndex: d.sdpMLineIndex, usernameFragment: d.usernameFragment,
      })).catch(() => {});
    } else c.pendingCands.push(d);   // remote description not set yet — hold on to it
  }
  function flushPending(c) { const l = c.pendingCands; c.pendingCands = []; l.forEach((d) => gotRemoteCand(c, d)); }
  function listenCands(c) {
    const col = c.role === 'caller' ? 'calleeCandidates' : 'callerCandidates';
    c.unsubs.push(c.ref.collection(col).onSnapshot((snap) => {
      snap.docChanges().forEach((ch) => { if (ch.type === 'added') gotRemoteCand(c, ch.doc.data()); });
    }, () => {}));
  }

  function onIce(c) {
    if (c.done || !c.pc) return;
    const st = c.pc.iceConnectionState;
    if (st === 'connected' || st === 'completed') {
      clearTimeout(c.dropTimer); c.dropTimer = null;
      if (!c.connectedAt) {
        c.connectedAt = Date.now();
        stopRing();
        c.tick = setInterval(renderTimer, 1000);
        const ov = $('gbhCall'); if (ov) ov.classList.add('connected');
      }
      setState(c, 'connected');
    } else if (st === 'disconnected') {
      setState(c, 'reconnecting');
      if (!c.dropTimer) c.dropTimer = setTimeout(() => finish(c, 'failed', true), RECONNECT_GRACE_MS);
    } else if (st === 'failed') {
      finish(c, 'failed', true);
    } else if (st === 'checking') {
      setState(c, 'connecting');
    }
  }

  // ── UI: in-call overlay ────────────────────────
  const avatarHtml = (p) => p.avatar ? '<img src="' + esc(p.avatar) + '" alt="">' : '<span>' + esc((p.name || '?')[0].toUpperCase()) + '</span>';

  function buildOverlay(c) {
    removeOverlay();
    const el = document.createElement('div');
    el.id = 'gbhCall';
    el.className = 'gbh-call ' + (c.isVideo ? 'is-video' : 'is-audio');
    el.innerHTML =
        '<video id="gbhRemote" class="gbh-remote" autoplay playsinline></video>'
      + '<div class="gbh-stage"><div class="gbh-av" id="gbhAv">' + avatarHtml(c.peer) + '</div>'
      +   '<div class="gbh-pname">' + esc(c.peer.name) + '</div><div class="gbh-pstat" id="gbhStatus"></div></div>'
      + '<div class="gbh-top"><span>' + esc(c.peer.name) + '</span><span class="gbh-chip" id="gbhPeerMuted" hidden>🔇 Muted</span><span class="gbh-time" id="gbhTopTime"></span></div>'
      + '<video id="gbhLocal" class="gbh-local" autoplay playsinline muted></video>'
      + '<div class="gbh-ctrls" id="gbhCtrls">'
      +   '<button class="gbh-cbtn" id="gbhMicBtn" title="Mute" onclick="GBHCall.toggleMic()">' + ic('mic') + '</button>'
      +   '<button class="gbh-cbtn" id="gbhCamBtn" title="Camera" onclick="GBHCall.toggleCam()" hidden>' + ic('video') + '</button>'
      +   '<button class="gbh-cbtn" id="gbhFlipBtn" title="Flip camera" onclick="GBHCall.flipCamera()" hidden>' + ic('flip') + '</button>'
      +   '<button class="gbh-cbtn" id="gbhShareBtn" title="Share screen" onclick="GBHCall.toggleShare()" hidden>' + ic('share') + '</button>'
      +   '<button class="gbh-cbtn end" title="End call" onclick="GBHCall.hangup()">' + ic('hang') + '</button>'
      + '</div>';
    document.body.appendChild(el);
    makeDraggable($('gbhLocal'));
    const wake = () => wakeCtrls(c);
    el.addEventListener('pointermove', wake);
    el.addEventListener('click', wake);
    const cb = $('gbhCamBtn'); if (cb) cb.hidden = !c.isVideo;
  }
  function removeOverlay() { const o = $('gbhCall'); if (o) o.remove(); }

  function attachLocal(c) {
    const lv = $('gbhLocal'), ov = $('gbhCall');
    if (!lv || !ov) return;
    c.camOn = c.hasVideo; c.micOn = true;
    lv.srcObject = c.local;
    lv.classList.toggle('off', !c.hasVideo);
    ov.classList.toggle('is-video', c.isVideo);
    ov.classList.toggle('is-audio', !c.isVideo);
    const cb = $('gbhCamBtn'); if (cb) { cb.hidden = !c.isVideo; cb.disabled = !c.hasVideo; }
    const sb = $('gbhShareBtn'); if (sb) sb.hidden = !(c.hasVideo && navigator.mediaDevices.getDisplayMedia);
    if (c.hasVideo && navigator.mediaDevices.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then((ds) => {
        const fb = $('gbhFlipBtn');
        if (fb && ds.filter((d) => d.kind === 'videoinput').length > 1) fb.hidden = false;
      }).catch(() => {});
    }
  }

  function makeDraggable(el) {
    if (!el) return;
    let sx, sy, ox, oy, drag = false;
    el.addEventListener('pointerdown', (e) => {
      drag = true; el.setPointerCapture(e.pointerId);
      const r = el.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.left = ox + 'px'; el.style.top = oy + 'px';
    });
    el.addEventListener('pointermove', (e) => {
      if (!drag) return;
      el.style.left = Math.min(innerWidth - el.offsetWidth - 4, Math.max(4, ox + e.clientX - sx)) + 'px';
      el.style.top  = Math.min(innerHeight - el.offsetHeight - 4, Math.max(4, oy + e.clientY - sy)) + 'px';
    });
    const up = () => { drag = false; };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  }

  function wakeCtrls(c) {
    const ov = $('gbhCall'); if (!ov || c.done) return;
    ov.classList.remove('idle');
    clearTimeout(c.idleT);
    if (c.isVideo && c.connectedAt) c.idleT = setTimeout(() => ov.classList.add('idle'), 4000);
  }

  const STATUS_TXT = { calling: 'Calling…', connecting: 'Connecting…', reconnecting: 'Reconnecting…' };
  function setStatus(txt) { const s = $('gbhStatus'); if (s) s.textContent = txt; }
  function setState(c, st) {
    c.st = st;
    if (st === 'connected') { syncStage(c); renderTimer(); wakeCtrls(c); }
    else {
      setStatus(STATUS_TXT[st] || '');
      const t = $('gbhTopTime'); if (t) t.textContent = st === 'reconnecting' ? 'Reconnecting…' : '';
    }
  }
  function renderTimer() {
    const c = call; if (!c || !c.connectedAt || c.st !== 'connected') return;
    const t = fmt((Date.now() - c.connectedAt) / 1000);
    setStatus(t);
    const tt = $('gbhTopTime'); if (tt) tt.textContent = t;
  }
  // Show the remote video only when it's a video call, we're connected, and they have their camera on
  function syncStage(c) {
    const ov = $('gbhCall'); if (!ov) return;
    ov.classList.toggle('show-video', !!(c.isVideo && c.connectedAt && c.peerCam !== false));
  }
  function applyPeerMedia(c, pm) {
    c.peerCam = pm.cam !== false;
    const m = $('gbhPeerMuted'); if (m) m.hidden = pm.mic !== false;
    syncStage(c);
  }

  // ── UI: incoming banner ────────────────────────
  function showIncoming(c) {
    removeIncoming();
    const el = document.createElement('div');
    el.id = 'gbhIncoming'; el.className = 'gbh-incoming';
    el.innerHTML =
        '<div class="gbh-in-av">' + avatarHtml(c.peer) + '</div>'
      + '<div class="gbh-in-txt"><b>' + esc(c.peer.name) + '</b><span>Incoming ' + (c.isVideo ? 'video' : 'voice') + ' call…</span></div>'
      + '<button class="gbh-rbtn decline" title="Decline" onclick="GBHCall.decline()">' + ic('hang', 20) + '</button>'
      + '<button class="gbh-rbtn accept" title="Accept" onclick="GBHCall.accept()">' + ic(c.isVideo ? 'video' : 'phone', 20) + '</button>';
    document.body.appendChild(el);
  }
  function removeIncoming() { const e = $('gbhIncoming'); if (e) e.remove(); }

  // ═══════════════════════════════════════════════
  // CALLER
  // ═══════════════════════════════════════════════
  async function start(opts, wantVideo) {
    unlockAudio();
    const m = me();
    if (!m) { toast('Please sign in first.', 'error'); return; }
    if (call) { toast('You are already in a call.', 'error'); return; }
    if (!window.RTCPeerConnection || !navigator.mediaDevices || !window.isSecureContext) {
      toast('Calls need a modern browser and an HTTPS connection.', 'error'); return;
    }
    if (!opts || !opts.chatId || !opts.partnerUid) return;

    const c = newCtx('caller', !!wantVideo, { uid: opts.partnerUid, name: opts.partnerName || 'User', avatar: opts.partnerAvatar || null }, opts.chatId);
    call = c;
    buildOverlay(c); setState(c, 'calling'); startRing('out');

    try {
      const mm = await getMedia(c.isVideo);
      if (c.done) { stopStream(mm.stream); return; }       // user hung up while we were asking for permission
      c.local = mm.stream; c.hasVideo = mm.video; c.isVideo = mm.video;   // no camera → becomes a voice call
      attachLocal(c);

      const pc = makePC(c);
      c.local.getTracks().forEach((t) => pc.addTrack(t, c.local));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (c.done) return;

      c.ref = db().collection('calls').doc();
      c.id = c.ref.id;
      await c.ref.set({
        callerId: m.uid, calleeId: c.peer.uid,
        callerName: m.name, calleeName: c.peer.name,
        chatId: c.chatId, type: c.isVideo ? 'video' : 'audio', status: 'ringing',
        offer: { type: offer.type, sdp: offer.sdp },
        media: { [m.uid]: { cam: c.hasVideo, mic: true } },
        createdAt: FV().serverTimestamp(), expireAt: expireAt(),
      });
      if (c.done) { c.ref.update({ status: 'cancelled', endedAt: Date.now() }).catch(() => {}); return; }

      c.docReady = true;
      c.candQueue.splice(0).forEach((d) => sendCand(c, d));    // send candidates gathered while the doc was being created
      c.unsubs.push(c.ref.onSnapshot((s) => onCallDoc(c, s), () => {}));
      listenCands(c);
      c.ringTimer = setTimeout(() => { if (!c.answered) finish(c, 'missed', true); }, RING_TIMEOUT_MS);
    } catch (e) {
      console.error('Start call failed:', e);
      toast(e && e.name ? mediaError(e) : 'Could not start the call. Please try again.', 'error');
      abort(c);
    }
  }

  // ═══════════════════════════════════════════════
  // CALLEE
  // ═══════════════════════════════════════════════
  function listenIncoming() {
    if (incomingUnsub) { incomingUnsub(); incomingUnsub = null; }
    if (!myUid) return;
    incomingUnsub = db().collection('calls')
      .where('calleeId', '==', myUid).where('status', '==', 'ringing')
      .onSnapshot((snap) => {
        snap.docChanges().forEach((ch) => {
          if (ch.type !== 'added') return;
          const d = ch.doc.data();
          const created = d.createdAt && d.createdAt.toMillis ? d.createdAt.toMillis() : Date.now();
          if (Date.now() - created > STALE_MS) return;
          onIncoming(ch.doc.id, d);
        });
      }, (err) => console.warn('Incoming-call listener error (are firestore.rules deployed?):', err && err.code));
  }

  function onIncoming(id, d) {
    const ref = db().collection('calls').doc(id);
    if (call) { ref.update({ status: 'busy', endedAt: Date.now() }).catch(() => {}); return; }

    const c = newCtx('callee', d.type === 'video', { uid: d.callerId, name: d.callerName || 'Someone', avatar: null }, d.chatId);
    c.id = id; c.ref = ref; c.offer = d.offer; c.docReady = true;
    call = c;

    // Avatar isn't stored on the call doc (could be huge) — pull it from the chat doc
    db().collection('chats').doc(d.chatId).get().then((s) => {
      if (!s.exists || call !== c) return;
      const a = (s.data().participantAvatars || {})[c.peer.uid];
      if (!a) return;
      c.peer.avatar = a;
      const x = document.querySelector('#gbhIncoming .gbh-in-av'); if (x) x.innerHTML = avatarHtml(c.peer);
    }).catch(() => {});

    showIncoming(c); startRing('in');
    flashTitle('📞 ' + c.peer.name + ' is calling…');
    try {
      if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        c.notif = new Notification(c.peer.name + ' is calling…', { body: 'Incoming ' + (c.isVideo ? 'video' : 'voice') + ' call on GameBarterHub', tag: 'gbh-call' });
        c.notif.onclick = () => { window.focus(); c.notif.close(); };
      }
    } catch (_) {}

    c.unsubs.push(ref.onSnapshot((s) => onCallDoc(c, s), () => {}));
    c.ringTimer = setTimeout(() => {
      if (c.phase === 'incoming') finish(c, 'missed', true);
    }, RING_TIMEOUT_MS + 5000);
  }

  async function accept() {
    const c = call;
    if (!c || c.role !== 'callee' || c.phase !== 'incoming') return;
    c.phase = 'active';
    unlockAudio(); stopRing(); flashTitle(null); clearTimeout(c.ringTimer); removeIncoming();
    buildOverlay(c); setState(c, 'connecting');
    try {
      const mm = await getMedia(c.isVideo);
      if (c.done) { stopStream(mm.stream); return; }
      c.local = mm.stream; c.hasVideo = mm.video;
      attachLocal(c);

      const pc = makePC(c);
      c.local.getTracks().forEach((t) => pc.addTrack(t, c.local));
      await pc.setRemoteDescription(new RTCSessionDescription(c.offer));
      listenCands(c); flushPending(c);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      await c.ref.update({
        status: 'accepted', acceptedAt: Date.now(),
        answer: { type: ans.type, sdp: ans.sdp },
        ['media.' + myUid]: { cam: c.hasVideo, mic: true },
      });
    } catch (e) {
      console.error('Accept call failed:', e);
      toast(e && e.name ? mediaError(e) : 'Could not join the call.', 'error');
      if (!c.done) finish(c, 'declined', true);
    }
  }

  function decline() {
    const c = call;
    if (c && c.role === 'callee' && c.phase === 'incoming') finish(c, 'declined', true);
  }

  // ═══════════════════════════════════════════════
  // SHARED: reacting to the call document
  // ═══════════════════════════════════════════════
  function onCallDoc(c, snap) {
    if (c.done || !snap.exists) return;
    const d = snap.data();

    const pm = d.media && d.media[c.peer.uid];
    if (pm) applyPeerMedia(c, pm);

    if (c.role === 'caller' && d.answer && !c.answered) {
      c.answered = true; clearTimeout(c.ringTimer); stopRing(); setState(c, 'connecting');
      c.pc.setRemoteDescription(new RTCSessionDescription(d.answer))
        .then(() => flushPending(c))
        .catch((err) => { console.error('setRemoteDescription failed', err); finish(c, 'failed', true); });
    }

    // Same account open in another tab that already picked up → stop ringing here
    if (c.role === 'callee' && c.phase === 'incoming' && d.status === 'accepted') { abort(c); return; }

    if (TERMINAL.indexOf(d.status) !== -1) finish(c, d.status, false);
  }

  // ═══════════════════════════════════════════════
  // ENDING
  // ═══════════════════════════════════════════════
  const END_TXT = { ended: 'Call ended', declined: 'Call declined', cancelled: 'Call cancelled', missed: 'No answer', busy: 'User is busy', failed: 'Connection lost' };

  // status: ended | declined | cancelled | missed | busy | failed   — mine: did *this* client cause it?
  function finish(c, status, mine) {
    if (c.done) return;
    c.done = true;
    const secs = c.connectedAt ? (Date.now() - c.connectedAt) / 1000 : 0;

    if (mine && c.ref) c.ref.update({ status: status === 'failed' ? 'ended' : status, endedAt: Date.now() }).catch(() => {});
    if (c.role === 'caller' && c.ref) writeLog(c, status, Math.round(secs));   // only the caller logs, so it's never duplicated

    const ov = $('gbhCall');
    if (ov) {
      ov.classList.remove('show-video', 'idle'); ov.classList.add('ending');
      setStatus(status === 'ended' && secs > 0 ? 'Call ended · ' + fmt(secs) : (END_TXT[status] || 'Call ended'));
      const tt = $('gbhTopTime'); if (tt) tt.textContent = '';
      const ctr = $('gbhCtrls'); if (ctr) ctr.style.display = 'none';
      setTimeout(() => { if ($('gbhCall') === ov) ov.remove(); }, 1600);
    } else if (!mine && c.role === 'callee' && (status === 'cancelled' || status === 'missed')) {
      toast('Missed ' + (c.isVideo ? 'video' : 'voice') + ' call from ' + c.peer.name, 'error');
    }
    if (status === 'failed') toast('The call dropped — the connection was lost.', 'error');
    cleanup(c);
  }

  function abort(c) {            // silent teardown (errors, logout, answered on another tab)
    if (c.done) return;
    c.done = true;
    cleanup(c);
    removeOverlay();
  }

  function cleanup(c) {
    clearTimeout(c.ringTimer); clearTimeout(c.dropTimer); clearTimeout(c.idleT); clearInterval(c.tick);
    c.unsubs.forEach((u) => { try { u(); } catch (_) {} }); c.unsubs = [];
    stopRing(); flashTitle(null);
    try { if (c.notif) c.notif.close(); } catch (_) {}
    stopStream(c.local); stopStream(c.screenStream);
    try { if (c.pc) c.pc.close(); } catch (_) {}
    const rv = $('gbhRemote'); if (rv) rv.srcObject = null;
    removeIncoming();
    if (call === c) call = null;
  }

  function hangup() {
    const c = call;
    if (!c || c.done) return;
    if (c.role === 'caller' && !c.answered) finish(c, 'cancelled', true);
    else finish(c, 'ended', true);
  }

  // Leaves an entry in the chat thread ("📹 Video call · 05:32", "Missed video call", …)
  async function writeLog(c, status, secs) {
    try {
      const video = c.isVideo;
      const label = video ? 'Video call' : 'Voice call';
      const icon  = video ? '📹' : '📞';
      let text;
      switch (status) {
        case 'ended':     text = label + (secs > 0 ? ' · ' + fmt(secs) : ' ended'); break;
        case 'missed':
        case 'cancelled':
        case 'busy':      text = 'Missed ' + label.toLowerCase(); break;
        case 'declined':  text = label + ' declined'; break;
        default:          text = label + ' ended';
      }
      const chatRef = db().collection('chats').doc(c.chatId);
      await chatRef.collection('messages').add({
        senderId: myUid, text: icon + ' ' + text, type: 'call',
        callType: video ? 'video' : 'audio', callStatus: status === 'failed' ? 'ended' : status, duration: secs || 0,
        createdAt: FV().serverTimestamp(), read: false,
      });
      const upd = { lastMessage: icon + ' ' + text, updatedAt: FV().serverTimestamp() };
      if (status === 'missed' || status === 'cancelled' || status === 'busy') upd['unread.' + c.peer.uid] = FV().increment(1);
      await chatRef.update(upd);
    } catch (e) { console.warn('Could not write call log:', e && e.code); }
  }

  // ═══════════════════════════════════════════════
  // IN-CALL CONTROLS
  // ═══════════════════════════════════════════════
  function pushMedia(c) {
    if (!c || !c.ref || !c.docReady) return;
    c.ref.update({ ['media.' + myUid]: { cam: !!(c.hasVideo && (c.camOn || c.sharing)), mic: c.micOn } }).catch(() => {});
  }

  function toggleMic() {
    const c = call; if (!c || !c.local) return;
    c.micOn = !c.micOn;
    c.local.getAudioTracks().forEach((t) => { t.enabled = c.micOn; });
    const b = $('gbhMicBtn'); if (b) { b.classList.toggle('on', !c.micOn); b.innerHTML = ic(c.micOn ? 'mic' : 'micoff'); }
    pushMedia(c);
  }

  function toggleCam() {
    const c = call; if (!c || !c.local || !c.hasVideo) return;
    c.camOn = !c.camOn;
    c.local.getVideoTracks().forEach((t) => { t.enabled = c.camOn; });
    const b = $('gbhCamBtn'); if (b) { b.classList.toggle('on', !c.camOn); b.innerHTML = ic(c.camOn ? 'video' : 'videooff'); }
    const lv = $('gbhLocal'); if (lv) lv.classList.toggle('off', !c.camOn && !c.sharing);
    pushMedia(c);
  }

  async function flipCamera() {
    const c = call; if (!c || !c.pc || !c.hasVideo || c.sharing) return;
    const sender = c.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender) return;
    const next = c.facing === 'user' ? 'environment' : 'user';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: next } } });
      const nt = s.getVideoTracks()[0], old = c.local.getVideoTracks()[0];
      nt.enabled = c.camOn;
      await sender.replaceTrack(nt);
      if (old) { c.local.removeTrack(old); old.stop(); }
      c.local.addTrack(nt);
      c.facing = next;
      const lv = $('gbhLocal'); if (lv) { lv.srcObject = c.local; lv.classList.toggle('nomirror', next !== 'user'); }
    } catch (e) { toast('Could not switch camera.', 'error'); }
  }

  async function toggleShare() {
    const c = call; if (!c || !c.pc) return;
    if (c.sharing) return stopShare(c);
    const sender = c.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (!sender || !navigator.mediaDevices.getDisplayMedia) return;
    try {
      const disp = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = disp.getVideoTracks()[0];
      c.screenStream = disp; c.sharing = true;
      await sender.replaceTrack(track);
      track.onended = () => stopShare(c);           // user clicked the browser's "Stop sharing"
      const lv = $('gbhLocal'); if (lv) { lv.srcObject = new MediaStream([track]); lv.classList.add('nomirror'); lv.classList.remove('off'); }
      const b = $('gbhShareBtn'); if (b) b.classList.add('on');
      pushMedia(c);
    } catch (e) {
      if (e && e.name !== 'NotAllowedError') toast('Could not share your screen.', 'error');
    }
  }
  async function stopShare(c) {
    if (!c || !c.sharing) return;
    c.sharing = false;
    const sender = c.pc && c.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    const cam = c.local && c.local.getVideoTracks()[0];
    try { if (sender && cam) await sender.replaceTrack(cam); } catch (_) {}
    stopStream(c.screenStream); c.screenStream = null;
    const lv = $('gbhLocal');
    if (lv) { lv.srcObject = c.local; lv.classList.toggle('nomirror', c.facing !== 'user'); lv.classList.toggle('off', !c.camOn); }
    const b = $('gbhShareBtn'); if (b) b.classList.remove('on');
    pushMedia(c);
  }

  // ═══════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════
  // Ask before a refresh / navigation drops a live call
  window.addEventListener('beforeunload', (e) => {
    if (call && call.connectedAt && !call.done) { e.preventDefault(); e.returnValue = ''; }
  });
  // Best-effort: tell the other side we're gone
  window.addEventListener('pagehide', () => {
    const c = call;
    if (c && c.ref && c.docReady && !c.done) {
      c.ref.update({ status: (c.role === 'caller' && !c.answered) ? 'cancelled' : 'ended', endedAt: Date.now() }).catch(() => {});
    }
  });

  function init(tries) {
    tries = tries || 0;
    if (typeof firebase === 'undefined' || !firebase.apps || !firebase.apps.length || !firebase.auth || !firebase.firestore) {
      if (tries < 20) setTimeout(() => init(tries + 1), 250);
      return;
    }
    firebase.auth().onAuthStateChanged((u) => {
      if (incomingUnsub) { incomingUnsub(); incomingUnsub = null; }
      if (!u) { myUid = null; if (call) abort(call); return; }
      myUid = u.uid;
      listenIncoming();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => init(0)); else init(0);

  window.GBHCall = { start, accept, decline, hangup, toggleMic, toggleCam, flipCamera, toggleShare, icon: ic, isBusy: () => !!call };
})();
