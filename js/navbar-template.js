// ═══════════════════════════════════════════════
// navbar-template.js — Injects shared navbar HTML
// Notification button now uses a dedicated bell
// icon button (styles in notification.css,
// logic in notification.js)
// ═══════════════════════════════════════════════

(function injectNav() {
  const bellSVG = `<svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
  </svg>`;

  const html = `
  <nav id="mainNav">
    <a class="nav-logo" href="index.html" aria-label="GameBarterHub home"><span class="logo-mark">GB</span><span class="logo-text">GAME<span>BARTERHUB</span></span></a>

    <ul class="nav-links">
      <li><a href="browse.html"    data-page="browse.html">Browse</a></li>
      <li><a href="post-trade.html" data-page="post-trade.html" onclick="return checkLogin(this.href)">Post Trade</a></li>
      <li><a href="messages.html"  data-page="messages.html"   onclick="return checkLogin(this.href)">Messages</a></li>
      <li><a href="offers.html"    data-page="offers.html"     onclick="return checkLogin(this.href)">Trade Offers<span id="offersNavBadge" style="display:none;background:#ff3b3b;color:#fff;font-size:0.62rem;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:6px;vertical-align:middle"></span></a></li>
    </ul>

    <form class="nav-search" onsubmit="return navSearch(event)" role="search">
      <input type="search" id="navSearchInput" placeholder="Search…" autocomplete="off" aria-label="Search trades">
      <button type="submit" aria-label="Search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg></button>
    </form>

    <div class="nav-right">
      <!-- Auth buttons (logged out) -->
      <div id="navAuthBtns" style="display:flex">
        <a href="login.html"    class="btn btn-ghost"   style="margin-right:8px">Login</a>
        <a href="register.html" class="btn btn-primary">Sign Up</a>
      </div>

      <!-- Logged-in area -->
      <div id="navLoggedInArea" style="display:none;align-items:center;gap:10px">

        <!-- Notification bell button -->
        <div class="notif-btn-wrap" id="navNotifBtnWrap">
          <button
            class="notif-btn"
            id="notifBtn"
            onclick="toggleNotifPanel()"
            aria-label="Notifications"
            title="Notifications"
          >
            ${bellSVG}
            <span class="notif-badge hidden" id="notifBadge"></span>
          </button>
        </div>

        <!-- User pill + dropdown -->
        <div class="nav-user-wrap" id="navUserWrap">
          <div class="nav-user" onclick="toggleDropdown()">
            <div class="nav-avatar" id="navAvatar">?</div>
            <span class="nav-username" id="navUsername">User</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" style="margin-left:4px">
              <path d="M2 4l4 4 4-4" stroke="#8892aa" stroke-width="1.5" stroke-linecap="round"/>
            </svg>
          </div>
          <div class="profile-dropdown" id="profileDropdown">
            <a href="profile.html"    class="dropdown-item">👤 My Profile</a>
            <a href="post-trade.html" class="dropdown-item" onclick="return checkLogin(this.href)">➕ Post Trade</a>
            <a href="messages.html"   class="dropdown-item" onclick="return checkLogin(this.href)">💬 Messages</a>
            <a href="offers.html"     class="dropdown-item" onclick="return checkLogin(this.href)">🤝 Trade Offers</a>
            <a href="admin.html"      class="dropdown-item" id="navAdminLink" style="display:none">🛡️ Admin: Verifications</a>
            <div style="height:1px;background:var(--border);margin:4px 0"></div>
            <button class="dropdown-item danger" onclick="logout()">🚪 Sign Out</button>
          </div>
        </div>
      </div>

      <button class="hamburger" onclick="toggleMobileMenu()">
        <span></span><span></span><span></span>
      </button>
    </div>
  </nav>

  <!-- ═══ NOTIFICATION PANEL ═══ -->
  <div id="notifPanel">
    <div class="notif-header">
      <div class="notif-header-left">
        <div class="notif-header-icon">
          <svg viewBox="0 0 24 24">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          </svg>
        </div>
        <span class="notif-header-title">Notifications</span>
        <span class="notif-unread-count hidden" id="notifUnreadChip"></span>
      </div>
      <div class="notif-header-actions">
        <button class="notif-mark-all" onclick="markAllNotifsRead()">Mark all read</button>
        <button class="notif-panel-close" onclick="closeNotifPanel()" title="Close">✕</button>
      </div>
    </div>

    <div class="notif-filters">
      <button class="notif-filter-tab active" onclick="setNotifFilter('all', this)">All</button>
      <button class="notif-filter-tab" onclick="setNotifFilter('unread', this)">Unread</button>
      <button class="notif-filter-tab" onclick="setNotifFilter('likes', this)">Likes</button>
      <button class="notif-filter-tab" onclick="setNotifFilter('comments', this)">Comments</button>
    </div>

    <div id="notifList"></div>

    <div class="notif-footer">
      <button class="notif-footer-btn" onclick="clearAllNotifs()">Clear all notifications</button>
    </div>
  </div>

  <!-- ═══ MOBILE MENU ═══ -->
  <div class="mobile-menu" id="mobileMenu">
    <a href="index.html">🏠 Home</a>
    <a href="browse.html">🎮 Browse Games</a>
    <a href="post-trade.html" onclick="return checkLogin(this.href)">➕ Post Trade</a>
    <a href="messages.html"   onclick="return checkLogin(this.href)">💬 Messages</a>
    <a href="offers.html"     onclick="return checkLogin(this.href)">🤝 Trade Offers
      <span id="mobileOffersBadge" style="display:none;background:#ff3b3b;color:#fff;font-size:0.65rem;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:6px;line-height:1.4;vertical-align:middle"></span>
    </a>
    <a href="profile.html"    onclick="return checkLogin(this.href)">👤 My Account</a>
    <div style="height:1px;background:var(--border);margin:4px 0"></div>
    <!-- Mobile notification button (shown when logged in) -->
    <button id="mobileNotifBtn" style="display:none" onclick="closeMobileMenu();toggleNotifPanel()">
      🔔 Notifications
      <span id="mobileNotifBadge" style="display:none;background:#ff3b3b;color:#fff;font-size:0.65rem;font-weight:700;padding:1px 6px;border-radius:8px;margin-left:6px;line-height:1.4;vertical-align:middle"></span>
    </button>
    <a href="login.html" id="mobileAuthLink">🔑 Login / Sign Up</a>
    <a href="#" id="mobileLogoutLink" style="display:none;color:#ff4d6d" onclick="logout();return false">🚪 Sign Out</a>
  </div>

  <!-- ═══ CATEGORY STRIP ═══ -->
  <div class="cat-strip" id="catStrip"><div class="cat-strip-inner" id="catStripInner"></div></div>

  <!-- ═══ BOTTOM TAB BAR (phones) ═══ -->
  <div class="bottom-nav" id="bottomNav">
    <a href="index.html" data-page="index.html"><svg viewBox="0 0 24 24"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>Home</a>
    <a href="browse.html" data-page="browse.html"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>Browse</a>
    <a href="post-trade.html" data-page="post-trade.html" class="bn-post" onclick="return checkLogin(this.href)"><span class="bn-plus"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></span>Post</a>
    <a href="messages.html" data-page="messages.html" onclick="return checkLogin(this.href)"><svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>Messages</a>
    <a href="profile.html" data-page="profile.html" onclick="return checkLogin(this.href)"><span class="bn-ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg><i class="bn-badge" id="bnMyBadge"></i></span>My</a>
  </div>

  <div class="toast" id="toast"></div>
  `;

  document.body.insertAdjacentHTML('afterbegin', html);

  // ── Page flags (messages + auth pages hide marketplace chrome) ──
  const _page = window.location.pathname.split('/').pop() || 'index.html';
  if (_page === 'messages.html') document.body.classList.add('page-messages');
  if (_page === 'login.html' || _page === 'register.html') document.body.classList.add('page-auth');

  // ── Category strip (game quick-filters) ──
  const strip = document.getElementById('catStripInner');
  if (strip && typeof GAMES !== 'undefined') {
    const activeGame = new URLSearchParams(window.location.search).get('game');
    strip.innerHTML =
      `<a class="cat-chip${!activeGame ? ' active' : ''}" href="browse.html">All games</a>` +
      GAMES.map(g =>
        `<a class="cat-chip${activeGame === g.id ? ' active' : ''}" href="browse.html?game=${g.id}">${g.icon} ${g.name}</a>`
      ).join('');
    const act = activeGame ? strip.querySelector('.active') : null;
    if (act) strip.scrollLeft = Math.max(0, act.offsetLeft - strip.offsetLeft - 24);
  }

  // ── Prefill the header search from ?q= ──
  const qParam = new URLSearchParams(window.location.search).get('q');
  const navInput = document.getElementById('navSearchInput');
  if (navInput && qParam) navInput.value = qParam;

  // ── Footer ──
  document.body.insertAdjacentHTML('beforeend', `
  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-brand">
        <a class="nav-logo" href="index.html"><span class="logo-mark">GB</span><span class="logo-text">GAME<span>BARTERHUB</span></span></a>
        <p>A community marketplace for trading in-game items, accounts, and resources.</p>
      </div>
      <div class="footer-col">
        <h4>Trade</h4>
        <a href="browse.html">Browse trades</a>
        <a href="post-trade.html" onclick="return checkLogin(this.href)">Post a trade</a>
        <a href="offers.html" onclick="return checkLogin(this.href)">Trade offers</a>
      </div>
      <div class="footer-col">
        <h4>Account</h4>
        <a href="login.html">Login</a>
        <a href="register.html">Sign up</a>
        <a href="profile.html" onclick="return checkLogin(this.href)">My profile</a>
        <a href="messages.html" onclick="return checkLogin(this.href)">Messages</a>
      </div>
      <div class="footer-col">
        <h4>Help</h4>
        <a href="index.html#how-it-works">How it works</a>
        <a href="index.html#faq">FAQ</a>
      </div>
    </div>
    <div class="footer-bottom">
      <span>© ${new Date().getFullYear()} GameBarterHub. All rights reserved.</span>
      <span>Game names and logos belong to their respective owners.</span>
    </div>
  </footer>`);
  restoreSession().then(async () => {
    if (state.currentUser) {
      startNotifListener();
      if (typeof startOfferBadgeListener === 'function') startOfferBadgeListener();
      // Mark this user online site-wide (not just on the messages page)
      const uid = state.currentUser.uid || state.currentUser.id;
      if (typeof initPresence === 'function') initPresence(uid);
      // Show the Admin link only for admin accounts
      if (typeof isCurrentUserAdmin === 'function') {
        const admin = await isCurrentUserAdmin();
        const link = document.getElementById('navAdminLink');
        if (link) link.style.display = admin ? 'block' : 'none';
      }
    }
  });
  setActiveNav();

  // Close notif panel on outside click is handled in notification.js
})();

// ── GUARD: Login Required ──
function checkLogin(href) {
  if (!state.currentUser) {
    showToast('Please sign in first', 'error');
    setTimeout(() => { window.location.href = 'login.html'; }, 700);
    return false;
  }
  return true;
}

// ── Header search → Browse page with ?q= ──
function navSearch(e) {
  e.preventDefault();
  const q = (document.getElementById('navSearchInput')?.value || '').trim();
  window.location.href = q ? `browse.html?q=${encodeURIComponent(q)}` : 'browse.html';
  return false;
}
