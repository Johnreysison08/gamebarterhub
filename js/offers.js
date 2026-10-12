// ═══════════════════════════════════════════════
// offers.js — Trade Offers (make / accept / decline /
// cancel / complete) — this is where an actual trade
// between two people is carried out, on top of the
// existing browse/like/comment/chat features.
//
// Firestore collection: tradeOffers/{id}
// {
//   tradeId, tradeTitle, tradeImg, tradeGame,
//   tradeOwnerId, tradeOwnerName, tradeOwnerAvatar, tradeOwnerEmail,
//   offererId, offererName, offererAvatar, offererEmail,
//   offerItem, message,
//   status: 'pending' | 'accepted' | 'declined' | 'cancelled' | 'completed',
//   completedBy: [uid, ...],
//   createdAt, updatedAt
// }
// ═══════════════════════════════════════════════

function _odb() { return firebase.firestore(); }

// Pending/countered offers auto-expire this many days after creation
// if the trade owner never responds.
const OFFER_EXPIRY_DAYS = 7;

// Trade images can be big base64 data URLs (screenshots, phone photos,
// etc). A tradeOffers doc only needs a thumbnail-sized preview of the
// trade — copying the full-size image in risks pushing the whole
// document past Firestore's 1 MiB per-document limit, which fails the
// entire offer write with "Document ... exceeds the maximum allowed
// size". Safer to just drop the image on the offer doc (the card falls
// back to an emoji/blank thumb) than to block the offer from sending.
const MAX_OFFER_IMG_BYTES = 200 * 1024; // ~200KB of base64 headroom
function _safeTradeImg(img) {
  if (!img || typeof img !== 'string') return null;
  if (img.startsWith('data:') && img.length > MAX_OFFER_IMG_BYTES) return null;
  return img;
}

function _toDate(v) {
  if (!v) return null;
  return v.toDate ? v.toDate() : new Date(v);
}

// Shared "an offer just got accepted" side-effects — used both by a
// direct accept and by accepting a counter-offer.
async function _finalizeAcceptedOffer(db, offerId, offer) {
  const ref = db.collection('tradeOffers').doc(offerId);
  await db.collection('trades').doc(offer.tradeId)
    .update({ status: 'pending', pendingOfferId: offerId }).catch(() => {});

  // Unlock contact info (phone/email) between these two traders now
  // that a deal is confirmed — see firestore.rules for how this is
  // verified server-side rather than just trusted from the client.
  const pairId = offer.offererId < offer.tradeOwnerId
    ? `${offer.offererId}_${offer.tradeOwnerId}`
    : `${offer.tradeOwnerId}_${offer.offererId}`;
  await db.collection('contactUnlocks').doc(pairId).set({
    offerId, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  // Auto-decline any other pending/countered offers on the same trade.
  // Firestore rules only let the trade owner touch other people's offer
  // docs, so this only runs when the owner is the one finalizing things
  // (a direct accept). When the *offerer* finalizes by accepting a
  // counter, siblings are left for the owner to clean up on their next
  // visit to offers.html instead of failing a permission check here.
  if (state.currentUser && state.currentUser.uid === offer.tradeOwnerId) {
    try {
      // NOTE: must filter on tradeOwnerId too — firestore.rules can only
      // grant read access to tradeOffers docs where tradeOwnerId (or
      // offererId) == request.auth.uid, and Firestore validates list
      // queries statically against their where() clauses. A query that
      // doesn't filter on either of those fields gets rejected outright
      // with "Missing or insufficient permissions", even though every
      // matching doc would in fact belong to this trade owner.
      const others = await db.collection('tradeOffers')
        .where('tradeId', '==', offer.tradeId)
        .where('tradeOwnerId', '==', state.currentUser.uid)
        .where('status', 'in', ['pending', 'countered'])
        .get();
      const batch = db.batch();
      others.docs.forEach(d => {
        if (d.id !== offerId) batch.update(d.ref, { status: 'declined', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      });
      await batch.commit().catch(() => {});

      for (const d of others.docs) {
        if (d.id === offerId) continue;
        await db.collection('notifications').add({
          userId: d.data().offererId, type: 'offer_declined',
          title:  'Your trade offer was declined',
          body:   offer.tradeTitle || '', is_read: false,
          related_trade_id: offer.tradeId, related_offer_id: d.id,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
    } catch (e) {
      // Never let this cleanup step break the accept/complete flow itself.
      console.error('Auto-decline sibling offers failed:', e);
    }
  }
}

// ── Auto-expire stale pending/countered offers ─
// Called right after loading a list of offers. Any pending/countered
// offer past its expiresAt gets flipped client-side — cheap and good
// enough for a personal-project scale app (no Cloud Functions needed).
async function _autoExpireOffers(offers) {
  const now = Date.now();
  const stale = offers.filter(o =>
    (o.status === 'pending' || o.status === 'countered') &&
    o.expiresAt && _toDate(o.expiresAt).getTime() < now);
  if (!stale.length) return offers;

  const db = _odb();
  const batch = db.batch();
  stale.forEach(o => {
    batch.update(db.collection('tradeOffers').doc(o.id), {
      status: 'expired', updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    o.status = 'expired'; // reflect immediately in the list we return
  });
  try { await batch.commit(); } catch (e) { console.error('auto-expire failed:', e); }

  stale.forEach(o => {
    db.collection('notifications').add({
      userId: o.offererId, type: 'offer_expired',
      title:  'Your trade offer expired',
      body:   o.tradeTitle || '', is_read: false,
      related_trade_id: o.tradeId, related_offer_id: o.id,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  });

  return offers;
}

// ── Create a trade offer ──────────────────────
async function makeOffer(tradeId, offerItem, message) {
  if (!state.currentUser) throw new Error('Not logged in');
  const db = _odb();
  const tradeSnap = await db.collection('trades').doc(tradeId).get();
  if (!tradeSnap.exists) throw new Error('Trade not found');
  const trade = tradeSnap.data();

  if (trade.userId === state.currentUser.uid) throw new Error("You can't send an offer on your own trade");
  if (trade.status && trade.status !== 'available') throw new Error('This trade is no longer available');

  const existing = await db.collection('tradeOffers')
    .where('tradeId', '==', tradeId)
    .where('offererId', '==', state.currentUser.uid)
    .where('status', 'in', ['pending', 'countered'])
    .get();
  if (!existing.empty) throw new Error('You already have an offer in progress on this trade');

  const ref = await db.collection('tradeOffers').add({
    tradeId,
    tradeTitle:     trade.title || '',
    tradeImg:       _safeTradeImg(trade.img),
    tradeGame:      trade.game || '',
    tradeOwnerId:   trade.userId,
    tradeOwnerName: trade.userName,
    tradeOwnerAvatar: trade.userAvatar || null,
    tradeOwnerEmail: trade.userEmail,
    offererId:      state.currentUser.uid,
    offererName:    state.currentUser.name,
    offererAvatar:  state.currentUser.avatar || null,
    offererEmail:   state.currentUser.email,
    offerItem:      offerItem || '',
    message:        message || '',
    status:         'pending',
    completedBy:    [],
    expiresAt:      new Date(Date.now() + OFFER_EXPIRY_DAYS * 86400000),
    createdAt:      firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt:      firebase.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('notifications').add({
    userId:    trade.userId,
    type:      'trade_offer',
    title:     state.currentUser.name + ' sent you a trade offer',
    body:      (offerItem || '').slice(0, 100),
    is_read:   false,
    related_trade_id: tradeId,
    related_offer_id: ref.id,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  return { ok: true, id: ref.id };
}

// ── Accept / decline an offer (trade owner only) ──
async function respondToOffer(offerId, accept) {
  if (!state.currentUser) throw new Error('Not logged in');
  const db  = _odb();
  const ref = db.collection('tradeOffers').doc(offerId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Offer not found');
  const offer = snap.data();

  if (offer.tradeOwnerId !== state.currentUser.uid) throw new Error('Not your trade');
  if (offer.status !== 'pending') throw new Error('This offer is no longer pending');

  if (accept) {
    await ref.update({ status: 'accepted', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await _finalizeAcceptedOffer(db, offerId, offer);

    await db.collection('notifications').add({
      userId: offer.offererId, type: 'offer_accepted',
      title:  state.currentUser.name + ' accepted your trade offer! 🎉',
      body:   offer.tradeTitle || '', is_read: false,
      related_trade_id: offer.tradeId, related_offer_id: offerId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    return { ok: true, status: 'accepted' };
  }

  await ref.update({ status: 'declined', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  await db.collection('notifications').add({
    userId: offer.offererId, type: 'offer_declined',
    title:  'Your trade offer was declined',
    body:   offer.tradeTitle || '', is_read: false,
    related_trade_id: offer.tradeId, related_offer_id: offerId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
  return { ok: true, status: 'declined' };
}

// ── Counter an offer (trade owner proposes different terms) ──
// Only one counter round-trip is supported: the owner counters once,
// then the original sender must accept or decline that counter (they
// can always just send a fresh offer afterwards if talks continue).
async function counterOffer(offerId, counterItem, counterMessage) {
  if (!state.currentUser) throw new Error('Not logged in');
  if (!counterItem || !counterItem.trim()) throw new Error('Describe what you want instead');
  const db = _odb();
  const ref = db.collection('tradeOffers').doc(offerId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Offer not found');
  const offer = snap.data();

  if (offer.tradeOwnerId !== state.currentUser.uid) throw new Error('Not your trade');
  if (offer.status !== 'pending') throw new Error('This offer is no longer pending');

  await ref.update({
    status: 'countered',
    counterOfferItem: counterItem.trim(),
    counterMessage: (counterMessage || '').trim(),
    counterBy: state.currentUser.uid,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('notifications').add({
    userId: offer.offererId, type: 'offer_countered',
    title:  state.currentUser.name + ' sent a counter-offer',
    body:   counterItem.trim().slice(0, 100), is_read: false,
    related_trade_id: offer.tradeId, related_offer_id: offerId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  return { ok: true };
}

// ── Respond to a counter-offer (original sender only) ──
async function respondToCounter(offerId, accept) {
  if (!state.currentUser) throw new Error('Not logged in');
  const db  = _odb();
  const ref = db.collection('tradeOffers').doc(offerId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Offer not found');
  const offer = snap.data();

  if (offer.offererId !== state.currentUser.uid) throw new Error('Only the original sender can respond to this counter');
  if (offer.status !== 'countered') throw new Error('This counter-offer is no longer active');

  if (accept) {
    await ref.update({
      status: 'accepted',
      offerItem: offer.counterOfferItem || offer.offerItem,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await _finalizeAcceptedOffer(db, offerId, { ...offer, offerItem: offer.counterOfferItem || offer.offerItem });

    await db.collection('notifications').add({
      userId: offer.tradeOwnerId, type: 'offer_accepted',
      title:  state.currentUser.name + ' accepted your counter-offer! 🎉',
      body:   offer.tradeTitle || '', is_read: false,
      related_trade_id: offer.tradeId, related_offer_id: offerId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    return { ok: true, status: 'accepted' };
  }

  await ref.update({ status: 'declined', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  await db.collection('notifications').add({
    userId: offer.tradeOwnerId, type: 'offer_declined',
    title:  state.currentUser.name + ' declined your counter-offer',
    body:   offer.tradeTitle || '', is_read: false,
    related_trade_id: offer.tradeId, related_offer_id: offerId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});
  return { ok: true, status: 'declined' };
}

// ── Cancel an offer (offerer cancels pending / either side backs out of an accepted trade) ──
async function cancelOffer(offerId) {
  if (!state.currentUser) throw new Error('Not logged in');
  const db  = _odb();
  const ref = db.collection('tradeOffers').doc(offerId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Offer not found');
  const offer = snap.data();
  const uid = state.currentUser.uid;

  const isOfferer = uid === offer.offererId;
  const isOwner   = uid === offer.tradeOwnerId;
  if (!isOfferer && !isOwner) throw new Error('Not part of this trade');
  if (!['pending', 'countered', 'accepted'].includes(offer.status)) throw new Error('This offer can no longer be cancelled');
  if (offer.status === 'pending' && !isOfferer) throw new Error('Only the sender can cancel a pending offer');

  await ref.update({ status: 'cancelled', updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

  if (offer.status === 'accepted') {
    // Re-open the listing (only touches the 'status' field, which any
    // signed-in user is allowed to update per firestore.rules)
    await db.collection('trades').doc(offer.tradeId).update({ status: 'available' }).catch(() => {});
  }

  const otherUid = isOfferer ? offer.tradeOwnerId : offer.offererId;
  await db.collection('notifications').add({
    userId: otherUid, type: 'offer_cancelled',
    title:  state.currentUser.name + ' cancelled the trade',
    body:   offer.tradeTitle || '', is_read: false,
    related_trade_id: offer.tradeId, related_offer_id: offerId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  return { ok: true };
}

// ── Mark trade complete (both sides must confirm) ──
async function markTradeComplete(offerId) {
  if (!state.currentUser) throw new Error('Not logged in');
  const db  = _odb();
  const ref = db.collection('tradeOffers').doc(offerId);
  const snap = await ref.get();
  if (!snap.exists) throw new Error('Offer not found');
  const offer = snap.data();
  const uid = state.currentUser.uid;

  if (uid !== offer.tradeOwnerId && uid !== offer.offererId) throw new Error('Not part of this trade');
  if (offer.status !== 'accepted') throw new Error('This trade is not active');

  const completedBy = offer.completedBy || [];
  if (completedBy.includes(uid)) throw new Error("You've already confirmed this trade");

  const updated = [...completedBy, uid];
  const otherUid = uid === offer.tradeOwnerId ? offer.offererId : offer.tradeOwnerId;
  const bothDone = updated.includes(offer.tradeOwnerId) && updated.includes(offer.offererId);

  await ref.update({
    completedBy: updated,
    status:      bothDone ? 'completed' : 'accepted',
    updatedAt:   firebase.firestore.FieldValue.serverTimestamp(),
  });

  if (bothDone) {
    await db.collection('trades').doc(offer.tradeId).update({ status: 'sold' }).catch(() => {});
    await db.collection('notifications').add({
      userId: otherUid, type: 'trade_completed',
      title:  '🎉 Trade completed with ' + state.currentUser.name + '!',
      body:   offer.tradeTitle || '', is_read: false,
      related_trade_id: offer.tradeId, related_offer_id: offerId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  } else {
    await db.collection('notifications').add({
      userId: otherUid, type: 'trade_complete_pending',
      title:  state.currentUser.name + ' marked your trade as completed',
      body:   'Confirm on your end to finish it.', is_read: false,
      related_trade_id: offer.tradeId, related_offer_id: offerId,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  return { ok: true, bothDone };
}

// ── Loaders ────────────────────────────────────
async function loadOffersReceived() {
  if (!state.currentUser) return [];
  const snap = await _odb().collection('tradeOffers')
    .where('tradeOwnerId', '==', state.currentUser.uid)
    .orderBy('createdAt', 'desc')
    .get();
  const offers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _autoExpireOffers(offers);
}

async function loadOffersSent() {
  if (!state.currentUser) return [];
  const snap = await _odb().collection('tradeOffers')
    .where('offererId', '==', state.currentUser.uid)
    .orderBy('createdAt', 'desc')
    .get();
  const offers = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  return _autoExpireOffers(offers);
}

// ── Ratings (left after a trade is completed) ─
// Doc id is deterministic ("<offerId>_<raterUid>") so Firestore rules
// can enforce "one rating per person per completed trade" for free.
async function hasRatedOffer(offerId) {
  if (!state.currentUser) return false;
  const id = `${offerId}_${state.currentUser.uid}`;
  const snap = await _odb().collection('tradeRatings').doc(id).get();
  return snap.exists;
}

async function submitTradeRating(offerId, stars, comment) {
  if (!state.currentUser) throw new Error('Not logged in');
  stars = Math.round(Number(stars));
  if (!(stars >= 1 && stars <= 5)) throw new Error('Pick a rating from 1 to 5 stars');

  const db  = _odb();
  const uid = state.currentUser.uid;
  const snap = await db.collection('tradeOffers').doc(offerId).get();
  if (!snap.exists) throw new Error('Offer not found');
  const offer = snap.data();
  if (offer.status !== 'completed') throw new Error('You can only rate a completed trade');
  if (uid !== offer.offererId && uid !== offer.tradeOwnerId) throw new Error('Not part of this trade');

  const ratedUid  = uid === offer.offererId ? offer.tradeOwnerId : offer.offererId;
  const ratedName = uid === offer.offererId ? offer.tradeOwnerName : offer.offererName;
  const id = `${offerId}_${uid}`;

  await db.collection('tradeRatings').doc(id).set({
    offerId, tradeId: offer.tradeId,
    raterUid: uid, raterName: state.currentUser.name,
    ratedUid, ratedName,
    stars, comment: (comment || '').slice(0, 300),
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  });

  await db.collection('notifications').add({
    userId: ratedUid, type: 'trade_rated',
    title:  state.currentUser.name + ` rated your trade ${stars}★`,
    body:   (comment || '').slice(0, 100), is_read: false,
    related_trade_id: offer.tradeId, related_offer_id: offerId,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  return { ok: true };
}

// Average rating + count for a user — used on profile pages.
async function getUserRatingSummary(uid) {
  const snap = await _odb().collection('tradeRatings').where('ratedUid', '==', uid).get();
  if (snap.empty) return { avg: 0, count: 0 };
  let sum = 0;
  snap.docs.forEach(d => sum += (d.data().stars || 0));
  return { avg: sum / snap.size, count: snap.size };
}

async function getMyOfferForTrade(tradeId) {
  if (!state.currentUser) return null;
  const snap = await _odb().collection('tradeOffers')
    .where('tradeId', '==', tradeId)
    .where('offererId', '==', state.currentUser.uid)
    .orderBy('createdAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function countPendingOffersForTrade(tradeId) {
  if (!state.currentUser) return 0;
  const snap = await _odb().collection('tradeOffers')
    .where('tradeId', '==', tradeId)
    .where('status', '==', 'pending')
    .get();
  return snap.size;
}

// ── Live badge (unread pending offers received) ──
let _offerBadgeUnsub = null;

function startOfferBadgeListener() {
  if (!state.currentUser) return;
  if (_offerBadgeUnsub) _offerBadgeUnsub();
  _offerBadgeUnsub = _odb().collection('tradeOffers')
    .where('tradeOwnerId', '==', state.currentUser.uid)
    .where('status', '==', 'pending')
    .onSnapshot(snap => {
      const count = snap.size;
      const el = document.getElementById('offersNavBadge');
      if (el) {
        if (count > 0) { el.textContent = count > 9 ? '9+' : String(count); el.style.display = 'inline-block'; }
        else el.style.display = 'none';
      }
      const bn = document.getElementById('bnMyBadge');
      if (bn) { bn.textContent = count > 9 ? '9+' : String(count); bn.style.display = count > 0 ? 'flex' : 'none'; }
      const mEl = document.getElementById('mobileOffersBadge');
      if (mEl) {
        if (count > 0) { mEl.textContent = count > 9 ? '9+' : String(count); mEl.style.display = 'inline'; }
        else mEl.style.display = 'none';
      }
    }, () => {});
}

function stopOfferBadgeListener() {
  if (_offerBadgeUnsub) { _offerBadgeUnsub(); _offerBadgeUnsub = null; }
}

// ── Offer status badge (small pill) ───────────
function offerStatusBadge(o) {
  const map = {
    pending:   { label: '⏳ Pending',              bg: 'rgba(255,193,7,0.15)',  color: '#ffc107',            border: 'rgba(255,193,7,0.35)' },
    countered: { label: '🔄 Countered',             bg: 'rgba(168,85,247,0.14)', color: '#a855f7',            border: 'rgba(168,85,247,0.35)' },
    accepted:  { label: '✅ Accepted — In Progress', bg: 'rgba(91,108,255,0.12)',  color: 'var(--accent-cyan)', border: 'rgba(91,108,255,0.3)' },
    declined:  { label: '❌ Declined',              bg: 'rgba(220,38,38,0.12)',  color: '#ef4444',            border: 'rgba(220,38,38,0.3)' },
    cancelled: { label: '🚫 Cancelled',             bg: 'rgba(74,85,104,0.2)',   color: 'var(--text-muted)',  border: 'var(--border)' },
    expired:   { label: '⌛ Expired',               bg: 'rgba(74,85,104,0.2)',   color: 'var(--text-muted)',  border: 'var(--border)' },
    completed: { label: '🎉 Completed',             bg: 'rgba(0,255,136,0.12)',  color: 'var(--accent-green)',border: 'rgba(0,255,136,0.3)' },
  };
  const s = map[o.status] || map.pending;
  return `<span style="display:inline-block;background:${s.bg};color:${s.color};border:1px solid ${s.border};padding:3px 10px;border-radius:20px;font-size:0.68rem;font-weight:700;white-space:nowrap">${s.label}</span>`;
}

function _expiryLabel(o) {
  if (!(o.status === 'pending' || o.status === 'countered') || !o.expiresAt) return '';
  const ms = _toDate(o.expiresAt).getTime() - Date.now();
  if (ms <= 0) return '';
  const hours = Math.round(ms / 3600000);
  const label = hours < 24 ? `${hours}h left` : `${Math.ceil(hours / 24)}d left`;
  return `<span style="font-size:0.68rem;color:var(--text-muted);margin-left:8px">⏱️ ${label}</span>`;
}

function _tradeThumb(o) {
  if (!o.tradeImg) return '';
  const isImg = o.tradeImg.startsWith('data:') || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(o.tradeImg);
  return `<div style="width:44px;height:44px;flex-shrink:0;border-radius:8px;overflow:hidden;background:var(--bg-card2);display:flex;align-items:center;justify-content:center">
    ${isImg ? `<img src="${o.tradeImg}" style="width:100%;height:100%;object-fit:cover" alt="">` : `<span style="font-size:1.5rem">${o.tradeImg}</span>`}
  </div>`;
}

function _offerTime(o) {
  try {
    return o.createdAt && o.createdAt.toDate ? o.createdAt.toDate().toISOString() : new Date().toISOString();
  } catch (e) { return new Date().toISOString(); }
}

// ── Offer card (used on offers.html) ──────────
function offerCardHTML(o, viewAs) {
  const otherName   = viewAs === 'received' ? o.offererName   : o.tradeOwnerName;
  const otherAvatar = viewAs === 'received' ? o.offererAvatar : o.tradeOwnerAvatar;
  const otherUid    = viewAs === 'received' ? o.offererId     : o.tradeOwnerId;
  const uid = state.currentUser ? state.currentUser.uid : null;
  const iConfirmed  = (o.completedBy || []).includes(uid);
  const waitingOnOther = o.status === 'accepted' && iConfirmed;

  let actions = '';
  if (viewAs === 'received' && o.status === 'pending') {
    actions += `
      <button class="btn btn-primary" style="flex:1;padding:8px;font-size:0.78rem" onclick="handleRespondOffer('${o.id}',true,this)">✅ Accept</button>
      <button class="btn btn-ghost" style="flex:1;padding:8px;font-size:0.78rem" onclick="toggleCounterForm('${o.id}')">🔄 Counter</button>
      <button class="btn btn-ghost" style="flex:1;padding:8px;font-size:0.78rem;color:#ff5555" onclick="handleRespondOffer('${o.id}',false,this)">❌ Decline</button>`;
  } else if (viewAs === 'sent' && o.status === 'pending') {
    actions += `<button class="btn btn-ghost" style="flex:1;padding:8px;font-size:0.78rem;color:#ff5555" onclick="handleCancelOffer('${o.id}',this)">🚫 Cancel Offer</button>`;
  } else if (viewAs === 'received' && o.status === 'countered') {
    actions += `<div style="flex:1;font-size:0.78rem;color:var(--text-muted);padding:8px 0">⏳ Waiting for them to respond to your counter</div>
      <button class="btn btn-ghost" style="padding:8px;font-size:0.78rem;color:#ff5555" onclick="handleCancelOffer('${o.id}',this)">🚫 Withdraw</button>`;
  } else if (viewAs === 'sent' && o.status === 'countered') {
    actions += `
      <button class="btn btn-primary" style="flex:1;padding:8px;font-size:0.78rem" onclick="handleRespondCounter('${o.id}',true,this)">✅ Accept Counter</button>
      <button class="btn btn-ghost" style="flex:1;padding:8px;font-size:0.78rem;color:#ff5555" onclick="handleRespondCounter('${o.id}',false,this)">❌ Decline</button>`;
  }

  if (o.status === 'accepted') {
    actions += `
      <button class="btn btn-primary" style="flex:1;padding:8px;font-size:0.78rem" ${waitingOnOther ? 'disabled' : ''} onclick="handleCompleteTrade('${o.id}',this)">
        ${waitingOnOther ? '⏳ Waiting for confirmation' : '🎉 Mark as Completed'}
      </button>
      <button class="btn btn-ghost" style="flex:1;padding:8px;font-size:0.78rem;color:#ff5555" onclick="handleCancelOffer('${o.id}',this)">🚫 Cancel Trade</button>`;
  }

  if (o.status === 'completed') {
    actions += `<div class="rating-slot" id="ratingSlot-${o.id}" style="flex:1;font-size:0.78rem;color:var(--text-muted)">Checking rating…</div>`;
  }

  const messageBtn = (otherUid && !['declined', 'cancelled', 'expired'].includes(o.status))
    ? `<button class="btn btn-ghost" id="chatBtn-${o.id}" style="flex:1;padding:8px;font-size:0.78rem" onclick="toggleInlineChat('${o.id}','${otherUid}','${escapeHtml(otherName || '')}',${otherAvatar ? `'${otherAvatar}'` : 'null'})">💬 Message</button>`
    : '';

  // Counter-offer terms shown on the recipient's side once countered
  const counterInfo = (o.status === 'countered' && o.counterOfferItem)
    ? `<div style="background:rgba(168,85,247,0.08);border:1px solid rgba(168,85,247,0.25);border-radius:var(--radius);padding:10px 12px;margin-bottom:12px">
        <div style="font-size:0.72rem;color:#a855f7;font-weight:700;margin-bottom:2px">🔄 Counter-offer${viewAs === 'sent' ? ' — they want' : ' (you sent)'}:</div>
        <div style="font-size:0.82rem;color:var(--text-secondary)">${escapeHtml(o.counterOfferItem)}</div>
        ${o.counterMessage ? `<div style="font-size:0.78rem;color:var(--text-muted);font-style:italic;margin-top:4px">"${escapeHtml(o.counterMessage)}"</div>` : ''}
      </div>`
    : '';

  // Inline counter-offer form (owner viewing a pending offer)
  const counterForm = (viewAs === 'received' && o.status === 'pending') ? `
    <div id="counterForm-${o.id}" style="display:none;background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-top:10px">
      <div style="font-size:0.78rem;font-weight:700;margin-bottom:8px">🔄 Propose different terms</div>
      <textarea class="form-input" id="counterItemInput-${o.id}" placeholder="What would you rather receive?" style="min-height:50px;margin-bottom:6px;font-size:0.8rem"></textarea>
      <textarea class="form-input" id="counterMsgInput-${o.id}" placeholder="Add a message (optional)" style="min-height:38px;margin-bottom:8px;font-size:0.8rem"></textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" style="flex:1;padding:7px;font-size:0.76rem" onclick="toggleCounterForm('${o.id}')">Cancel</button>
        <button class="btn btn-primary" style="flex:2;padding:7px;font-size:0.76rem" onclick="submitCounterOffer('${o.id}',this)">Send Counter</button>
      </div>
    </div>` : '';

  // Inline chat panel — lets both sides discuss the trade right here,
  // without leaving the offer card. Hidden until "💬 Message" is tapped.
  const chatPanel = (otherUid && o.status !== 'declined' && o.status !== 'cancelled')
    ? `<div class="offer-chat-panel" id="chatPanel-${o.id}" data-open="0" style="display:none;margin-top:10px;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg-card2);overflow:hidden">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid var(--border);background:var(--bg-card)">
          <span style="font-size:0.78rem;font-weight:700;color:var(--text-secondary)">💬 Chat about this trade</span>
          <a href="javascript:void(0)" onclick="openChatWith('${otherUid}','${escapeHtml(otherName || '')}',${otherAvatar ? `'${otherAvatar}'` : 'null'})" style="font-size:0.72rem;color:var(--accent-cyan);text-decoration:none">Open full chat ↗</a>
        </div>
        <div id="chatMsgs-${o.id}" style="max-height:260px;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px">
          <p style="color:var(--text-muted);font-size:0.8rem;text-align:center">Loading…</p>
        </div>
        <div style="display:flex;gap:8px;padding:10px;border-top:1px solid var(--border)">
          <textarea id="chatInput-${o.id}" class="form-input" placeholder="Message about this trade…" style="min-height:38px;max-height:90px;flex:1;resize:none" onkeydown="_inlineChatKey(event,'${o.id}','${otherUid}')"></textarea>
          <button class="btn btn-primary" style="padding:0 16px;font-size:0.8rem" onclick="sendInlineChatMessage('${o.id}','${otherUid}')">Send</button>
        </div>
      </div>`
    : '';

  return `
  <div class="offer-card" data-offer-id="${o.id}" data-offer-status="${o.status}" style="background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px;margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px;flex-wrap:wrap">
      <div style="display:flex;align-items:center;gap:10px;cursor:pointer" onclick="openTradeModal('${o.tradeId}')">
        <div class="mini-avatar" style="width:34px;height:34px;font-size:0.85rem">${getAvatarEl(otherName, otherAvatar)}</div>
        <div>
          <div style="font-size:0.85rem;font-weight:600">${escapeHtml(otherName || 'Unknown')}</div>
          <div style="font-size:0.72rem;color:var(--text-muted)">${formatTime(_offerTime(o))}${_expiryLabel(o)}</div>
        </div>
      </div>
      ${offerStatusBadge(o)}
    </div>
    <div style="display:flex;align-items:center;gap:10px;background:var(--bg-card2);border-radius:var(--radius);padding:10px 12px;margin-bottom:10px;cursor:pointer" onclick="openTradeModal('${o.tradeId}')">
      ${_tradeThumb(o)}
      <div style="min-width:0">
        <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:2px">Trade:</div>
        <div style="font-size:0.85rem;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.tradeTitle || 'Untitled trade')}</div>
      </div>
    </div>
    <div style="margin-bottom:${o.message ? '6px' : '12px'}">
      <div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:2px">${viewAs === 'received' ? 'They offered:' : 'You offered:'}</div>
      <div style="font-size:0.82rem;color:var(--text-secondary)">${escapeHtml(o.offerItem || '')}</div>
    </div>
    ${o.message ? `<div style="margin-bottom:12px"><div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:2px">Message:</div><div style="font-size:0.8rem;color:var(--text-secondary);font-style:italic">"${escapeHtml(o.message)}"</div></div>` : ''}
    ${counterInfo}
    <div style="display:flex;gap:8px;flex-wrap:wrap">${actions}${messageBtn}</div>
    ${counterForm}
    ${chatPanel}
  </div>`;
}

// ── Inline chat (message about this specific trade offer) ──
// Reuses the same /chats/{chatId}/messages Firestore structure as the
// full messages.html page, so anything sent here also shows up there —
// but users never have to leave the offer card to say a quick word.
let _inlineChatState = {}; // offerId -> { chatId, otherUid, unsub }

function _myUidOffers() {
  const u = state && state.currentUser;
  return (u && (u.uid || u.id)) || null;
}

function _closeInlineChat(offerId) {
  const st = _inlineChatState[offerId];
  if (st && st.unsub) st.unsub();
  delete _inlineChatState[offerId];
}

function closeAllInlineChats() {
  Object.keys(_inlineChatState).forEach(_closeInlineChat);
}

async function toggleInlineChat(offerId, otherUid, otherName, otherAvatar) {
  const panel = document.getElementById('chatPanel-' + offerId);
  const btn   = document.getElementById('chatBtn-' + offerId);
  if (!panel) return;

  if (panel.dataset.open === '1') {
    _closeInlineChat(offerId);
    panel.style.display = 'none';
    panel.dataset.open  = '0';
    if (btn) btn.innerHTML = '💬 Message';
    return;
  }

  if (!state.currentUser) { showToast('Please sign in first.', 'error'); return; }

  panel.style.display = 'block';
  panel.dataset.open  = '1';
  if (btn) btn.innerHTML = '✕ Close Chat';

  const msgsEl = document.getElementById('chatMsgs-' + offerId);
  if (msgsEl) msgsEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center">Loading…</p>';

  const uid     = _myUidOffers();
  const chatId  = buildChatId(uid, otherUid);
  const myName  = state.currentUser.name || state.currentUser.displayName || 'Unknown';
  const myAvatar = state.currentUser.avatar || state.currentUser.photoURL || null;

  // Ensure the chat doc exists before writing/reading messages (mirrors openChatWith).
  try {
    await _odb().collection('chats').doc(chatId).set({
      participants: [uid, otherUid],
      participantNames:   { [uid]: myName,  [otherUid]: otherName || 'Unknown' },
      participantAvatars: { [uid]: myAvatar, [otherUid]: otherAvatar || null },
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      unread: { [uid]: 0 },
    }, { merge: true });
  } catch (e) {
    console.error('toggleInlineChat init error:', e);
    if (msgsEl) msgsEl.innerHTML = `<p style="color:#ef4444;font-size:0.8rem;text-align:center">Could not open chat.<br><span style="color:var(--text-muted);font-size:0.7rem">${escapeHtml((e && e.code) || '')} ${escapeHtml((e && e.message) || '')}</span></p>`;
    return;
  }

  _startInlineChatListener(offerId, chatId);
}

function _startInlineChatListener(offerId, chatId) {
  _closeInlineChat(offerId);
  const uid = _myUidOffers();
  const unsub = _odb().collection('chats').doc(chatId).collection('messages')
    .orderBy('createdAt', 'desc')
    .limit(50)
    .onSnapshot(snap => {
      const msgs = snap.docs.map(d => ({ id: d.id, ...d.data() })).reverse();
      _renderInlineMessages(offerId, msgs);
      if (uid) _odb().collection('chats').doc(chatId).set({ unread: { [uid]: 0 } }, { merge: true }).catch(() => {});
    }, err => {
      console.error('inline chat listener error:', err);
      const el = document.getElementById('chatMsgs-' + offerId);
      if (el) el.innerHTML = `<p style="color:#ef4444;font-size:0.8rem;text-align:center">Could not load messages.<br><span style="color:var(--text-muted);font-size:0.7rem">${escapeHtml((err && err.code) || '')} ${escapeHtml((err && err.message) || '')}</span></p>`;
    });
  _inlineChatState[offerId] = { chatId, unsub };
}

function _renderInlineMessages(offerId, msgs) {
  const el = document.getElementById('chatMsgs-' + offerId);
  if (!el) return;
  const uid = _myUidOffers();

  if (!msgs.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;text-align:center">No messages yet. Say hello 👋</p>';
    return;
  }

  el.innerHTML = msgs.map(m => {
    const mine = m.senderId === uid;
    const t = m.createdAt && m.createdAt.toDate ? formatTime(m.createdAt.toDate().toISOString()) : '';
    return `<div style="display:flex;${mine ? 'justify-content:flex-end' : 'justify-content:flex-start'}">
      <div style="max-width:75%">
        <div style="padding:8px 12px;border-radius:${mine ? '14px 14px 2px 14px' : '14px 14px 14px 2px'};font-size:0.82rem;line-height:1.4;word-wrap:break-word;${mine ? 'background:rgba(91,108,255,0.15);border:1px solid rgba(91,108,255,0.3)' : 'background:var(--bg-card);border:1px solid var(--border)'}">${escapeHtml(m.text)}</div>
        <div style="font-size:0.65rem;color:var(--text-muted);margin-top:2px;text-align:${mine ? 'right' : 'left'}">${t}</div>
      </div>
    </div>`;
  }).join('');
  el.scrollTop = el.scrollHeight;
}

async function sendInlineChatMessage(offerId, otherUid) {
  const inputEl = document.getElementById('chatInput-' + offerId);
  const text    = inputEl && inputEl.value.trim();
  if (!text) return;

  const st = _inlineChatState[offerId];
  if (!st) return;

  const uid = _myUidOffers();
  if (!uid) { showToast('Please sign in first.', 'error'); return; }

  inputEl.value = '';
  inputEl.style.height = 'auto';

  const now     = firebase.firestore.FieldValue.serverTimestamp();
  const db      = _odb();
  const chatRef = db.collection('chats').doc(st.chatId);
  const msgRef  = chatRef.collection('messages').doc();

  try {
    await chatRef.set({
      lastMessage: text.length > 60 ? text.slice(0, 57) + '…' : text,
      updatedAt:   now,
    }, { merge: true });
    await msgRef.set({ senderId: uid, text, createdAt: now, read: false });
    await chatRef.update({ ['unread.' + otherUid]: firebase.firestore.FieldValue.increment(1) });
  } catch (e) {
    console.error('sendInlineChatMessage error:', e);
    showToast(((e && e.code) ? e.code + ': ' : '') + (e && e.message || 'Failed to send message.'), 'error');
    inputEl.value = text;
  }
}

function _inlineChatKey(e, offerId, otherUid) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendInlineChatMessage(offerId, otherUid);
  }
}

// ── Handlers (shared by offers.html and the trade modal) ──
async function handleRespondOffer(offerId, accept, btnEl) {
  const card = btnEl && btnEl.closest('.offer-card');
  if (card) {
    // Already processing this exact card — ignore the extra tap/click.
    if (card.dataset.busy === '1') return;
    card.dataset.busy = '1';
    card.style.opacity = '0.5';
    card.querySelectorAll('button').forEach(b => b.disabled = true);
  }
  try {
    await respondToOffer(offerId, accept);
    showToast(accept ? 'Offer accepted! 🎉' : 'Offer declined.', 'success');
    if (typeof loadOffersPage === 'function') await loadOffersPage();
  } catch (e) {
    showToast(e.message || 'Something went wrong.', 'error');
    if (/no longer pending/i.test(e.message || '') && typeof loadOffersPage === 'function') {
      // The card's state is stale (already resolved elsewhere) — refresh instead of leaving a stuck button.
      await loadOffersPage();
      return;
    }
    if (card) {
      card.style.opacity = '1';
      card.dataset.busy = '0';
      card.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  }
}

function toggleCounterForm(offerId) {
  const form = document.getElementById('counterForm-' + offerId);
  if (!form) return;
  form.style.display = form.style.display === 'none' || !form.style.display ? 'block' : 'none';
}

async function submitCounterOffer(offerId, btnEl) {
  const itemEl = document.getElementById('counterItemInput-' + offerId);
  const msgEl  = document.getElementById('counterMsgInput-' + offerId);
  const item = itemEl ? itemEl.value.trim() : '';
  if (!item) { showToast('Describe what you want instead', 'error'); return; }
  if (btnEl) btnEl.disabled = true;
  try {
    await counterOffer(offerId, item, msgEl ? msgEl.value.trim() : '');
    showToast('Counter-offer sent!', 'success');
    if (typeof loadOffersPage === 'function') await loadOffersPage();
  } catch (e) {
    showToast(e.message || 'Could not send counter-offer.', 'error');
    if (btnEl) btnEl.disabled = false;
  }
}

async function handleRespondCounter(offerId, accept, btnEl) {
  const card = btnEl && btnEl.closest('.offer-card');
  if (card) {
    if (card.dataset.busy === '1') return;
    card.dataset.busy = '1';
    card.querySelectorAll('button').forEach(b => b.disabled = true);
  }
  try {
    await respondToCounter(offerId, accept);
    showToast(accept ? 'Counter-offer accepted! 🎉' : 'Counter-offer declined.', 'success');
    if (typeof loadOffersPage === 'function') await loadOffersPage();
  } catch (e) {
    showToast(e.message || 'Something went wrong.', 'error');
    if (card) { card.style.opacity = '1'; card.dataset.busy = '0'; card.querySelectorAll('button').forEach(b => b.disabled = false); }
  }
}

async function handleCancelOffer(offerId, btnEl) {
  if (!confirm('Are you sure? This cannot be undone.')) return;
  const card = btnEl && btnEl.closest('.offer-card');
  if (card) {
    if (card.dataset.busy === '1') return;
    card.dataset.busy = '1';
    card.querySelectorAll('button').forEach(b => b.disabled = true);
  }
  try {
    await cancelOffer(offerId);
    showToast('Cancelled.', 'success');
    if (typeof loadOffersPage === 'function') await loadOffersPage();
  } catch (e) {
    showToast(e.message || 'Could not cancel.', 'error');
    if (card) { card.dataset.busy = '0'; card.querySelectorAll('button').forEach(b => b.disabled = false); }
  }
}

async function handleCompleteTrade(offerId, btnEl) {
  const card = btnEl && btnEl.closest('.offer-card');
  if (card) {
    if (card.dataset.busy === '1') return;
    card.dataset.busy = '1';
    card.querySelectorAll('button').forEach(b => b.disabled = true);
  }
  try {
    const res = await markTradeComplete(offerId);
    showToast(res.bothDone ? '🎉 Trade completed!' : 'Marked as completed. Waiting for the other trader to confirm.', 'success');
    if (typeof loadOffersPage === 'function') await loadOffersPage();
  } catch (e) {
    showToast(e.message || 'Could not update.', 'error');
    if (card) { card.dataset.busy = '0'; card.querySelectorAll('button').forEach(b => b.disabled = false); }
  }
}

// ── Inline "Make an Offer" form inside the trade modal ──
async function toggleOfferForm(tradeId) {
  const el = document.getElementById('offerFormArea');
  if (!el) return;
  if (el.dataset.open === '1') { el.innerHTML = ''; el.dataset.open = '0'; return; }
  el.dataset.open = '1';
  el.innerHTML = `<p style="font-size:0.8rem;color:var(--text-muted);margin-top:10px">Loading…</p>`;

  if (!state.currentUser) {
    el.innerHTML = `<p style="font-size:0.82rem;color:var(--text-muted);margin-top:10px"><a href="login.html" style="color:var(--accent-cyan)">Sign in</a> to make a trade offer.</p>`;
    return;
  }

  let mine = null;
  try { mine = await getMyOfferForTrade(tradeId); } catch (e) {}

  if (mine && (mine.status === 'pending' || mine.status === 'accepted')) {
    el.innerHTML = `
      <div style="background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-top:10px">
        <div style="font-size:0.82rem;font-weight:700;margin-bottom:6px">${mine.status === 'accepted' ? '✅ Your offer was accepted!' : '⏳ Your offer is pending'}</div>
        <div style="font-size:0.8rem;color:var(--text-secondary);margin-bottom:12px">You offered: ${escapeHtml(mine.offerItem)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost" style="flex:1;font-size:0.78rem;padding:8px" onclick="window.location.href='offers.html'">View in My Offers</button>
          ${mine.status === 'pending' ? `<button class="btn btn-ghost" style="flex:1;font-size:0.78rem;padding:8px;color:#ff5555" onclick="cancelOfferFromModal('${mine.id}')">Cancel Offer</button>` : ''}
        </div>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div style="background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);padding:14px;margin-top:10px">
      <div style="font-size:0.85rem;font-weight:700;margin-bottom:10px">🤝 Make a Trade Offer</div>
      <textarea class="form-input" id="offerItemInput" placeholder="What are you offering in exchange? e.g. Mobile Legends account, 500 diamonds..." style="min-height:60px;margin-bottom:8px"></textarea>
      <textarea class="form-input" id="offerMsgInput" placeholder="Add a message (optional)" style="min-height:44px;margin-bottom:10px"></textarea>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost" style="flex:1;padding:9px;font-size:0.8rem" onclick="toggleOfferForm('${tradeId}')">Cancel</button>
        <button class="btn btn-primary" style="flex:2;padding:9px;font-size:0.8rem" onclick="submitOfferFromModal('${tradeId}')">Send Offer</button>
      </div>
    </div>`;
}

async function submitOfferFromModal(tradeId) {
  const offerItem = val('offerItemInput').trim();
  const msg = val('offerMsgInput').trim();
  if (!offerItem) { showToast("Please describe what you're offering", 'error'); return; }
  try {
    await makeOffer(tradeId, offerItem, msg);
    showToast('Trade offer sent! 🎉', 'success');
    if (window.refreshProduct) refreshProduct(); else openTradeModal(tradeId);
  } catch (e) {
    showToast(e.message || 'Could not send offer.', 'error');
  }
}

async function cancelOfferFromModal(offerId) {
  try {
    await cancelOffer(offerId);
    showToast('Offer cancelled', 'success');
    if (window.refreshProduct) refreshProduct(); else closeModal();
  } catch (e) {
    showToast(e.message || 'Could not cancel offer.', 'error');
  }
}

// Open the trade modal directly to the offer form (used by the "🤝 Offer" card button)
async function quickOffer(tradeId, event) {
  if (event) event.stopPropagation();
  await openTradeModal(tradeId);
  setTimeout(() => toggleOfferForm(tradeId), 60);
}

// ── Rating UI (shown on completed-trade offer cards) ──
// Called after offers.html renders a batch of cards — checks, per
// completed offer, whether the current user already left a rating.
async function _hydrateRatingSlots() {
  const slots = document.querySelectorAll('.rating-slot');
  for (const slot of slots) {
    const card = slot.closest('.offer-card');
    const offerId = card && card.dataset.offerId;
    if (!offerId) continue;
    try {
      const rated = await hasRatedOffer(offerId);
      slot.innerHTML = rated
        ? '<span style="color:var(--accent-green)">✓ You rated this trade</span>'
        : `<button class="btn btn-primary" style="width:100%;padding:8px;font-size:0.78rem" onclick="toggleRatingForm('${offerId}')">⭐ Rate this trade</button>
           <div id="ratingForm-${offerId}" style="display:none;margin-top:8px"></div>`;
    } catch (e) {
      slot.innerHTML = '';
    }
  }
}

let _ratingPick = {}; // offerId -> chosen star count, before submit

function toggleRatingForm(offerId) {
  const el = document.getElementById('ratingForm-' + offerId);
  if (!el) return;
  if (el.dataset.open === '1') { el.innerHTML = ''; el.dataset.open = '0'; el.style.display = 'none'; return; }
  el.dataset.open = '1';
  el.style.display = 'block';
  const stars = [1, 2, 3, 4, 5].map(n =>
    `<span class="star-pick" data-n="${n}" onclick="_pickStar('${offerId}',${n})" style="cursor:pointer;font-size:1.3rem;color:var(--text-muted)">★</span>`
  ).join('');
  el.innerHTML = `
    <div style="background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);padding:12px">
      <div id="starRow-${offerId}" style="margin-bottom:8px">${stars}</div>
      <textarea class="form-input" id="ratingCommentInput-${offerId}" placeholder="Add a comment (optional)" style="min-height:44px;font-size:0.8rem;margin-bottom:8px"></textarea>
      <button class="btn btn-primary" style="width:100%;padding:8px;font-size:0.78rem" onclick="submitRatingForm('${offerId}',this)">Submit Rating</button>
    </div>`;
}

function _pickStar(offerId, n) {
  _ratingPick[offerId] = n;
  const row = document.getElementById('starRow-' + offerId);
  if (!row) return;
  row.querySelectorAll('.star-pick').forEach(s => {
    s.style.color = Number(s.dataset.n) <= n ? '#ffc107' : 'var(--text-muted)';
  });
}

async function submitRatingForm(offerId, btnEl) {
  const stars = _ratingPick[offerId];
  if (!stars) { showToast('Pick a star rating first', 'error'); return; }
  const commentEl = document.getElementById('ratingCommentInput-' + offerId);
  if (btnEl) btnEl.disabled = true;
  try {
    await submitTradeRating(offerId, stars, commentEl ? commentEl.value.trim() : '');
    showToast('Thanks for rating this trade!', 'success');
    const slot = document.getElementById('ratingSlot-' + offerId);
    if (slot) slot.innerHTML = '<span style="color:var(--accent-green)">✓ You rated this trade</span>';
  } catch (e) {
    showToast(e.message || 'Could not submit rating.', 'error');
    if (btnEl) btnEl.disabled = false;
  }
}

// ── Expose globally ────────────────────────────
window.makeOffer                  = makeOffer;
window.respondToOffer             = respondToOffer;
window.counterOffer               = counterOffer;
window.respondToCounter           = respondToCounter;
window.cancelOffer                = cancelOffer;
window.markTradeComplete          = markTradeComplete;
window.loadOffersReceived         = loadOffersReceived;
window.loadOffersSent             = loadOffersSent;
window.getMyOfferForTrade         = getMyOfferForTrade;
window.countPendingOffersForTrade = countPendingOffersForTrade;
window.startOfferBadgeListener    = startOfferBadgeListener;
window.stopOfferBadgeListener     = stopOfferBadgeListener;
window.offerStatusBadge           = offerStatusBadge;
window.offerCardHTML              = offerCardHTML;
window.handleRespondOffer         = handleRespondOffer;
window.handleRespondCounter       = handleRespondCounter;
window.toggleCounterForm          = toggleCounterForm;
window.submitCounterOffer         = submitCounterOffer;
window.handleCancelOffer          = handleCancelOffer;
window.handleCompleteTrade        = handleCompleteTrade;
window.toggleOfferForm            = toggleOfferForm;
window.submitOfferFromModal       = submitOfferFromModal;
window.cancelOfferFromModal       = cancelOfferFromModal;
window.quickOffer                 = quickOffer;
window.hasRatedOffer              = hasRatedOffer;
window.submitTradeRating          = submitTradeRating;
window.getUserRatingSummary       = getUserRatingSummary;
window._hydrateRatingSlots        = _hydrateRatingSlots;
window.toggleRatingForm           = toggleRatingForm;
window._pickStar                  = _pickStar;
window.submitRatingForm           = submitRatingForm;
window.toggleInlineChat            = toggleInlineChat;
window.sendInlineChatMessage       = sendInlineChatMessage;
window._inlineChatKey              = _inlineChatKey;
window.closeAllInlineChats         = closeAllInlineChats;