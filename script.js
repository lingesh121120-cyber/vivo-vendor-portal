/* ═══════════════════════════════════════════════════════════════
   VendorIQ — Enterprise Vendor Management Portal
   Modular vanilla JS · ES6 · Firebase-ready data layer
   ───────────────────────────────────────────────────────────────
   NOTE: The DataStore abstraction below wraps localStorage today.
   To plug in Firebase later, replace the four methods in DataStore
   (getAll / save / remove / clearAll) with Firestore/RTDB calls.
   The rest of the app only ever talks to DataStore — nothing else
   needs to change.
═══════════════════════════════════════════════════════════════ */

'use strict';

/* ═══════════════════ DATA STORE (Firebase-backed) ═══════════════════
   The admin view mirrors the /vendors node from Firebase into an in-memory
   `cache` via a realtime listener, so the rest of the app keeps its simple
   synchronous getAll()/get() API. Writes go to Firebase (and optimistically
   to the cache so the UI updates instantly). Vendor DRAFTS never touch the
   cloud — they stay in localStorage until the vendor hits Submit.
   Activity log is a per-device admin convenience and stays local.
═══════════════════════════════════════════════════════════════════════ */
const DataStore = {
  DRAFT_KEY: 'vendoriq_draft',
  ACTIVITY_KEY: 'vendoriq_activity',
  cache: [],
  _subscribed: false,

  // Start/stop the live admin feed
  subscribe() {
    if (this._subscribed || !window.FB) return;
    this._subscribed = true;
    window.FB.subscribeVendors(list => {
      this.cache = list;
      updateSidebarBadges();
      // Refresh whichever admin page is showing
      if (State.currentPage === 'dashboard') renderDashboard();
      else if (State.currentPage === 'vendors') renderVendors();
      else if (State.currentPage === 'analytics') renderAnalytics();
      else if (State.currentPage === 'documents') renderDocuments();
    });
  },
  unsubscribe() {
    this._subscribed = false;
    this.cache = [];
    if (window.FB) window.FB.unsubscribeVendors();
  },

  getAll() { return this.cache.slice(); },
  get(id) { return this.cache.find(v => v.id === id); },

  // Admin create/update. Optimistically updates the cache, then writes to Firebase.
  save(vendor) {
    vendor.updatedAt = Date.now();
    if (!vendor.createdAt) vendor.createdAt = Date.now();
    const idx = this.cache.findIndex(v => v.id === vendor.id);
    if (idx >= 0) this.cache[idx] = vendor; else this.cache.unshift(vendor);
    if (window.FB) {
      window.FB.setVendor(vendor.id, vendor)
        .catch(e => toast('Could not save to cloud: ' + (e.code || e.message), 'error', 5000));
    }
    return vendor;
  },
  remove(id) {
    this.cache = this.cache.filter(v => v.id !== id);
    if (window.FB) {
      window.FB.removeVendor(id)
        .catch(e => toast('Delete failed: ' + (e.code || e.message), 'error', 5000));
    }
  },
  // Admin "Clear all" — removes every vendor node from Firebase
  clearAll() {
    const ids = this.cache.map(v => v.id);
    this.cache = [];
    if (window.FB) ids.forEach(id => window.FB.removeVendor(id).catch(() => {}));
    localStorage.removeItem(this.ACTIVITY_KEY);
  },

  // Activity log (per-device, local)
  getActivity() {
    try { return JSON.parse(localStorage.getItem(this.ACTIVITY_KEY)) || []; }
    catch { return []; }
  },
  logActivity(text, icon = 'blue') {
    const acts = this.getActivity();
    acts.unshift({ text, icon, time: Date.now() });
    localStorage.setItem(this.ACTIVITY_KEY, JSON.stringify(acts.slice(0, 50)));
  },
  clearActivity() { localStorage.removeItem(this.ACTIVITY_KEY); }
};

// Keep the sidebar "pending" badge + notification dot in sync from any page
function updateSidebarBadges() {
  const vendors = DataStore.getAll();
  const pending = vendors.filter(v => v.status === 'pending' || v.status === 'submitted').length;
  const badge = $('#pendingBadge');
  if (badge) { badge.textContent = pending; badge.style.display = pending ? 'inline-flex' : 'none'; }
  const dot = $('#notifDot');
  if (dot) dot.classList.toggle('visible', pending > 0);
}

/* ═══════════════════ APP STATE ═══════════════════ */
const State = {
  currentPage: 'dashboard',
  currentFilter: 'all',
  currentSort: 'newest',
  vendorSearch: '',
  wizard: {
    step: 0,
    editingId: null,
    data: {}
  },
  charts: {}
};

/* ═══════════════════ AUTH (client-side gate) ═══════════════════
   NOTE: This is lightweight gating only. The admin password lives in
   client JS and is visible to anyone who inspects the source. For real
   security, move authentication server-side (e.g. Firebase Auth) and
   have the backend enforce which data each role can read/write.
═════════════════════════════════════════════════════════════════ */
const Auth = {
  MODE_KEY: 'vendoriq_mode',

  // 'admin' is driven by Firebase auth state; 'vendor' is a local UI choice
  get mode() { return this._mode || sessionStorage.getItem(this.MODE_KEY); },
  set mode(m) {
    this._mode = m;
    m ? sessionStorage.setItem(this.MODE_KEY, m) : sessionStorage.removeItem(this.MODE_KEY);
  },

  showLanding() {
    $('#authLanding').style.display = 'block';
    $('#authAdmin').style.display = 'none';
    $('#authError').textContent = '';
  },
  showAdminLogin() {
    $('#authLanding').style.display = 'none';
    $('#authAdmin').style.display = 'block';
    $('#authError').textContent = '';
    setTimeout(() => $('#adminUser').focus(), 100);
  },

  // Real Firebase email/password sign-in. Success is handled by the
  // onAuth listener in init() (which calls enterAdmin).
  submitAdminLogin(e) {
    e.preventDefault();
    const email = $('#adminUser').value.trim();
    const pass = $('#adminPass').value;
    if (!email || !pass) { $('#authError').textContent = 'Enter your email and password.'; return; }
    if (!window.FB) { $('#authError').textContent = 'Still connecting to the server — try again in a moment.'; return; }
    const btn = $('#adminLoginBtn');
    btn.disabled = true;
    $('#authError').textContent = 'Signing in…';
    window.FB.signIn(email, pass)
      .then(() => { $('#adminPass').value = ''; $('#authError').textContent = ''; })
      .catch(err => { $('#authError').textContent = friendlyAuthError(err); })
      .finally(() => { btn.disabled = false; });
  },

  enterVendor() {
    this.mode = 'vendor';
    document.body.classList.remove('mode-admin');
    document.body.classList.add('mode-vendor');
    startFreshWizard();
    navigate('onboarding');
  },

  // Called by the Firebase auth listener once an admin is signed in
  enterAdmin() {
    this.mode = 'admin';
    document.body.classList.remove('mode-vendor');
    document.body.classList.add('mode-admin');
    DataStore.subscribe();
    navigate('dashboard');
    toast('Welcome back', 'success', 2500);
  },

  logout() {
    const wasAdmin = document.body.classList.contains('mode-admin');
    State.wizard = { step: 0, maxStep: 0, editingId: null, data: {} };
    this.mode = null;
    document.body.classList.remove('mode-admin', 'mode-vendor');
    DataStore.unsubscribe();
    if (wasAdmin && window.FB) window.FB.signOut();  // triggers auth listener → landing
    this.showLanding();
  },

  startNewVendorRegistration() {
    startFreshWizard();
    navigate('onboarding');
  }
};

// Translate Firebase auth error codes into plain English
function friendlyAuthError(err) {
  const code = (err && err.code) || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found'))
    return 'Incorrect email or password.';
  if (code.includes('invalid-email')) return 'That doesn\'t look like a valid email.';
  if (code.includes('too-many-requests')) return 'Too many attempts. Please wait a few minutes and try again.';
  if (code.includes('network')) return 'Network problem — check your internet connection.';
  return 'Sign-in failed. Please try again.';
}

function startFreshWizard() {
  State.wizard = { step: 0, maxStep: 0, editingId: null, data: { id: uid(), status: 'draft', projects: [] } };
}

/* ═══════════════════ CONSTANTS ═══════════════════ */
const STATUS_LABELS = {
  draft: 'Draft', submitted: 'Submitted', pending: 'Under Review',
  approved: 'Approved', rejected: 'Rejected', blacklisted: 'Blacklisted', archived: 'Archived'
};
const STATUS_BADGE = {
  draft: 'badge-draft', submitted: 'badge-submitted', pending: 'badge-pending',
  approved: 'badge-approved', rejected: 'badge-rejected', blacklisted: 'badge-blacklisted', archived: 'badge-archived'
};

const WIZARD_STEPS = [
  { id: 'company', num: 1, label: 'Company Info', heading: 'Company Information', desc: 'Basic details about the vendor company or firm.' },
  { id: 'contact', num: 2, label: 'Contact Info', heading: 'Contact Information', desc: 'Primary point of contact and communication channels.' },
  { id: 'business', num: 3, label: 'Business Profile', heading: 'Business Profile', desc: 'Experience, team, clientele and past work.' },
  { id: 'technical', num: 4, label: 'Technical', heading: 'Technical Capability', desc: 'Equipment, software and production capabilities.' },
  { id: 'creative', num: 5, label: 'Creative', heading: 'Editing & Creative Capability', desc: 'Editing flexibility, style and creative strengths.' },
  { id: 'commercial', num: 6, label: 'Commercial', heading: 'Commercial Information', desc: 'Pricing, payment terms and charges.' },
  { id: 'bank', num: 7, label: 'Bank Details', heading: 'Bank Details', desc: 'Account details for payment processing.' },
  { id: 'legal', num: 8, label: 'Legal', heading: 'Legal & Compliance', desc: 'Statutory registration numbers.' },
  { id: 'documents', num: 9, label: 'Documents', heading: 'Documents', desc: 'Upload whatever documents you have — none are mandatory. More documents help your application, but you can submit without them.' },
  { id: 'declaration', num: 10, label: 'Declaration', heading: 'Vendor Declaration', desc: 'Final confirmation and submission.' }
];

// Preset tag suggestions for technical capability
const TAG_PRESETS = {
  primaryCamera: ['Sony FX3', 'Sony FX6', 'Sony A7S III', 'Canon R5', 'Canon C70', 'RED Komodo', 'Blackmagic 6K', 'Nikon Z9'],
  backupCamera: ['Sony A7 IV', 'Canon R6', 'Panasonic GH6', 'Sony FX30', 'Blackmagic Pocket'],
  lens: ['Sony G Master', 'Canon RF', 'Sigma Art', 'Zeiss', 'Tamron', 'Samyang Cine', 'DZOFilm'],
  lighting: ['Aputure 600D', 'Aputure 300X', 'Godox', 'Nanlite', 'ARRI SkyPanel', 'Amaran'],
  audio: ['Rode Wireless GO II', 'Sennheiser MKH416', 'Zoom H6', 'Deity', 'Sony UWP', 'Boya'],
  editingSoftware: ['Adobe Premiere Pro', 'DaVinci Resolve', 'Final Cut Pro', 'After Effects', 'CapCut Pro'],
  aiTools: ['Runway ML', 'Topaz Video AI', 'ElevenLabs', 'Descript', 'Adobe Firefly', 'Midjourney', 'Kling AI', 'Sora'],
  motionGraphics: ['Adobe After Effects', 'Cinema 4D', 'Blender', 'Element 3D', 'Apple Motion'],
  colourGrading: ['DaVinci Resolve', 'Lumetri', 'FilmConvert', 'Dehancer', 'Colourlab AI']
};

const DOC_CHECKLIST = [
  { id: 'companyReg', name: 'Company Registration Certificate', type: 'pdf', required: true },
  { id: 'gstCert', name: 'GST Certificate', type: 'pdf', required: true },
  { id: 'panCard', name: 'PAN Card', type: 'img', required: true },
  { id: 'aadhaar', name: 'Aadhaar of Authorized Signatory', type: 'img', required: true },
  { id: 'addressProof', name: 'Business Address Proof', type: 'pdf', required: true },
  { id: 'vendorAgreement', name: 'Signed Vendor Agreement', type: 'pdf', required: true },
  { id: 'gstInvoice', name: 'Sample GST Invoice', type: 'pdf', required: true },
  { id: 'companyProfile', name: 'Company Profile', type: 'pdf', required: true },
  { id: 'msme', name: 'MSME Certificate', type: 'pdf', required: false },
  { id: 'cancelledCheque', name: 'Cancelled Cheque', type: 'img', required: false },
  { id: 'bankStatement', name: 'Bank Passbook / Statement', type: 'pdf', required: false },
  { id: 'nda', name: 'Signed NDA', type: 'pdf', required: false },
  { id: 'compliance', name: 'Compliance Declaration', type: 'pdf', required: false },
  { id: 'droneLicense', name: 'Drone License', type: 'pdf', required: false }
];

// Fields a vendor may leave blank. They are still format-validated IF filled in.
// (Documents are handled separately and are all optional.)
const OPTIONAL_KEYS = new Set(['gstNumber']);

/* ═══════════════════ UTILITIES ═══════════════════ */
const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);
const uid = () => 'v_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Escape HTML to prevent XSS from vendor-entered data
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function initials(name) {
  if (!name) return '?';
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 604800) return Math.floor(s / 86400) + 'd ago';
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}
function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtCurrency(val) {
  if (!val && val !== 0) return '—';
  const n = Number(String(val).replace(/[^\d.]/g, ''));
  if (isNaN(n)) return esc(val);
  return '₹' + n.toLocaleString('en-IN');
}

/* ═══════════════════ VALIDATION ═══════════════════ */
const Validators = {
  email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
  phone: v => /^[6-9]\d{9}$/.test(String(v).replace(/[\s+\-]/g, '').replace(/^91/, '')),
  website: v => !v || /^(https?:\/\/)?([\w-]+\.)+[\w-]+(\/[\w\-._~:/?#[\]@!$&'()*+,;=]*)?$/.test(v),
  gst: v => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(String(v).toUpperCase()),
  pan: v => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(v).toUpperCase()),
  ifsc: v => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(v).toUpperCase()),
  year: v => { const y = +v; return y >= 1950 && y <= new Date().getFullYear(); }
};

/* ═══════════════════ TOAST ═══════════════════ */
function toast(message, type = 'success', duration = 3200) {
  const container = $('#toastContainer');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon"></span><span>${esc(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 320);
  }, duration);
}

/* ═══════════════════ NAVIGATION ═══════════════════ */
function navigate(page) {
  // Vendors are restricted to the registration wizard + success screen only
  if (Auth.mode === 'vendor' && !['onboarding', 'vendorSuccess'].includes(page)) {
    return;
  }
  State.currentPage = page;
  $$('.page').forEach(p => p.classList.remove('active'));
  const target = $('#page-' + page);
  if (target) target.classList.add('active');
  $$('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));

  // Close mobile sidebar
  $('#sidebar').classList.remove('mobile-open');

  // Page-specific renders
  if (page === 'dashboard') renderDashboard();
  if (page === 'vendors') renderVendors();
  if (page === 'analytics') renderAnalytics();
  if (page === 'documents') renderDocuments();
  if (page === 'onboarding') initWizard();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function toggleSidebar() {
  if (window.innerWidth <= 900) {
    $('#sidebar').classList.toggle('mobile-open');
  } else {
    $('#sidebar').classList.toggle('collapsed');
    document.body.classList.toggle('sidebar-collapsed');
  }
}

function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  localStorage.setItem('vendoriq_theme', next);
  // Re-render charts to pick up theme colors
  if (State.currentPage === 'dashboard') renderCharts();
  if (State.currentPage === 'analytics') renderAnalytics();
}

/* ═══════════════════ NOTIFICATIONS ═══════════════════ */
function toggleNotifications() {
  const dd = $('#notifDropdown');
  dd.classList.toggle('open');
  if (dd.classList.contains('open')) {
    $('#notifDot').classList.remove('visible');
    renderNotifications();
  }
}
function renderNotifications() {
  const vendors = DataStore.getAll();
  const pending = vendors.filter(v => v.status === 'pending' || v.status === 'submitted');
  const list = $('#notifList');
  if (!pending.length) {
    list.innerHTML = `<div class="notif-item"><div class="ni-title">All caught up ✨</div><div class="ni-time">No pending reviews</div></div>`;
    return;
  }
  list.innerHTML = pending.slice(0, 6).map(v => `
    <div class="notif-item" onclick="openVendorProfile('${v.id}'); toggleNotifications();">
      <div class="ni-title">${esc(v.companyName || 'Unnamed Vendor')} awaiting review</div>
      <div class="ni-time">${timeAgo(v.updatedAt || v.createdAt)}</div>
    </div>`).join('');
}

/* ═══════════════════ DASHBOARD ═══════════════════ */
function renderDashboard() {
  if (Auth.mode === 'vendor') return; // vendors never see aggregate/other-vendor data
  const vendors = DataStore.getAll();
  const total = vendors.length;
  const approved = vendors.filter(v => v.status === 'approved').length;
  const pending = vendors.filter(v => v.status === 'pending' || v.status === 'submitted').length;
  const rejected = vendors.filter(v => v.status === 'rejected').length;

  // This month count
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const thisMonth = vendors.filter(v => (v.createdAt || 0) >= monthStart.getTime()).length;

  // Avg score
  const scored = vendors.map(v => computeScore(v).total).filter(s => s > 0);
  const avgScore = scored.length ? Math.round(scored.reduce((a, b) => a + b, 0) / scored.length) : 0;

  // Doc completion
  const docPct = total ? Math.round(vendors.reduce((sum, v) => sum + docCompletionPct(v), 0) / total) : 0;

  $('#statTotal').textContent = total;
  $('#statTotalTrend').textContent = `+${thisMonth} this month`;
  $('#statApproved').textContent = approved;
  $('#statApprovedPct').textContent = total ? `${Math.round(approved / total * 100)}% approval rate` : '0% approval rate';
  $('#statPending').textContent = pending;
  $('#statRejected').textContent = rejected;
  $('#statRejectedLabel').textContent = total ? `${Math.round(rejected / total * 100)}% rejection rate` : '0% rejection rate';
  $('#statAvgScore').textContent = avgScore || '—';
  $('#statDocComplete').textContent = docPct + '%';

  animateStats();

  // Pending badge in sidebar
  const badge = $('#pendingBadge');
  badge.textContent = pending;
  badge.style.display = pending ? 'inline-flex' : 'none';

  // Notif dot
  $('#notifDot').classList.toggle('visible', pending > 0);

  renderRecentVendors(vendors);
  renderActivityTimeline();
  renderCharts();
}

function animateStats() {
  $$('.stat-value').forEach(el => {
    const target = parseInt(el.textContent) || 0;
    if (el.dataset.animated === '1' || target === 0) return;
    el.dataset.animated = '1';
    const suffix = el.textContent.includes('%') ? '%' : '';
    let cur = 0;
    const step = Math.max(1, Math.ceil(target / 30));
    const timer = setInterval(() => {
      cur += step;
      if (cur >= target) { cur = target; clearInterval(timer); }
      el.textContent = cur + suffix;
    }, 20);
  });
}

function renderRecentVendors(vendors) {
  const container = $('#recentVendors');
  const recent = [...vendors].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 5);
  if (!recent.length) {
    container.innerHTML = `<div class="empty-state small"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg><p>No vendors yet</p></div>`;
    return;
  }
  container.innerHTML = recent.map(v => `
    <div class="recent-vendor-item" onclick="openVendorProfile('${v.id}')">
      <div class="rv-avatar">${esc(initials(v.companyName))}</div>
      <div>
        <div class="rv-name">${esc(v.companyName || 'Unnamed')}</div>
        <div class="rv-type">${esc(v.businessType || v.natureOfServices || '—')}</div>
      </div>
      <div class="rv-status"><span class="badge ${STATUS_BADGE[v.status] || 'badge-draft'}">${STATUS_LABELS[v.status] || 'Draft'}</span></div>
    </div>`).join('');
}

function renderActivityTimeline() {
  const container = $('#activityTimeline');
  const acts = DataStore.getActivity();
  if (!acts.length) {
    container.innerHTML = `<div class="empty-state small"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg><p>No recent activity</p></div>`;
    return;
  }
  container.innerHTML = acts.slice(0, 8).map(a => `
    <div class="activity-item">
      <div class="activity-dot" style="background:var(--${a.icon === 'blue' ? 'primary' : a.icon})"></div>
      <div>
        <div class="activity-text">${a.text}</div>
        <div class="activity-time">${timeAgo(a.time)}</div>
      </div>
    </div>`).join('');
}
function clearActivity() {
  DataStore.clearActivity();
  renderActivityTimeline();
  toast('Activity cleared', 'info');
}

/* ═══════════════════ CHARTS (custom canvas, no libs) ═══════════════════ */
function chartColors() {
  const dark = document.documentElement.dataset.theme === 'dark';
  return {
    grid: dark ? 'rgba(255,255,255,0.06)' : 'rgba(15,23,42,0.06)',
    text: dark ? '#94a3b8' : '#94a3b8',
    primary: '#3b82f6', primaryFill: 'rgba(59,130,246,0.12)',
    green: '#10b981', greenFill: 'rgba(16,185,129,0.12)',
    orange: '#f59e0b', purple: '#8b5cf6', red: '#ef4444', teal: '#14b8a6'
  };
}

function renderCharts() {
  const vendors = DataStore.getAll();
  drawGrowthChart(vendors);
  drawCategoryChart(vendors);
}

// Group vendors into last 6 months
function last6Months(vendors) {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      label: d.toLocaleDateString('en-IN', { month: 'short' }),
      start: d.getTime(),
      end: new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
    });
  }
  return months.map(m => ({
    label: m.label,
    total: vendors.filter(v => (v.createdAt || 0) < m.end).length,
    approved: vendors.filter(v => v.status === 'approved' && (v.createdAt || 0) < m.end).length,
    added: vendors.filter(v => (v.createdAt || 0) >= m.start && (v.createdAt || 0) < m.end).length
  }));
}

function setupCanvas(id) {
  const canvas = $('#' + id);
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.parentElement.clientWidth - 44;
  const h = canvas.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

function drawGrowthChart(vendors) {
  const c = setupCanvas('growthChart');
  if (!c) return;
  const { ctx, w, h } = c;
  const col = chartColors();
  const data = last6Months(vendors);
  const pad = { l: 34, r: 12, t: 16, b: 26 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
  const maxV = Math.max(4, ...data.map(d => d.total));

  ctx.clearRect(0, 0, w, h);
  // Grid + Y labels
  ctx.font = '11px Inter';
  ctx.fillStyle = col.text;
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ch - (ch * i / 4);
    ctx.strokeStyle = col.grid;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(Math.round(maxV * i / 4), pad.l - 8, y + 3);
  }
  const xStep = cw / (data.length - 1 || 1);
  const px = i => pad.l + xStep * i;
  const py = val => pad.t + ch - (ch * val / maxV);

  // Area + line helper
  const drawLine = (key, color, fill) => {
    ctx.beginPath();
    data.forEach((d, i) => { const x = px(i), y = py(d[key]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    // Fill area
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ch);
    grad.addColorStop(0, fill); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.lineTo(px(data.length - 1), pad.t + ch);
    ctx.lineTo(px(0), pad.t + ch);
    ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.restore();
    // Stroke line
    ctx.beginPath();
    data.forEach((d, i) => { const x = px(i), y = py(d[key]); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.lineJoin = 'round'; ctx.stroke();
    // Points
    data.forEach((d, i) => {
      ctx.beginPath(); ctx.arc(px(i), py(d[key]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.fill();
      ctx.strokeStyle = document.documentElement.dataset.theme === 'dark' ? '#0f1c37' : '#fff';
      ctx.lineWidth = 2; ctx.stroke();
    });
  };
  drawLine('total', col.primary, col.primaryFill);
  drawLine('approved', col.green, col.greenFill);

  // X labels
  ctx.fillStyle = col.text; ctx.textAlign = 'center'; ctx.font = '11px Inter';
  data.forEach((d, i) => ctx.fillText(d.label, px(i), h - 8));
}

function drawCategoryChart(vendors) {
  const c = setupCanvas('categoryChart');
  if (!c) return;
  const { ctx, w, h } = c;
  const col = chartColors();
  // Group by business type
  const groups = {};
  vendors.forEach(v => {
    const k = v.businessType || 'Unspecified';
    groups[k] = (groups[k] || 0) + 1;
  });
  let entries = Object.entries(groups);
  ctx.clearRect(0, 0, w, h);
  if (!entries.length) {
    ctx.fillStyle = col.text; ctx.font = '13px Inter'; ctx.textAlign = 'center';
    ctx.fillText('No data yet', w / 2, h / 2);
    return;
  }
  const palette = [col.primary, col.green, col.orange, col.purple, col.teal, col.red];
  const total = entries.reduce((a, [, v]) => a + v, 0);
  const cx = h / 2 + 10, cy = h / 2, r = h / 2 - 24, ir = r * 0.6;
  let start = -Math.PI / 2;
  entries.forEach(([, val], i) => {
    const ang = (val / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, start + ang);
    ctx.closePath();
    ctx.fillStyle = palette[i % palette.length];
    ctx.fill();
    start += ang;
  });
  // Donut hole
  ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2);
  ctx.fillStyle = document.documentElement.dataset.theme === 'dark' ? '#0f1c37' : '#fff';
  ctx.fill();
  ctx.fillStyle = col.text; ctx.textAlign = 'center'; ctx.font = '800 22px Inter';
  ctx.fillStyle = document.documentElement.dataset.theme === 'dark' ? '#f0f6ff' : '#0f172a';
  ctx.fillText(total, cx, cy - 2);
  ctx.font = '10px Inter'; ctx.fillStyle = col.text;
  ctx.fillText('vendors', cx, cy + 14);
  // Legend
  const lx = cx + r + 20;
  ctx.textAlign = 'left'; ctx.font = '11px Inter';
  entries.slice(0, 6).forEach(([key, val], i) => {
    const ly = 28 + i * 22;
    ctx.fillStyle = palette[i % palette.length];
    ctx.beginPath(); ctx.roundRect(lx, ly - 8, 9, 9, 2); ctx.fill();
    ctx.fillStyle = col.text;
    const label = key.length > 14 ? key.slice(0, 13) + '…' : key;
    ctx.fillText(`${label} (${val})`, lx + 16, ly);
  });
}

/* ═══════════════════ ANALYTICS ═══════════════════ */
function renderAnalytics() {
  if (Auth.mode === 'vendor') return;
  const vendors = DataStore.getAll();
  drawMonthlyChart(vendors);
  drawApprovalChart(vendors);
  drawExperienceChart(vendors);
  drawScoreDistChart(vendors);
  drawEquipmentChart(vendors);
  drawServiceChart(vendors);
}

function drawBarChart(id, labels, values, color) {
  const c = setupCanvas(id);
  if (!c) return;
  const { ctx, w, h } = c;
  const col = chartColors();
  const pad = { l: 30, r: 12, t: 16, b: 30 };
  const cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;
  const maxV = Math.max(1, ...values);
  ctx.clearRect(0, 0, w, h);
  ctx.font = '11px Inter'; ctx.fillStyle = col.text; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const y = pad.t + ch - (ch * i / 4);
    ctx.strokeStyle = col.grid; ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(Math.round(maxV * i / 4), pad.l - 6, y + 3);
  }
  const bw = cw / labels.length * 0.55;
  const gap = cw / labels.length;
  labels.forEach((lab, i) => {
    const val = values[i];
    const bh = ch * val / maxV;
    const x = pad.l + gap * i + (gap - bw) / 2;
    const y = pad.t + ch - bh;
    const grad = ctx.createLinearGradient(0, y, 0, pad.t + ch);
    grad.addColorStop(0, color); grad.addColorStop(1, color + '55');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.roundRect(x, y, bw, bh, [5, 5, 0, 0]); ctx.fill();
    ctx.fillStyle = col.text; ctx.textAlign = 'center'; ctx.font = '10px Inter';
    const label = lab.length > 8 ? lab.slice(0, 7) + '…' : lab;
    ctx.fillText(label, x + bw / 2, h - 10);
  });
}

function drawMonthlyChart(vendors) {
  const data = last6Months(vendors);
  drawBarChart('monthlyChart', data.map(d => d.label), data.map(d => d.added), '#3b82f6');
}
function drawExperienceChart(vendors) {
  const buckets = { '0-2 yrs': 0, '3-5 yrs': 0, '6-10 yrs': 0, '10+ yrs': 0 };
  vendors.forEach(v => {
    const y = parseInt(v.yearsExperience) || 0;
    if (y <= 2) buckets['0-2 yrs']++;
    else if (y <= 5) buckets['3-5 yrs']++;
    else if (y <= 10) buckets['6-10 yrs']++;
    else buckets['10+ yrs']++;
  });
  drawBarChart('experienceChart', Object.keys(buckets), Object.values(buckets), '#8b5cf6');
}
function drawScoreDistChart(vendors) {
  const grades = { 'C': 0, 'B': 0, 'B+': 0, 'A': 0, 'A+': 0 };
  vendors.forEach(v => { const g = computeScore(v).grade; if (g && grades[g] !== undefined) grades[g]++; });
  drawBarChart('scoreDistChart', Object.keys(grades), Object.values(grades), '#10b981');
}
function drawEquipmentChart(vendors) {
  const counts = {};
  vendors.forEach(v => {
    (v.primaryCamera || []).concat(v.editingSoftware || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; });
  });
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!top.length) { drawBarChart('equipmentChart', ['No data'], [0], '#14b8a6'); return; }
  drawBarChart('equipmentChart', top.map(t => t[0]), top.map(t => t[1]), '#14b8a6');
}

function drawApprovalChart(vendors) {
  const c = setupCanvas('approvalChart');
  if (!c) return;
  const { ctx, w, h } = c;
  const col = chartColors();
  const counts = {
    Approved: vendors.filter(v => v.status === 'approved').length,
    Pending: vendors.filter(v => v.status === 'pending' || v.status === 'submitted').length,
    Rejected: vendors.filter(v => v.status === 'rejected').length,
    Draft: vendors.filter(v => v.status === 'draft').length
  };
  drawDonut(ctx, w, h, col, [
    ['Approved', counts.Approved, col.green],
    ['Pending', counts.Pending, col.orange],
    ['Rejected', counts.Rejected, col.red],
    ['Draft', counts.Draft, '#94a3b8']
  ]);
}
function drawServiceChart(vendors) {
  const c = setupCanvas('serviceChart');
  if (!c) return;
  const { ctx, w, h } = c;
  const col = chartColors();
  const groups = {};
  vendors.forEach(v => {
    const k = v.natureOfServices || v.contentSpecialization || 'General';
    const short = k.length > 16 ? k.slice(0, 15) + '…' : k;
    groups[short] = (groups[short] || 0) + 1;
  });
  const palette = [col.primary, col.purple, col.teal, col.orange, col.green, col.red];
  drawDonut(ctx, w, h, col, Object.entries(groups).slice(0, 6).map(([k, v], i) => [k, v, palette[i % palette.length]]));
}

function drawDonut(ctx, w, h, col, entries) {
  ctx.clearRect(0, 0, w, h);
  const total = entries.reduce((a, e) => a + e[1], 0);
  if (!total) {
    ctx.fillStyle = col.text; ctx.font = '13px Inter'; ctx.textAlign = 'center';
    ctx.fillText('No data yet', w / 2, h / 2); return;
  }
  const cx = h / 2 + 6, cy = h / 2, r = h / 2 - 22, ir = r * 0.62;
  let start = -Math.PI / 2;
  entries.forEach(([, val, c]) => {
    if (!val) return;
    const ang = (val / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + ang); ctx.closePath();
    ctx.fillStyle = c; ctx.fill(); start += ang;
  });
  ctx.beginPath(); ctx.arc(cx, cy, ir, 0, Math.PI * 2);
  ctx.fillStyle = document.documentElement.dataset.theme === 'dark' ? '#0f1c37' : '#fff'; ctx.fill();
  ctx.fillStyle = document.documentElement.dataset.theme === 'dark' ? '#f0f6ff' : '#0f172a';
  ctx.font = '800 20px Inter'; ctx.textAlign = 'center'; ctx.fillText(total, cx, cy + 2);
  // Legend
  const lx = cx + r + 16;
  ctx.textAlign = 'left'; ctx.font = '11px Inter';
  entries.forEach(([key, val, c], i) => {
    const ly = 26 + i * 20;
    ctx.fillStyle = c; ctx.beginPath(); ctx.roundRect(lx, ly - 8, 9, 9, 2); ctx.fill();
    ctx.fillStyle = col.text; ctx.fillText(`${key} (${val})`, lx + 15, ly);
  });
}

/* ═══════════════════ VENDOR SCORING ENGINE (Admin only) ═══════════════════ */
function computeScore(v) {
  if (!v || v.status === 'draft') return { total: 0, grade: '', risk: '', breakdown: [] };
  const b = [];

  // Years of experience (max 12)
  const yrs = parseInt(v.yearsExperience) || 0;
  b.push(['Years of Experience', Math.min(12, yrs * 1.2)]);

  // Equipment quality (max 12) — count of premium gear tags
  const equip = (v.primaryCamera || []).length + (v.lens || []).length + (v.lighting || []).length + (v.audio || []).length;
  b.push(['Equipment Quality', Math.min(12, equip * 1.5)]);

  // Creative capability (max 10)
  const creative = (v.editingSoftware || []).length + (v.motionGraphics || []).length + (v.colourGrading || []).length;
  b.push(['Creative Capability', Math.min(10, creative * 1.6)]);

  // Client portfolio (max 10)
  const clients = (v.majorClients || '').split(/[,\n]/).filter(x => x.trim()).length;
  const projects = (v.projects || []).length;
  b.push(['Client Portfolio', Math.min(10, clients * 1.2 + projects * 1.5)]);

  // Document completion (max 15)
  b.push(['Document Completion', Math.round(docCompletionPct(v) * 0.15)]);

  // Communication (max 8)
  let comm = 0;
  if (v.communicationPlatform) comm += 3;
  if (v.responseTime) comm += 3;
  if (v.feedbackMethod) comm += 2;
  b.push(['Communication', comm]);

  // Delivery speed (max 8)
  let delivery = 0;
  if (v.urgentDelivery) delivery += 4;
  if (v.tightDeadline === 'Yes') delivery += 2;
  if (v.weekendAvailability === 'Yes') delivery += 2;
  b.push(['Delivery Speed', delivery]);

  // AI adoption (max 8)
  b.push(['AI Adoption', Math.min(8, (v.aiTools || []).length * 2)]);

  // Portfolio quality (max 8)
  let pq = 0;
  if (v.portfolioLink) pq += 3;
  if (v.bestVideos) pq += 3;
  if (v.uniqueStrengths) pq += 2;
  b.push(['Portfolio Quality', pq]);

  // Commercial competitiveness (max 9)
  let comm2 = 0;
  if (v.rateCard === 'Yes') comm2 += 3;
  if (v.paymentTerms) comm2 += 3;
  if (v.productionCost) comm2 += 3;
  b.push(['Commercial Fit', comm2]);

  const total = Math.round(b.reduce((a, x) => a + x[1], 0));
  let grade, risk;
  if (total >= 85) { grade = 'A+'; risk = 'Excellent'; }
  else if (total >= 72) { grade = 'A'; risk = 'Good'; }
  else if (total >= 58) { grade = 'B+'; risk = 'Good'; }
  else if (total >= 42) { grade = 'B'; risk = 'Average'; }
  else { grade = 'C'; risk = 'Needs Improvement'; }

  return { total, grade, risk, breakdown: b };
}
function gradeClass(grade) {
  return { 'A+': 'score-aplus', 'A': 'score-a', 'B+': 'score-bplus', 'B': 'score-b', 'C': 'score-c' }[grade] || 'score-b';
}

/* ═══════════════════ DOC COMPLETION ═══════════════════ */
function docCompletionPct(v) {
  const docs = v.documents || {};
  const required = DOC_CHECKLIST.filter(d => d.required);
  const uploaded = required.filter(d => docs[d.id]).length;
  return required.length ? Math.round(uploaded / required.length * 100) : 0;
}

/* ═══════════════════ VENDOR LIST ═══════════════════ */
function setFilter(filter) {
  State.currentFilter = filter;
  $$('.filter-chip').forEach(c => c.classList.toggle('active', c.dataset.filter === filter));
  renderVendors();
}
function sortVendors(sort) { State.currentSort = sort; renderVendors(); }
function filterVendors() {
  State.vendorSearch = $('#vendorSearch').value.toLowerCase();
  renderVendors();
}

function getFilteredVendors() {
  let vendors = DataStore.getAll();
  // Filter by status
  if (State.currentFilter !== 'all') {
    if (State.currentFilter === 'pending') {
      vendors = vendors.filter(v => v.status === 'pending' || v.status === 'submitted');
    } else {
      vendors = vendors.filter(v => v.status === State.currentFilter);
    }
  }
  // Search
  const q = State.vendorSearch;
  if (q) {
    vendors = vendors.filter(v =>
      (v.companyName || '').toLowerCase().includes(q) ||
      (v.brandName || '').toLowerCase().includes(q) ||
      (v.gstNumber || '').toLowerCase().includes(q) ||
      (v.natureOfServices || '').toLowerCase().includes(q) ||
      (v.contactPerson || '').toLowerCase().includes(q)
    );
  }
  // Sort
  const s = State.currentSort;
  vendors.sort((a, b) => {
    if (s === 'newest') return (b.createdAt || 0) - (a.createdAt || 0);
    if (s === 'oldest') return (a.createdAt || 0) - (b.createdAt || 0);
    if (s === 'updated') return (b.updatedAt || 0) - (a.updatedAt || 0);
    if (s === 'name') return (a.companyName || '').localeCompare(b.companyName || '');
    if (s === 'score') return computeScore(b).total - computeScore(a).total;
    return 0;
  });
  return vendors;
}

function renderVendors() {
  if (Auth.mode === 'vendor') return;
  const vendors = getFilteredVendors();
  const grid = $('#vendorGrid');
  const empty = $('#vendorEmptyState');
  if (!vendors.length) {
    grid.innerHTML = '';
    empty.style.display = 'flex';
    return;
  }
  empty.style.display = 'none';
  grid.innerHTML = vendors.map(v => {
    const score = computeScore(v);
    return `
    <div class="vendor-card" onclick="openVendorProfile('${v.id}')">
      <div class="vendor-card-header">
        <div class="vendor-card-avatar">${esc(initials(v.companyName))}</div>
        <div style="flex:1;min-width:0">
          <div class="vendor-card-name">${esc(v.companyName || 'Unnamed Vendor')}</div>
          <div class="vendor-card-type">${esc(v.brandName || v.businessType || '—')}</div>
        </div>
        <div class="vendor-card-status"><span class="badge ${STATUS_BADGE[v.status]}">${STATUS_LABELS[v.status]}</span></div>
      </div>
      <div class="vendor-card-meta">
        <div class="vendor-meta-item"><span class="vendor-meta-label">Experience</span><br><span class="vendor-meta-val">${esc(v.yearsExperience || '—')} ${v.yearsExperience ? 'yrs' : ''}</span></div>
        <div class="vendor-meta-item"><span class="vendor-meta-label">Location</span><br><span class="vendor-meta-val">${esc(v.city || extractCity(v.officeAddress) || '—')}</span></div>
        <div class="vendor-meta-item"><span class="vendor-meta-label">Docs</span><br><span class="vendor-meta-val">${docCompletionPct(v)}% complete</span></div>
        <div class="vendor-meta-item"><span class="vendor-meta-label">Admin Score</span><br><span class="vendor-meta-val">${score.total ? score.total + '/100' : '—'}</span></div>
      </div>
      <div class="completion-bar"><div class="completion-fill" style="width:${docCompletionPct(v)}%"></div></div>
      <div class="vendor-card-footer" style="margin-top:14px">
        ${score.grade ? `<span class="score-badge ${gradeClass(score.grade)}">${score.grade}</span>` : '<span class="text-muted" style="font-size:12px">Unscored</span>'}
        <div class="vendor-card-actions" onclick="event.stopPropagation()">
          <button class="card-icon-btn" title="Edit" onclick="editVendor('${v.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="card-icon-btn" title="View" onclick="openVendorProfile('${v.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>
          <button class="card-icon-btn danger" title="Delete" onclick="confirmDeleteVendor('${v.id}')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg></button>
        </div>
      </div>
    </div>`;
  }).join('');
}
function extractCity(addr) {
  if (!addr) return '';
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/* ═══════════════════ GLOBAL SEARCH ═══════════════════ */
function handleGlobalSearch(q) {
  const dd = $('#searchDropdown');
  q = q.trim().toLowerCase();
  if (!q) { dd.classList.remove('visible'); return; }
  const results = DataStore.getAll().filter(v =>
    (v.companyName || '').toLowerCase().includes(q) ||
    (v.brandName || '').toLowerCase().includes(q) ||
    (v.gstNumber || '').toLowerCase().includes(q)
  ).slice(0, 6);
  if (!results.length) {
    dd.innerHTML = `<div class="search-result-item"><span class="sr-sub">No vendors found for "${esc(q)}"</span></div>`;
  } else {
    dd.innerHTML = results.map(v => `
      <div class="search-result-item" onclick="openVendorProfile('${v.id}'); $('#globalSearch').value=''; $('#searchDropdown').classList.remove('visible');">
        <div class="sr-name">${esc(v.companyName)}</div>
        <div class="sr-sub">${esc(v.businessType || '')} · ${STATUS_LABELS[v.status]}</div>
      </div>`).join('');
  }
  dd.classList.add('visible');
}

/* ═══════════════════ WIZARD ═══════════════════ */
function initWizard() {
  if (!State.wizard.editingId && Object.keys(State.wizard.data).length === 0) {
    // fresh
    State.wizard.data = { id: uid(), status: 'draft', projects: [] };
    State.wizard.step = 0;
    State.wizard.maxStep = 0;
  }
  renderWizardSteps();
  renderWizardStep();
}

function renderWizardSteps() {
  const list = $('#wizardStepsList');
  const maxStep = State.wizard.maxStep || 0;
  list.innerHTML = WIZARD_STEPS.map((s, i) => {
    const locked = i > maxStep && i !== State.wizard.step;
    return `
    <div class="wizard-step-item ${i === State.wizard.step ? 'active' : ''} ${i < State.wizard.step ? 'completed' : ''} ${locked ? 'locked' : ''}" onclick="goToStep(${i})">
      <div class="wizard-step-num">${i < State.wizard.step ? '✓' : (locked ? '🔒' : s.num)}</div>
      <div class="wizard-step-label">${s.label}</div>
    </div>`;
  }).join('');
  const pct = ((State.wizard.step + 1) / WIZARD_STEPS.length) * 100;
  $('#wizardProgressFill').style.width = pct + '%';
}

function goToStep(i) {
  const maxStep = State.wizard.maxStep || 0;
  if (i > State.wizard.step) {
    // Moving forward via the sidebar is only allowed to already-unlocked steps.
    if (i > maxStep) {
      // Advancing to the very next locked step must pass validation
      if (i === State.wizard.step + 1) { nextStep(); return; }
      toast('Complete the current step to unlock the next ones', 'warning');
      return;
    }
    // target already unlocked — still require the current step to be valid
    if (!saveCurrentStepData(true)) return;
  } else {
    saveCurrentStepData(); // going back / staying — save without blocking
  }
  State.wizard.step = i;
  renderWizardSteps();
  renderWizardStep();
}
function nextStep() {
  if (!saveCurrentStepData(true)) return; // validation gate
  if (State.wizard.step < WIZARD_STEPS.length - 1) {
    State.wizard.step++;
    State.wizard.maxStep = Math.max(State.wizard.maxStep || 0, State.wizard.step);
    renderWizardSteps();
    renderWizardStep();
    toast('Progress autosaved', 'info', 1500);
  }
}
function prevStep() {
  saveCurrentStepData();
  if (State.wizard.step > 0) {
    State.wizard.step--;
    renderWizardSteps();
    renderWizardStep();
  }
}

function renderWizardStep() {
  const step = WIZARD_STEPS[State.wizard.step];
  const content = $('#wizardContent');
  const d = State.wizard.data;
  let html = `<div class="wizard-step-content active">
    <h2 class="wizard-step-heading">${step.heading}</h2>
    <p class="wizard-step-desc">${step.desc}</p>`;

  html += renderStepFields(step.id, d);

  // Nav buttons
  const isLast = State.wizard.step === WIZARD_STEPS.length - 1;
  html += `<div class="wizard-nav">
    <div class="wizard-nav-left">
      ${State.wizard.step > 0 ? `<button class="btn btn-ghost" onclick="prevStep()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg> Previous</button>` : ''}
    </div>
    <div>
      ${isLast
        ? `<button class="btn btn-primary" onclick="submitVendor()">Submit Vendor <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg></button>`
        : `<button class="btn btn-primary" onclick="nextStep()">Save & Continue <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg></button>`}
    </div>
  </div></div>`;

  content.innerHTML = html;
  attachTagInputs();
  attachDocUploads();
}

// Field renderers per step
function renderStepFields(stepId, d) {
  switch (stepId) {
    case 'company': return `
      <div class="form-grid">
        ${textField('companyName', 'Company / Firm Name', d, true)}
        ${textField('brandName', 'Brand Name', d, true)}
        ${selectField('businessType', 'Type of Business', d, ['Proprietorship', 'Partnership', 'Private Limited', 'LLP', 'Public Limited', 'Others'], true)}
        ${textField('yearEstablished', 'Year of Establishment', d, true, 'number', 'e.g. 2018')}
        ${textareaField('natureOfServices', 'Nature of Services', d, true, 'e.g. Video Production, Photography, Post-Production')}
      </div>`;

    case 'contact': {
      // Back-fill the Yes/No for any record that already has these
      if (d.hasWebsite === undefined && d.website) d.hasWebsite = 'Yes';
      if (d.hasInstagram === undefined && d.instagram) d.hasInstagram = 'Yes';
      if (d.hasYoutube === undefined && d.youtube) d.hasYoutube = 'Yes';
      const hasWeb = d.hasWebsite === 'Yes';
      const hasInsta = d.hasInstagram === 'Yes';
      const hasYt = d.hasYoutube === 'Yes';
      return `
      <div class="form-grid">
        ${textField('contactPerson', 'Primary Contact Person', d, true)}
        ${textField('designation', 'Designation', d, true)}
        ${textField('mobile', 'Mobile Number', d, true, 'tel', '10-digit mobile')}
        ${textField('email', 'Email', d, true, 'email', 'name@company.com')}
        ${textField('city', 'City', d, true)}
      </div>
      <div class="form-grid" style="margin-top:16px">
        ${textareaField('officeAddress', 'Office Address', d, true)}
      </div>
      <div class="form-grid form-grid-2" style="margin-top:16px">
        ${radioField('hasWebsite', 'Do you have a website?', d, ['Yes', 'No'])}
        ${hasWeb ? textField('website', 'Website', d, true, 'url', 'https://yoursite.com') : '<div></div>'}
      </div>
      <div class="form-grid form-grid-2" style="margin-top:16px">
        ${radioField('hasInstagram', 'Do you have Instagram?', d, ['Yes', 'No'])}
        ${hasInsta ? textField('instagram', 'Instagram', d, true, 'text', '@handle or URL') : '<div></div>'}
      </div>
      <div class="form-grid form-grid-2" style="margin-top:16px">
        ${radioField('hasYoutube', 'Do you have YouTube?', d, ['Yes', 'No'])}
        ${hasYt ? textField('youtube', 'YouTube', d, true, 'text', 'Channel URL') : '<div></div>'}
      </div>`;
    }

    case 'business': return `
      <div class="form-grid">
        ${textField('yearsExperience', 'Years of Experience', d, true, 'number')}
        ${textField('teamSize', 'Team Size', d, true, 'number')}
        ${textField('portfolioLink', 'Portfolio / Showreel Link', d, false, 'url', 'https://')}
      </div>
      <div class="form-grid" style="margin-top:16px">
        ${textareaField('majorClients', 'Major Clients / Brands', d, false, 'Comma-separated list of past clients')}
      </div>
      <div class="form-section" style="margin-top:24px">
        <div class="form-section-title">Previous / Present Work</div>
        <div id="projectsContainer"></div>
        <button class="btn btn-secondary" onclick="addProject()" style="margin-top:8px" type="button">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14m-7-7h14"/></svg> Add Project
        </button>
      </div>`;

    case 'technical': return `
      <div class="form-section">
        <div class="form-section-title">Camera & Lens</div>
        <div class="form-grid">
          ${tagField('primaryCamera', 'Primary Camera(s)', d)}
          ${tagField('backupCamera', 'Backup Camera(s)', d)}
          ${tagField('lens', 'Lens Kit', d)}
          ${textField('droneModel', 'Drone Model', d, false)}
          ${textField('gimbal', 'Gimbal', d, false)}
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Lighting & Audio</div>
        <div class="form-grid">
          ${tagField('lighting', 'Lighting Equipment', d)}
          ${tagField('audio', 'Audio Equipment', d)}
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Recording & Delivery</div>
        <div class="form-grid">
          ${selectField('recordingResolution', 'Recording Resolution', d, ['HD 1080p', '4K UHD', '6K', '8K', 'RAW'], false)}
          ${textField('frameRates', 'Frame Rates', d, false, 'text', 'e.g. 24/30/60/120 fps')}
          ${textField('turnaroundTime', 'Turnaround Time', d, false, 'text', 'e.g. 3-5 days')}
          ${textField('deliveryFormats', 'Delivery Formats', d, false, 'text', 'e.g. MP4, MOV, ProRes')}
        </div>
      </div>
      <div class="form-section">
        <div class="form-section-title">Post-Production Software</div>
        <div class="form-grid">
          ${tagField('editingSoftware', 'Editing Software', d)}
          ${tagField('aiTools', 'AI Tools Used', d)}
          ${tagField('motionGraphics', 'Motion Graphics Software', d)}
          ${tagField('colourGrading', 'Colour Grading Software', d)}
        </div>
      </div>
      <div class="form-grid" style="margin-top:8px">
        ${radioField('rawFootage', 'Can provide RAW Footage?', d, ['Yes', 'No'])}
        ${radioField('editableFiles', 'Can provide Editable Project Files?', d, ['Yes', 'No'])}
      </div>`;

    case 'creative': return `
      <div class="form-grid">
        ${textField('editingStyle', 'Primary Editing Style', d, false, 'text', 'e.g. Cinematic, Fast-cut, Documentary')}
        ${selectField('urgentDelivery', 'Urgent Delivery Capability', d, ['6 hrs', '12 hrs', '24 hrs', '48 hrs', 'Not available'], false)}
        ${radioField('weekendAvailability', 'Weekend Availability?', d, ['Yes', 'No'])}
        ${radioField('tightDeadline', 'Tight Deadline Capability?', d, ['Yes', 'No'])}
      </div>
      <div class="form-section" style="margin-top:20px">
        <div class="form-section-title">Communication</div>
        <div class="form-grid">
          ${selectField('communicationPlatform', 'Communication Platform', d, ['WhatsApp', 'Email', 'Phone', 'Slack', 'Telegram', 'Multiple'], false)}
          ${textField('feedbackMethod', 'Feedback Method', d, false, 'text', 'e.g. Frame.io, Google Drive comments')}
          ${textField('responseTime', 'Response Time', d, false, 'text', 'e.g. Within 2 hours')}
          ${textField('fileSharingPlatform', 'File Sharing Platform', d, false, 'text', 'e.g. Google Drive, WeTransfer')}
        </div>
      </div>
      <div class="form-grid" style="margin-top:16px">
        ${textareaField('contentSpecialization', 'Content Specialization', d, false, 'e.g. Product films, Events, Ad films, Social media')}
        ${textareaField('uniqueStrengths', 'Unique Editing Strengths', d, false)}
      </div>
      <div class="form-grid" style="margin-top:16px">
        ${textareaField('bestVideos', 'Best 3 Video Links', d, false, 'One link per line')}
      </div>`;

    case 'commercial': return `
      <div class="pricing-cards">
        ${priceCard('productionCost', 'Production Cost', '(incl. GST)')}
        ${priceCard('travelCharges', 'Travel Charges', 'per project')}
      </div>
      <div class="form-grid">
        ${radioField('rateCard', 'Rate Card Attached?', d, ['Yes', 'No'])}
        ${radioField('gstIncluded', 'GST Included in Pricing?', d, ['Yes', 'No'])}
        ${selectField('paymentTerms', 'Payment Terms', d, ['100% Advance', '50% Advance, 50% on Delivery', '30% Advance, 70% on Delivery', 'Net 15 Days', 'Net 30 Days', 'Milestone-based'], false)}
        ${selectField('currency', 'Currency', d, ['INR (₹)', 'USD ($)', 'EUR (€)'], false)}
      </div>`;

    case 'bank': return `
      <div class="bank-card">
        <div class="bank-card-logo">${esc(d.bankName || 'Bank Name')}</div>
        <div class="bank-card-account">${maskAccount(d.accountNumber)}</div>
        <div class="bank-card-row">
          <div><div class="bank-card-field-label">Account Holder</div><div class="bank-card-field-val">${esc(d.accountHolder || '—')}</div></div>
          <div><div class="bank-card-field-label">IFSC</div><div class="bank-card-field-val">${esc(d.ifsc || '—')}</div></div>
        </div>
      </div>
      <div class="form-grid">
        ${textField('accountHolder', 'Account Holder Name', d, true)}
        ${textField('bankName', 'Bank Name', d, true)}
        ${textField('accountNumber', 'Account Number', d, true, 'text', 'Enter account number')}
        ${textField('ifsc', 'IFSC Code', d, true, 'text', 'e.g. HDFC0001234')}
      </div>
      <div id="ifscVerify" class="bank-ifsc-verify" style="display:none">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        Valid IFSC format
      </div>`;

    case 'legal': return `
      <div class="form-grid">
        ${textField('gstNumber', 'GST Number', d, false, 'text', 'Leave blank if not GST-registered')}
        ${textField('panNumber', 'PAN Number', d, true, 'text', '10-character PAN')}
      </div>
      <div class="form-hint" style="margin-top:12px">PAN is required. GST is optional — leave it blank if the vendor isn't GST-registered. Anything entered is checked for correct format and for duplicates.</div>`;

    case 'documents': return `
      <div class="drag-drop-zone" onclick="toast('Select a document below to attach','info')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
        <h4>Document Upload Center</h4>
        <p>Attach whatever you have — nothing here is mandatory. Supports PDF, DOCX, JPG, PNG, ZIP.</p>
      </div>
      <div class="doc-checklist">
        ${DOC_CHECKLIST.map(doc => docItem(doc, d)).join('')}
      </div>`;

    case 'declaration': return `
      <div class="declaration-box">
        I hereby declare that the information provided is true and accurate to the best of my knowledge, and I agree to comply with all company policies and applicable legal requirements of Fangs Technology Pvt Ltd.
      </div>
      <div class="declaration-check">
        <input type="checkbox" id="declAgree" ${d.declAgree ? 'checked' : ''} onchange="State.wizard.data.declAgree = this.checked; this.closest('.declaration-check').classList.toggle('error', !this.checked)" />
        <label for="declAgree">I confirm that all information and documents provided are accurate and I accept the terms of vendor onboarding.</label>
      </div>
      <div class="form-grid" style="margin-top:16px">
        ${textField('vendorName', 'Vendor Name', d, true)}
        ${textField('authorizedSignatory', 'Authorized Signatory', d, true)}
        ${textField('declarationDate', 'Date', d, true, 'date')}
      </div>
      <div class="form-hint" style="margin-top:16px">Signature & Company Seal will be verified against uploaded documents by the management team.</div>`;

    default: return '';
  }
}

/* ── Field Builders ──
   NOTE: Every field is mandatory for vendor registration, so all builders
   render a required asterisk and data-required flag. ── */
function textField(key, label, d, req, type = 'text', placeholder = '') {
  const val = d[key] !== undefined ? esc(d[key]) : '';
  const required = !OPTIONAL_KEYS.has(key);
  return `<div class="form-group ${['natureOfServices', 'officeAddress'].includes(key) ? 'full' : ''}">
    <label>${label}${required ? '<span class="req">*</span>' : ' <span class="opt-tag">(optional)</span>'}</label>
    <input class="form-input" type="${type}" data-key="${key}" value="${val}" placeholder="${esc(placeholder)}"
      oninput="updateField('${key}', this.value, this)" ${required ? 'data-required="1"' : ''} />
    <span class="field-error" data-error="${key}"></span>
  </div>`;
}
function textareaField(key, label, d, req, placeholder = '') {
  const val = d[key] !== undefined ? esc(d[key]) : '';
  const required = !OPTIONAL_KEYS.has(key);
  return `<div class="form-group full">
    <label>${label}${required ? '<span class="req">*</span>' : ' <span class="opt-tag">(optional)</span>'}</label>
    <textarea class="form-textarea" data-key="${key}" placeholder="${esc(placeholder)}"
      oninput="updateField('${key}', this.value, this)" ${required ? 'data-required="1"' : ''}>${val}</textarea>
    <span class="field-error" data-error="${key}"></span>
  </div>`;
}
function selectField(key, label, d, options, req) {
  const required = !OPTIONAL_KEYS.has(key);
  return `<div class="form-group">
    <label>${label}${required ? '<span class="req">*</span>' : ' <span class="opt-tag">(optional)</span>'}</label>
    <select class="form-select" data-key="${key}" onchange="updateField('${key}', this.value, this)" ${required ? 'data-required="1"' : ''}>
      <option value="">Select…</option>
      ${options.map(o => `<option value="${esc(o)}" ${d[key] === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
    </select>
    <span class="field-error" data-error="${key}"></span>
  </div>`;
}
function radioField(key, label, d, options) {
  return `<div class="form-group">
    <label>${label}<span class="req">*</span></label>
    <div class="radio-group" data-radiokey="${key}">
      ${options.map(o => `<label class="radio-label"><input type="radio" name="${key}" value="${esc(o)}" ${d[key] === o ? 'checked' : ''} onchange="updateField('${key}', '${esc(o)}')" /> ${esc(o)}</label>`).join('')}
    </div>
    <span class="extra-error" data-error="${key}"></span>
  </div>`;
}
function tagField(key, label, d) {
  const tags = d[key] || [];
  const presets = TAG_PRESETS[key] || [];
  return `<div class="form-group full">
    <label>${label}<span class="req">*</span></label>
    <div class="tag-input-container" data-tagkey="${key}">
      ${tags.map(t => tagPill(key, t)).join('')}
      <input class="tag-input" placeholder="Type & press Enter…" data-taginput="${key}" />
    </div>
    ${presets.length ? `<div class="tag-preset-list">${presets.map(p => `<button type="button" class="tag-preset" onclick="addTag('${key}','${esc(p)}')">+ ${esc(p)}</button>`).join('')}</div>` : ''}
    <span class="extra-error" data-error="${key}"></span>
  </div>`;
}
function tagPill(key, val) {
  return `<span class="tag">${esc(val)}<span class="tag-remove" onclick="removeTag('${key}','${esc(val).replace(/'/g, "\\'")}')">&times;</span></span>`;
}
function priceCard(key, label, suffix) {
  const val = State.wizard.data[key] || '';
  return `<div class="pricing-card">
    <div class="pricing-card-label">${label} *</div>
    <input type="text" data-key="${key}" data-required="1" value="${esc(val)}" placeholder="₹0" oninput="updateField('${key}', this.value, this)" />
    <div class="pricing-card-suffix">${suffix}</div>
  </div>`;
}
function docItem(doc, d) {
  const docs = d.documents || {};
  const uploaded = docs[doc.id];
  const iconType = doc.type === 'img' ? 'img' : (doc.type === 'doc' ? 'doc' : 'pdf');
  return `<div class="doc-item ${uploaded ? 'uploaded' : ''}" data-doc="${doc.id}">
    <div class="doc-item-icon ${iconType}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
    </div>
    <div>
      <div class="doc-item-name">${doc.name}</div>
      <div class="doc-item-status" data-doc-status="${doc.id}">${uploaded ? esc(uploaded.name) + ' · ' + uploaded.size : 'Not uploaded'}</div>
    </div>
    <div class="doc-item-actions">
      ${doc.required ? '<span class="doc-recommended">Recommended</span>' : '<span class="doc-optional">Optional</span>'}
      ${uploaded ? '<span class="doc-success-check" data-doc-check="' + doc.id + '">✓</span>' : ''}
      <label class="doc-upload-btn">
        ${uploaded ? 'Replace' : 'Upload'}
        <input type="file" data-docupload="${doc.id}" style="display:none" accept=".pdf,.docx,.doc,.jpg,.jpeg,.png,.zip" />
      </label>
    </div>
  </div>`;
}
function maskAccount(acc) {
  if (!acc) return '•••• •••• •••• ••••';
  const s = String(acc).replace(/\s/g, '');
  if (s.length <= 4) return s;
  return '•••• •••• ' + s.slice(-4).padStart(s.length > 8 ? 8 : s.length, '•').replace(/(.{4})/g, '$1 ').trim();
}

/* ── Field Update Logic ── */
function updateField(key, value, el) {
  State.wizard.data[key] = value;
  // Conditional fields — reveal/hide the linked field based on the Yes/No answer
  const CONDITIONAL = { hasWebsite: 'website', hasInstagram: 'instagram', hasYoutube: 'youtube' };
  if (CONDITIONAL[key]) {
    if (value === 'No') State.wizard.data[CONDITIONAL[key]] = '';
    renderWizardStep();
    return;
  }
  // Live validation
  if (el) validateFieldLive(key, value, el);
  // Clear radio-group required error once an option is chosen
  if (!el && value) {
    const g = document.querySelector(`#wizardContent .radio-group[data-radiokey="${key}"]`);
    if (g) {
      g.classList.remove('error');
      const msg = g.parentElement.querySelector(`.extra-error[data-error="${key}"]`);
      if (msg) { msg.textContent = ''; msg.classList.remove('visible'); }
    }
  }
  // Live bank card update
  if (['bankName', 'accountNumber', 'accountHolder', 'ifsc'].includes(key)) {
    const card = $('.bank-card');
    if (card) {
      $('.bank-card-logo').textContent = State.wizard.data.bankName || 'Bank Name';
      $('.bank-card-account').textContent = maskAccount(State.wizard.data.accountNumber);
      $$('.bank-card-field-val')[0].textContent = State.wizard.data.accountHolder || '—';
      $$('.bank-card-field-val')[1].textContent = State.wizard.data.ifsc || '—';
    }
    if (key === 'ifsc') {
      const verify = $('#ifscVerify');
      if (verify) verify.style.display = Validators.ifsc(value) ? 'flex' : 'none';
    }
  }
}

function validateFieldLive(key, value, el) {
  const errEl = el.parentElement.querySelector(`[data-error="${key}"]`);
  let valid = true, msg = '';
  if (value) {
    if (key === 'email' && !Validators.email(value)) { valid = false; msg = 'Invalid email address'; }
    if (key === 'mobile' && !Validators.phone(value)) { valid = false; msg = 'Enter a valid 10-digit mobile number'; }
    if (key === 'website' && !Validators.website(value)) { valid = false; msg = 'Invalid website URL'; }
    if (key === 'gstNumber' && !Validators.gst(value)) { valid = false; msg = 'Invalid GSTIN format'; }
    if (key === 'panNumber' && !Validators.pan(value)) { valid = false; msg = 'Invalid PAN format'; }
    if (key === 'ifsc' && !Validators.ifsc(value)) { valid = false; msg = 'Invalid IFSC format'; }
    if ((key === 'yearEstablished') && !Validators.year(value)) { valid = false; msg = 'Enter a valid year'; }
    // Duplicate detection
    if (valid && key === 'gstNumber' && Validators.gst(value)) {
      const dup = DataStore.getAll().find(v => v.id !== State.wizard.data.id && (v.gstNumber || '').toUpperCase() === value.toUpperCase());
      if (dup) { valid = false; msg = `Duplicate GST — already registered to ${dup.companyName}`; }
    }
    if (valid && key === 'panNumber' && Validators.pan(value)) {
      const dup = DataStore.getAll().find(v => v.id !== State.wizard.data.id && (v.panNumber || '').toUpperCase() === value.toUpperCase());
      if (dup) { valid = false; msg = `Duplicate PAN — already registered to ${dup.companyName}`; }
    }
  }
  el.classList.toggle('error', !valid);
  if (errEl) { errEl.textContent = msg; errEl.classList.toggle('visible', !valid); }
  return valid;
}

/* ── Tag Input Handling ── */
function attachTagInputs() {
  $$('[data-taginput]').forEach(input => {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        const val = input.value.trim();
        if (val) { addTag(input.dataset.taginput, val); input.value = ''; }
      } else if (e.key === 'Backspace' && !input.value) {
        const key = input.dataset.taginput;
        const tags = State.wizard.data[key] || [];
        if (tags.length) { tags.pop(); State.wizard.data[key] = tags; refreshTagContainer(key); }
      }
    });
  });
  $$('.tag-input-container').forEach(c => {
    c.addEventListener('click', () => c.querySelector('.tag-input')?.focus());
  });
}
function addTag(key, val) {
  const tags = State.wizard.data[key] || [];
  if (!tags.includes(val)) { tags.push(val); State.wizard.data[key] = tags; refreshTagContainer(key); }
}
function removeTag(key, val) {
  State.wizard.data[key] = (State.wizard.data[key] || []).filter(t => t !== val);
  refreshTagContainer(key);
}
function refreshTagContainer(key) {
  const container = $(`.tag-input-container[data-tagkey="${key}"]`);
  if (!container) return;
  const tags = State.wizard.data[key] || [];
  container.querySelectorAll('.tag').forEach(t => t.remove());
  const input = container.querySelector('.tag-input');
  tags.forEach(t => input.insertAdjacentHTML('beforebegin', tagPill(key, t)));
  // Clear the required-error state once the user adds a tag
  if (tags.length) {
    container.classList.remove('error');
    const msg = container.parentElement.querySelector(`.extra-error[data-error="${key}"]`);
    if (msg) { msg.textContent = ''; msg.classList.remove('visible'); }
  }
}

/* ── Doc Upload Handling ── */
function attachDocUploads() {
  $$('[data-docupload]').forEach(input => {
    input.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const docId = input.dataset.docupload;
      const sizeStr = (file.size / 1024 / 1024).toFixed(2) + ' MB';
      if (!State.wizard.data.documents) State.wizard.data.documents = {};
      // NOTE: For Firebase, upload file to Storage here and store the URL.
      State.wizard.data.documents[docId] = { name: file.name, size: sizeStr, uploadedAt: Date.now() };
      const item = $(`.doc-item[data-doc="${docId}"]`);
      item.classList.add('uploaded');
      item.classList.remove('error');
      $(`[data-doc-status="${docId}"]`).textContent = `${file.name} · ${sizeStr}`;
      if (!item.querySelector('.doc-success-check')) {
        const check = document.createElement('span');
        check.className = 'doc-success-check';
        check.textContent = '✓';
        input.closest('.doc-item-actions').insertBefore(check, input.closest('.doc-upload-btn'));
      }
      input.closest('.doc-upload-btn').firstChild.textContent = 'Replace ';
      toast(`${file.name} attached`, 'success', 2000);
    });
  });
}

/* ── Save Current Step ──
   Every field on a step is mandatory. A step cannot be left until all its
   text inputs, dropdowns, tag lists, radios, uploads and (final) declaration
   are complete — this is the hard gate the vendor cannot bypass. ── */
function saveCurrentStepData(validate = false) {
  if (validate) {
    let firstError = null;

    // Reset previous error visuals for this step
    $$('#wizardContent .tag-input-container.error, #wizardContent .radio-group.error, #wizardContent .doc-item.error, #wizardContent .project-row.error, #wizardContent .declaration-check.error')
      .forEach(e => e.classList.remove('error'));
    $$('#wizardContent .extra-error').forEach(e => { e.textContent = ''; e.classList.remove('visible'); });

    // 1) Standard inputs (text / textarea / select / price):
    //    required fields must be filled, and ANY filled field (incl. optional
    //    ones like GST) must still pass its format check.
    $$('#wizardContent [data-key]').forEach(el => {
      const key = el.dataset.key;
      const required = el.hasAttribute('data-required');
      const val = (State.wizard.data[key] || '').toString().trim();
      const errEl = el.parentElement.querySelector(`.field-error[data-error="${key}"]`);
      if (required && !val) {
        el.classList.add('error');
        if (errEl) { errEl.textContent = 'This field is required'; errEl.classList.add('visible'); }
        if (!firstError) firstError = el;
      } else if (val) {
        if (!validateFieldLive(key, val, el) && !firstError) firstError = el;
      } else {
        el.classList.remove('error');
        if (errEl) { errEl.textContent = ''; errEl.classList.remove('visible'); }
      }
    });

    // 2) Step-specific: tags, radios, uploads, projects, declaration
    const stepId = WIZARD_STEPS[State.wizard.step].id;
    const extraFirst = markExtraErrors(stepId);
    if (extraFirst && !firstError) firstError = extraFirst;

    if (firstError) {
      try { firstError.focus({ preventScroll: true }); } catch (e) {}
      firstError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Please complete all required fields on this step', 'error');
      return false;
    }
  }
  // Persist draft to store
  persistDraft();
  return true;
}

// Validate non-standard field types for a step. Returns first errored element (or null).
function markExtraErrors(stepId) {
  const d = State.wizard.data;
  let first = null;

  const tagErr = (key) => {
    if (!(d[key] || []).length) {
      const c = document.querySelector(`#wizardContent .tag-input-container[data-tagkey="${key}"]`);
      const msg = c && c.parentElement.querySelector(`.extra-error[data-error="${key}"]`);
      if (c) c.classList.add('error');
      if (msg) { msg.textContent = 'Add at least one entry'; msg.classList.add('visible'); }
      if (!first) first = c;
    }
  };
  const radioErr = (key) => {
    if (!d[key]) {
      const g = document.querySelector(`#wizardContent .radio-group[data-radiokey="${key}"]`);
      const msg = g && g.parentElement.querySelector(`.extra-error[data-error="${key}"]`);
      if (g) g.classList.add('error');
      if (msg) { msg.textContent = 'Please select an option'; msg.classList.add('visible'); }
      if (!first) first = g;
    }
  };

  switch (stepId) {
    case 'contact':
      ['hasWebsite', 'hasInstagram', 'hasYoutube'].forEach(radioErr);
      break;
    case 'business': {
      const projects = d.projects || [];
      if (!projects.length) {
        const cont = document.querySelector('#projectsContainer');
        if (cont) cont.classList.add('error');
        toast('Add at least one previous / present project', 'error');
        if (!first) first = cont;
      } else {
        projects.forEach((p, i) => {
          const missing = !p.brand || !p.link || !p.status || !p.startDate || !p.description ||
            (p.status === 'Already Worked' && !p.endDate);
          if (missing) {
            const row = document.querySelectorAll('#projectsContainer .project-row')[i];
            if (row) row.classList.add('error');
            if (!first) first = row;
          }
        });
      }
      break;
    }
    case 'technical':
      ['primaryCamera', 'backupCamera', 'lens', 'lighting', 'audio', 'editingSoftware', 'aiTools', 'motionGraphics', 'colourGrading'].forEach(tagErr);
      ['rawFootage', 'editableFiles'].forEach(radioErr);
      break;
    case 'creative':
      ['weekendAvailability', 'tightDeadline'].forEach(radioErr);
      break;
    case 'commercial':
      ['rateCard', 'gstIncluded'].forEach(radioErr);
      break;
    case 'documents':
      // Documents are optional — a vendor uploads whatever they have.
      // Nothing here blocks progression to the declaration step.
      break;
    case 'declaration':
      if (!d.declAgree) {
        const dc = document.querySelector('#wizardContent .declaration-check');
        if (dc) dc.classList.add('error');
        if (!first) first = dc;
      }
      break;
  }
  return first;
}

function persistDraft() {
  const d = State.wizard.data;
  if (!d.status) d.status = 'draft';
  if (Auth.mode === 'admin') {
    // Admin editing an existing vendor — persist to the cloud
    DataStore.save({ ...d });
  } else {
    // Vendor registration draft stays on this device only until Submit
    try { localStorage.setItem(DataStore.DRAFT_KEY, JSON.stringify(d)); } catch (e) {}
  }
}

function saveDraft() {
  saveCurrentStepData();
  persistDraft();
  DataStore.logActivity(`Draft saved for <strong>${esc(State.wizard.data.companyName || 'new vendor')}</strong>`, 'primary');
  toast('Draft saved successfully', 'success');
}

function submitVendor() {
  if (!saveCurrentStepData(true)) return;
  if (!State.wizard.data.declAgree) {
    toast('Please confirm the declaration to submit', 'error');
    return;
  }
  const d = State.wizard.data;
  d.status = 'submitted';
  d.updatedAt = Date.now();
  if (!d.createdAt) d.createdAt = Date.now();
  const refId = (d.id || '').toUpperCase().replace('V_', 'VND-');

  if (!window.FB) { toast('Still connecting to the server — please wait a moment and try again.', 'error'); return; }

  const isVendor = Auth.mode === 'vendor';
  const btn = document.querySelector('#wizardContent .wizard-nav .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  // Write to Firebase (vendor = unauthenticated create; admin = authenticated write)
  window.FB.setVendor(d.id, d)
    .then(() => {
      DataStore.logActivity(`New vendor <strong>${esc(d.companyName)}</strong> submitted for review`, 'green');
      if (isVendor) {
        localStorage.removeItem(DataStore.DRAFT_KEY);
        const ref = $('#successRef');
        if (ref) ref.textContent = 'Reference ID: ' + refId;
        State.wizard = { step: 0, maxStep: 0, editingId: null, data: {} };
        navigate('vendorSuccess');
      } else {
        toast('Vendor saved successfully! 🎉', 'success', 4000);
        State.wizard = { step: 0, maxStep: 0, editingId: null, data: {} };
        navigate('vendors');
      }
    })
    .catch(err => {
      if (btn) { btn.disabled = false; btn.textContent = 'Submit Vendor'; }
      toast('Submission failed: ' + (err.code || err.message) + '. Please try again.', 'error', 6000);
    });
}

function cancelOnboarding() {
  const isVendor = Auth.mode === 'vendor';
  showConfirm({
    icon: '⚠️',
    title: isVendor ? 'Exit registration?' : 'Discard this vendor?',
    message: 'Unsaved changes to this onboarding will be lost.',
    confirmText: isVendor ? 'Exit' : 'Discard',
    onConfirm: () => {
      State.wizard = { step: 0, editingId: null, data: {} };
      if (isVendor) Auth.logout();
      else navigate('dashboard');
    }
  });
}

function editVendor(id) {
  const v = DataStore.get(id);
  if (!v) return;
  // Admin editing an existing vendor may jump between any step freely
  State.wizard = { step: 0, maxStep: WIZARD_STEPS.length - 1, editingId: id, data: JSON.parse(JSON.stringify(v)) };
  closeVendorProfile();
  navigate('onboarding');
  toast(`Editing ${v.companyName}`, 'info');
}

function addProject() {
  if (!State.wizard.data.projects) State.wizard.data.projects = [];
  State.wizard.data.projects.push({ brand: '', link: '', status: 'Already Worked', startDate: '', endDate: '', description: '' });
  renderProjects();
}
function removeProject(idx) {
  State.wizard.data.projects.splice(idx, 1);
  renderProjects();
}
function updateProject(idx, field, value) {
  State.wizard.data.projects[idx][field] = value;
}
function renderProjects() {
  const container = $('#projectsContainer');
  if (!container) return;
  const projects = State.wizard.data.projects || [];
  if (!projects.length) {
    container.innerHTML = `<div class="empty-state small" style="padding:20px"><p>No projects added yet. Click "Add Project" to include past or present work.</p></div>`;
    return;
  }
  container.innerHTML = projects.map((p, i) => `
    <div class="project-row">
      <div class="project-row-header">
        <span class="project-row-num">Project ${i + 1}</span>
        <button class="btn-remove-project" onclick="removeProject(${i})" type="button">✕ Remove</button>
      </div>
      <div class="form-grid form-grid-2">
        <div class="form-group"><label>Brand Name</label><input class="form-input" value="${esc(p.brand)}" oninput="updateProject(${i},'brand',this.value)" /></div>
        <div class="form-group"><label>Project Link</label><input class="form-input" value="${esc(p.link)}" oninput="updateProject(${i},'link',this.value)" placeholder="https://" /></div>
      </div>
      <div class="form-grid form-grid-3" style="margin-top:12px">
        <div class="form-group"><label>Status</label>
          <select class="form-select" onchange="updateProject(${i},'status',this.value)">
            <option ${p.status === 'Already Worked' ? 'selected' : ''}>Already Worked</option>
            <option ${p.status === 'Presently Working' ? 'selected' : ''}>Presently Working</option>
          </select>
        </div>
        <div class="form-group"><label>Start Date</label><input class="form-input" type="date" value="${esc(p.startDate)}" oninput="updateProject(${i},'startDate',this.value)" /></div>
        <div class="form-group"><label>End Date</label><input class="form-input" type="date" value="${esc(p.endDate)}" oninput="updateProject(${i},'endDate',this.value)" /></div>
      </div>
      <div class="form-group full" style="margin-top:12px"><label>Description</label><textarea class="form-textarea" oninput="updateProject(${i},'description',this.value)" placeholder="Brief description of the work">${esc(p.description)}</textarea></div>
    </div>`).join('');
}

/* ═══════════════════ VENDOR PROFILE MODAL ═══════════════════ */
function openVendorProfile(id) {
  if (Auth.mode === 'vendor') return; // vendors cannot open any vendor profile
  const v = DataStore.get(id);
  if (!v) return;
  const score = computeScore(v);
  const modal = $('#vendorProfileModal');
  const content = $('#vendorProfileContent');

  content.innerHTML = `
    <div class="profile-banner">
      <div class="profile-avatar-wrap"><div class="profile-avatar">${esc(initials(v.companyName))}</div></div>
    </div>
    <div class="profile-body">
      <div class="profile-top">
        <div>
          <div class="profile-name">${esc(v.companyName || 'Unnamed Vendor')}</div>
          <div class="profile-type">${esc(v.brandName ? v.brandName + ' · ' : '')}${esc(v.businessType || '')} ${v.city ? '· ' + esc(v.city) : ''}</div>
        </div>
        <div class="profile-top-right">
          <span class="badge ${STATUS_BADGE[v.status]}">${STATUS_LABELS[v.status]}</span>
          ${score.grade ? `<span class="score-badge ${gradeClass(score.grade)}">${score.grade}</span>` : ''}
        </div>
      </div>

      <div class="profile-tabs">
        <button class="profile-tab active" onclick="switchProfileTab(event,'overview')">Overview</button>
        <button class="profile-tab" onclick="switchProfileTab(event,'technical')">Technical</button>
        <button class="profile-tab" onclick="switchProfileTab(event,'commercial')">Commercial</button>
        <button class="profile-tab" onclick="switchProfileTab(event,'documents')">Documents</button>
        <button class="profile-tab" onclick="switchProfileTab(event,'projects')">Projects</button>
        <button class="profile-tab" onclick="switchProfileTab(event,'score')">Admin Score</button>
      </div>

      <div class="profile-tab-content active" data-tab="overview">
        ${profileOverview(v)}
      </div>
      <div class="profile-tab-content" data-tab="technical">
        ${profileTechnical(v)}
      </div>
      <div class="profile-tab-content" data-tab="commercial">
        ${profileCommercial(v)}
      </div>
      <div class="profile-tab-content" data-tab="documents">
        ${profileDocuments(v)}
      </div>
      <div class="profile-tab-content" data-tab="projects">
        ${profileProjects(v)}
      </div>
      <div class="profile-tab-content" data-tab="score">
        ${profileScore(v, score)}
      </div>
    </div>

    <div class="admin-action-bar">
      <button class="btn btn-secondary" onclick="editVendor('${v.id}')">✏️ Edit</button>
      ${v.status !== 'approved' ? `<button class="btn btn-primary" onclick="setVendorStatus('${v.id}','approved')">✓ Approve</button>` : ''}
      ${v.status !== 'rejected' ? `<button class="btn btn-danger" onclick="setVendorStatus('${v.id}','rejected')">✕ Reject</button>` : ''}
      ${v.status !== 'pending' ? `<button class="btn btn-ghost" onclick="setVendorStatus('${v.id}','pending')">⏱ Mark Under Review</button>` : ''}
      ${v.status !== 'blacklisted' ? `<button class="btn btn-ghost" onclick="setVendorStatus('${v.id}','blacklisted')">⛔ Blacklist</button>` : ''}
      ${v.status !== 'archived' ? `<button class="btn btn-ghost" onclick="setVendorStatus('${v.id}','archived')">📦 Archive</button>` : ''}
      <button class="btn btn-ghost" onclick="duplicateVendor('${v.id}')">⧉ Duplicate</button>
      <button class="btn btn-ghost" onclick="printVendor('${v.id}')">🖨 Print</button>
      <button class="btn btn-ghost text-red" onclick="confirmDeleteVendor('${v.id}')">🗑 Delete</button>
    </div>`;

  modal.classList.add('open');
}
function switchProfileTab(e, tab) {
  document.querySelectorAll('.profile-tab').forEach(t => t.classList.remove('active'));
  e.target.classList.add('active');
  document.querySelectorAll('.profile-tab-content').forEach(c => c.classList.toggle('active', c.dataset.tab === tab));
}
function closeVendorProfile(e) {
  if (e && e.target !== e.currentTarget && !e.target.classList.contains('modal-close')) return;
  $('#vendorProfileModal').classList.remove('open');
}

function infoItem(label, val) {
  return `<div class="info-item"><div class="info-label">${label}</div><div class="info-val">${val ? esc(val) : '—'}</div></div>`;
}
function profileOverview(v) {
  return `<div class="info-grid">
    ${infoItem('Contact Person', v.contactPerson)}
    ${infoItem('Designation', v.designation)}
    ${infoItem('Mobile', v.mobile)}
    ${infoItem('Email', v.email)}
    ${infoItem('Website', v.website)}
    ${infoItem('City', v.city)}
    ${infoItem('Year Established', v.yearEstablished)}
    ${infoItem('Years of Experience', v.yearsExperience)}
    ${infoItem('Team Size', v.teamSize)}
    ${infoItem('GST Number', v.gstNumber)}
    ${infoItem('PAN Number', v.panNumber)}
    ${infoItem('Registered On', v.createdAt ? fmtDate(v.createdAt) : '')}
  </div>
  <div style="margin-top:16px">
    ${infoItem('Office Address', v.officeAddress)}
  </div>
  <div class="info-grid" style="margin-top:14px">
    ${infoItem('Major Clients', v.majorClients)}
    ${infoItem('Instagram', v.instagram)}
    ${infoItem('YouTube', v.youtube)}
  </div>`;
}
function profileTechnical(v) {
  const tagList = arr => (arr && arr.length) ? arr.map(t => `<span class="tag">${esc(t)}</span>`).join(' ') : '<span class="text-muted">—</span>';
  return `<div style="display:flex;flex-direction:column;gap:16px">
    <div><div class="info-label">Primary Cameras</div><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${tagList(v.primaryCamera)}</div></div>
    <div><div class="info-label">Lens Kit</div><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${tagList(v.lens)}</div></div>
    <div><div class="info-label">Lighting</div><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${tagList(v.lighting)}</div></div>
    <div><div class="info-label">Audio</div><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${tagList(v.audio)}</div></div>
    <div><div class="info-label">Editing Software</div><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${tagList(v.editingSoftware)}</div></div>
    <div><div class="info-label">AI Tools</div><div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px">${tagList(v.aiTools)}</div></div>
  </div>
  <div class="info-grid" style="margin-top:16px">
    ${infoItem('Drone', v.droneModel)}
    ${infoItem('Gimbal', v.gimbal)}
    ${infoItem('Resolution', v.recordingResolution)}
    ${infoItem('Frame Rates', v.frameRates)}
    ${infoItem('RAW Footage', v.rawFootage)}
    ${infoItem('Editable Files', v.editableFiles)}
    ${infoItem('Turnaround', v.turnaroundTime)}
    ${infoItem('Weekend Availability', v.weekendAvailability)}
    ${infoItem('Urgent Delivery', v.urgentDelivery)}
  </div>`;
}
function profileCommercial(v) {
  return `<div class="pricing-cards">
    <div class="pricing-card"><div class="pricing-card-label">Production Cost</div><div style="font-size:22px;font-weight:800;margin:8px 0">${fmtCurrency(v.productionCost)}</div><div class="pricing-card-suffix">incl. GST</div></div>
    <div class="pricing-card"><div class="pricing-card-label">Travel Charges</div><div style="font-size:22px;font-weight:800;margin:8px 0">${fmtCurrency(v.travelCharges)}</div><div class="pricing-card-suffix">per project</div></div>
  </div>
  <div class="info-grid" style="margin-top:16px">
    ${infoItem('Payment Terms', v.paymentTerms)}
    ${infoItem('Rate Card', v.rateCard)}
    ${infoItem('GST Included', v.gstIncluded)}
    ${infoItem('Currency', v.currency)}
  </div>
  <h3 style="margin:20px 0 12px;font-size:15px">Bank Details</h3>
  <div class="info-grid">
    ${infoItem('Account Holder', v.accountHolder)}
    ${infoItem('Bank Name', v.bankName)}
    ${infoItem('Account Number', v.accountNumber ? maskAccount(v.accountNumber) : '')}
    ${infoItem('IFSC', v.ifsc)}
  </div>`;
}
function profileDocuments(v) {
  const docs = v.documents || {};
  return `<div class="doc-checklist">
    ${DOC_CHECKLIST.map(doc => {
      const up = docs[doc.id];
      return `<div class="doc-item ${up ? 'uploaded' : ''}">
        <div class="doc-item-icon ${doc.type === 'img' ? 'img' : 'pdf'}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></div>
        <div><div class="doc-item-name">${doc.name}</div><div class="doc-item-status">${up ? esc(up.name) + ' · ' + up.size : 'Not submitted'}</div></div>
        <div class="doc-item-actions">${doc.required ? '<span class="doc-recommended">Recommended</span>' : '<span class="doc-optional">Optional</span>'}${up ? '<span class="doc-success-check">✓</span>' : ''}</div>
      </div>`;
    }).join('')}
  </div>`;
}
function profileProjects(v) {
  const projects = v.projects || [];
  if (!projects.length) return `<div class="empty-state small" style="padding:30px"><p>No projects recorded for this vendor.</p></div>`;
  return projects.map((p, i) => `
    <div class="project-row" style="cursor:default">
      <div class="project-row-header">
        <span class="project-row-num">${esc(p.brand || 'Project ' + (i + 1))}</span>
        <span class="badge ${p.status === 'Presently Working' ? 'badge-submitted' : 'badge-approved'}">${esc(p.status)}</span>
      </div>
      ${p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener" class="text-primary" style="font-size:13px">${esc(p.link)}</a>` : ''}
      ${p.description ? `<p style="font-size:13px;color:var(--text2);margin-top:8px">${esc(p.description)}</p>` : ''}
      ${(p.startDate || p.endDate) ? `<div class="info-label" style="margin-top:8px">${esc(p.startDate)} → ${esc(p.endDate || 'Present')}</div>` : ''}
    </div>`).join('');
}
function profileScore(v, score) {
  if (!score.total) return `<div class="empty-state small" style="padding:30px"><p>Score is calculated once the vendor is submitted for review.</p></div>`;
  const maxes = { 'Years of Experience': 12, 'Equipment Quality': 12, 'Creative Capability': 10, 'Client Portfolio': 10, 'Document Completion': 15, 'Communication': 8, 'Delivery Speed': 8, 'AI Adoption': 8, 'Portfolio Quality': 8, 'Commercial Fit': 9 };
  return `<div class="score-panel">
    <div class="score-panel-header">
      <div>
        <div class="score-panel-title">Overall Vendor Score · Admin Only</div>
        <div style="display:flex;align-items:baseline;gap:12px;margin-top:8px">
          <span class="score-big">${score.total}</span>
          <span style="opacity:0.5">/ 100</span>
          <span class="score-grade">${score.grade}</span>
        </div>
      </div>
      <div style="text-align:right">
        <div class="score-panel-title">Risk Level</div>
        <div style="font-size:18px;font-weight:800;margin-top:6px">${score.risk}</div>
      </div>
    </div>
    <div class="score-bars">
      ${score.breakdown.map(([label, val]) => {
        const max = maxes[label] || 10;
        const pct = Math.min(100, Math.round(val / max * 100));
        return `<div class="score-bar-item">
          <div class="score-bar-label">${label}</div>
          <div class="score-bar-track"><div class="score-bar-fill" style="width:${pct}%"></div></div>
          <div class="score-bar-val">${Math.round(val)}</div>
        </div>`;
      }).join('')}
    </div>
  </div>
  <div class="form-hint">This score is computed automatically from submitted data and is visible to administrators only. Vendors never see their score.</div>`;
}

/* ═══════════════════ ADMIN ACTIONS ═══════════════════ */
function setVendorStatus(id, status) {
  const v = DataStore.get(id);
  if (!v) return;
  v.status = status;
  DataStore.save(v);
  const verb = { approved: 'approved', rejected: 'rejected', pending: 'marked under review', blacklisted: 'blacklisted', archived: 'archived' }[status];
  DataStore.logActivity(`<strong>${esc(v.companyName)}</strong> ${verb}`, status === 'approved' ? 'green' : status === 'rejected' ? 'danger' : 'primary');
  toast(`${v.companyName} ${verb}`, status === 'rejected' || status === 'blacklisted' ? 'warning' : 'success');
  openVendorProfile(id); // refresh
  if (State.currentPage === 'vendors') renderVendors();
  if (State.currentPage === 'dashboard') renderDashboard();
}
function duplicateVendor(id) {
  const v = DataStore.get(id);
  if (!v) return;
  const copy = JSON.parse(JSON.stringify(v));
  copy.id = uid();
  copy.companyName = (v.companyName || 'Vendor') + ' (Copy)';
  copy.status = 'draft';
  delete copy.createdAt;
  DataStore.save(copy);
  DataStore.logActivity(`Duplicated <strong>${esc(v.companyName)}</strong>`, 'primary');
  toast('Vendor duplicated', 'success');
  closeVendorProfile();
  navigate('vendors');
}
function printVendor(id) {
  const v = DataStore.get(id);
  if (!v) return;
  const score = computeScore(v);
  const w = window.open('', '_blank');
  const row = (l, val) => `<tr><td style="padding:6px 12px;color:#666;width:220px">${l}</td><td style="padding:6px 12px;font-weight:600">${esc(val || '—')}</td></tr>`;
  w.document.write(`<html><head><title>${esc(v.companyName)} — Vendor Profile</title>
    <style>body{font-family:Inter,Arial,sans-serif;padding:40px;color:#0f172a}h1{color:#1e3a8a}h2{color:#2563eb;border-bottom:2px solid #e5e7eb;padding-bottom:6px;margin-top:24px}table{width:100%;border-collapse:collapse}td{border-bottom:1px solid #f1f5f9;font-size:13px}</style>
    </head><body>
    <h1>${esc(v.companyName)}</h1>
    <p style="color:#666">${esc(v.brandName || '')} · ${esc(v.businessType || '')} · Status: ${STATUS_LABELS[v.status]}${score.grade ? ' · Score: ' + score.total + '/100 (' + score.grade + ')' : ''}</p>
    <h2>Contact</h2><table>${row('Contact Person', v.contactPerson)}${row('Mobile', v.mobile)}${row('Email', v.email)}${row('Website', v.website)}${row('Address', v.officeAddress)}</table>
    <h2>Business</h2><table>${row('Years of Experience', v.yearsExperience)}${row('Team Size', v.teamSize)}${row('Major Clients', v.majorClients)}</table>
    <h2>Commercial</h2><table>${row('Production Cost', fmtCurrency(v.productionCost))}${row('Travel Charges', fmtCurrency(v.travelCharges))}${row('Payment Terms', v.paymentTerms)}</table>
    <h2>Legal</h2><table>${row('GST', v.gstNumber)}${row('PAN', v.panNumber)}</table>
    <h2>Bank</h2><table>${row('Account Holder', v.accountHolder)}${row('Bank', v.bankName)}${row('Account No.', v.accountNumber)}${row('IFSC', v.ifsc)}</table>
    </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 400);
}

/* ═══════════════════ CONFIRM DIALOG ═══════════════════ */
let confirmCallback = null;
function showConfirm({ icon = '⚠️', title, message, confirmText = 'Confirm', onConfirm }) {
  $('#confirmIcon').textContent = icon;
  $('#confirmTitle').textContent = title;
  $('#confirmMessage').textContent = message;
  $('#confirmBtn').textContent = confirmText;
  confirmCallback = onConfirm;
  $('#confirmModal').classList.add('open');
}
function closeConfirm(e) {
  if (e && e.target !== e.currentTarget) return;
  $('#confirmModal').classList.remove('open');
  confirmCallback = null;
}
function executeConfirm() {
  if (confirmCallback) confirmCallback();
  $('#confirmModal').classList.remove('open');
  confirmCallback = null;
}
function confirmDeleteVendor(id) {
  const v = DataStore.get(id);
  if (!v) return;
  showConfirm({
    icon: '🗑️',
    title: `Delete ${v.companyName}?`,
    message: 'This will permanently remove the vendor and all associated data. This action cannot be undone.',
    confirmText: 'Delete Vendor',
    onConfirm: () => {
      DataStore.remove(id);
      DataStore.logActivity(`Deleted vendor <strong>${esc(v.companyName)}</strong>`, 'danger');
      toast('Vendor deleted', 'info');
      closeVendorProfile();
      if (State.currentPage === 'vendors') renderVendors();
      if (State.currentPage === 'dashboard') renderDashboard();
    }
  });
}
function confirmClearData() {
  showConfirm({
    icon: '⚠️',
    title: 'Clear all data?',
    message: 'This will permanently delete ALL vendors and activity. This cannot be undone.',
    confirmText: 'Clear Everything',
    onConfirm: () => {
      DataStore.clearAll();
      toast('All data cleared', 'info');
      navigate('dashboard');
    }
  });
}

/* ═══════════════════ DOCUMENTS PAGE ═══════════════════ */
function renderDocuments() {
  if (Auth.mode === 'vendor') return;
  const vendors = DataStore.getAll().filter(v => v.documents && Object.keys(v.documents).length);
  const container = $('#documentsList');
  if (!vendors.length) {
    container.innerHTML = `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><h3>No documents yet</h3><p>Documents uploaded during vendor onboarding will appear here.</p></div>`;
    return;
  }
  container.innerHTML = vendors.map(v => {
    const docs = v.documents || {};
    return `<div class="doc-vendor-section glass-card">
      <div class="doc-vendor-name">${esc(v.companyName)} <span class="text-muted" style="font-size:13px;font-weight:400">· ${docCompletionPct(v)}% complete</span></div>
      <div class="doc-grid">
        ${Object.entries(docs).map(([docId, file]) => {
          const meta = DOC_CHECKLIST.find(d => d.id === docId);
          return `<div class="doc-card" onclick="toast('In production, this opens ${esc(file.name)}','info')">
            <div class="doc-card-icon">${meta && meta.type === 'img' ? '🖼️' : '📄'}</div>
            <div class="doc-card-name">${meta ? meta.name : docId}</div>
            <div class="doc-card-meta">${esc(file.size)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }).join('');
}

/* ═══════════════════ EXPORT / IMPORT ═══════════════════ */
function exportVendorList() {
  const vendors = DataStore.getAll();
  if (!vendors.length) { toast('No vendors to export', 'warning'); return; }

  // Helpers to flatten arrays / nested data into single CSV cells
  const arr = a => Array.isArray(a) ? a.join('; ') : (a || '');
  const docsList = v => DOC_CHECKLIST.filter(d => (v.documents || {})[d.id])
    .map(d => `${d.name} (${(v.documents[d.id].name) || 'file'})`).join('; ');
  const projList = v => (v.projects || []).map((p, i) =>
    `${p.brand || 'Project ' + (i + 1)} — ${p.link || ''} [${p.status || ''}] ${p.startDate || ''}${p.endDate ? ' to ' + p.endDate : ''}${p.description ? ': ' + p.description : ''}`
  ).join('  ||  ');

  // Every field a vendor fills, in a sensible order, with readable headers
  const cols = [
    ['Company/Firm Name', v => v.companyName],
    ['Brand Name', v => v.brandName],
    ['Type of Business', v => v.businessType],
    ['Year of Establishment', v => v.yearEstablished],
    ['Nature of Services', v => v.natureOfServices],
    ['Contact Person', v => v.contactPerson],
    ['Designation', v => v.designation],
    ['Mobile', v => v.mobile],
    ['Email', v => v.email],
    ['Website', v => v.website],
    ['City', v => v.city],
    ['Office Address', v => v.officeAddress],
    ['Instagram', v => v.instagram],
    ['YouTube', v => v.youtube],
    ['Years of Experience', v => v.yearsExperience],
    ['Team Size', v => v.teamSize],
    ['Major Clients', v => v.majorClients],
    ['Portfolio Link', v => v.portfolioLink],
    ['Previous/Present Work', v => projList(v)],
    ['Primary Camera(s)', v => arr(v.primaryCamera)],
    ['Backup Camera(s)', v => arr(v.backupCamera)],
    ['Drone Model', v => v.droneModel],
    ['Gimbal', v => v.gimbal],
    ['Lighting', v => arr(v.lighting)],
    ['Audio', v => arr(v.audio)],
    ['Lens Kit', v => arr(v.lens)],
    ['Recording Resolution', v => v.recordingResolution],
    ['Frame Rates', v => v.frameRates],
    ['Editing Software', v => arr(v.editingSoftware)],
    ['AI Tools', v => arr(v.aiTools)],
    ['Motion Graphics', v => arr(v.motionGraphics)],
    ['Colour Grading', v => arr(v.colourGrading)],
    ['RAW Footage', v => v.rawFootage],
    ['Editable Files', v => v.editableFiles],
    ['Delivery Formats', v => v.deliveryFormats],
    ['Turnaround Time', v => v.turnaroundTime],
    ['Editing Style', v => v.editingStyle],
    ['Urgent Delivery', v => v.urgentDelivery],
    ['Weekend Availability', v => v.weekendAvailability],
    ['Tight Deadline', v => v.tightDeadline],
    ['Communication Platform', v => v.communicationPlatform],
    ['Feedback Method', v => v.feedbackMethod],
    ['Response Time', v => v.responseTime],
    ['File Sharing Platform', v => v.fileSharingPlatform],
    ['Content Specialization', v => v.contentSpecialization],
    ['Unique Strengths', v => v.uniqueStrengths],
    ['Best Video Links', v => v.bestVideos],
    ['Production Cost', v => v.productionCost],
    ['Travel Charges', v => v.travelCharges],
    ['GST Included', v => v.gstIncluded],
    ['Rate Card', v => v.rateCard],
    ['Payment Terms', v => v.paymentTerms],
    ['Currency', v => v.currency],
    ['Account Holder', v => v.accountHolder],
    ['Bank Name', v => v.bankName],
    ['Account Number', v => v.accountNumber],
    ['IFSC', v => v.ifsc],
    ['GST Number', v => v.gstNumber],
    ['PAN Number', v => v.panNumber],
    ['Documents Provided', v => docsList(v)],
    ['Declaration Name', v => v.vendorName],
    ['Authorized Signatory', v => v.authorizedSignatory],
    ['Declaration Date', v => v.declarationDate],
    ['Status', v => STATUS_LABELS[v.status] || v.status],
    ['Admin Score', v => { const s = computeScore(v); return s.total ? `${s.total}/100 (${s.grade})` : ''; }],
    ['Registered On', v => v.createdAt ? fmtDate(v.createdAt) : ''],
    ['Last Updated', v => v.updatedAt ? fmtDate(v.updatedAt) : '']
  ];

  const cell = val => `"${(val === undefined || val === null ? '' : String(val)).replace(/"/g, '""')}"`;
  const header = cols.map(c => cell(c[0])).join(',');
  const rows = vendors.map(v => cols.map(c => cell(c[1](v))).join(','));
  // BOM + CRLF so Excel opens UTF-8 (₹, names) and rows correctly
  const csv = '﻿' + [header, ...rows].join('\r\n');
  downloadFile(csv, 'vendors_full_export.csv', 'text/csv;charset=utf-8;');
  toast(`Exported ${vendors.length} vendors — all fields`, 'success');
}
// Full vendor report as a print-ready page → "Save as PDF" in the print dialog
function exportVendorsPDF() {
  const vendors = DataStore.getAll();
  if (!vendors.length) { toast('No vendors to export', 'warning'); return; }

  const arr = a => (Array.isArray(a) && a.length) ? a.map(esc).join(', ') : '—';
  const val = x => (x === undefined || x === null || x === '') ? '—' : esc(x);
  const row = (label, value) => `<tr><td class="lbl">${label}</td><td>${value}</td></tr>`;
  const projList = v => (v.projects || []).length
    ? v.projects.map((p, i) => `<div class="proj"><b>${esc(p.brand || 'Project ' + (i + 1))}</b> — ${p.link ? esc(p.link) : ''} [${esc(p.status || '')}] ${esc(p.startDate || '')}${p.endDate ? ' to ' + esc(p.endDate) : ''}${p.description ? '<br>' + esc(p.description) : ''}</div>`).join('')
    : '—';
  const docList = v => {
    const ds = DOC_CHECKLIST.filter(d => (v.documents || {})[d.id]);
    return ds.length ? ds.map(d => `${d.name} (${esc((v.documents[d.id].name) || 'file')})`).join('<br>') : '—';
  };
  const section = (title, rows) => `<h3>${title}</h3><table class="detail">${rows}</table>`;

  const vendorHtml = v => {
    const s = computeScore(v);
    return `<div class="vendor">
      <div class="vhead">
        <div class="vname">${val(v.companyName)}</div>
        <div class="vmeta">${val(v.brandName)} &middot; ${val(v.businessType)} &middot; ${STATUS_LABELS[v.status] || esc(v.status)}${s.total ? ' &middot; Score ' + s.total + '/100 (' + s.grade + ')' : ''}</div>
      </div>
      ${section('Company', row('Company/Firm', val(v.companyName)) + row('Brand', val(v.brandName)) + row('Type', val(v.businessType)) + row('Established', val(v.yearEstablished)) + row('Services', val(v.natureOfServices)))}
      ${section('Contact', row('Contact Person', val(v.contactPerson)) + row('Designation', val(v.designation)) + row('Mobile', val(v.mobile)) + row('Email', val(v.email)) + row('Website', val(v.website)) + row('City', val(v.city)) + row('Address', val(v.officeAddress)) + row('Instagram', val(v.instagram)) + row('YouTube', val(v.youtube)))}
      ${section('Business &amp; Work', row('Experience', val(v.yearsExperience) + (v.yearsExperience ? ' yrs' : '')) + row('Team Size', val(v.teamSize)) + row('Major Clients', val(v.majorClients)) + row('Portfolio', val(v.portfolioLink)) + row('Projects', projList(v)))}
      ${section('Technical', row('Primary Camera', arr(v.primaryCamera)) + row('Backup Camera', arr(v.backupCamera)) + row('Lens', arr(v.lens)) + row('Lighting', arr(v.lighting)) + row('Audio', arr(v.audio)) + row('Drone', val(v.droneModel)) + row('Gimbal', val(v.gimbal)) + row('Resolution', val(v.recordingResolution)) + row('Frame Rates', val(v.frameRates)) + row('Editing Software', arr(v.editingSoftware)) + row('AI Tools', arr(v.aiTools)) + row('Motion Graphics', arr(v.motionGraphics)) + row('Colour Grading', arr(v.colourGrading)) + row('RAW Footage', val(v.rawFootage)) + row('Editable Files', val(v.editableFiles)) + row('Delivery Formats', val(v.deliveryFormats)) + row('Turnaround', val(v.turnaroundTime)))}
      ${section('Creative', row('Editing Style', val(v.editingStyle)) + row('Urgent Delivery', val(v.urgentDelivery)) + row('Weekend Availability', val(v.weekendAvailability)) + row('Tight Deadline', val(v.tightDeadline)) + row('Communication', val(v.communicationPlatform)) + row('Feedback', val(v.feedbackMethod)) + row('Response Time', val(v.responseTime)) + row('File Sharing', val(v.fileSharingPlatform)) + row('Specialization', val(v.contentSpecialization)) + row('Strengths', val(v.uniqueStrengths)) + row('Best Videos', val(v.bestVideos)))}
      ${section('Commercial', row('Production Cost', val(v.productionCost)) + row('Travel Charges', val(v.travelCharges)) + row('GST Included', val(v.gstIncluded)) + row('Rate Card', val(v.rateCard)) + row('Payment Terms', val(v.paymentTerms)) + row('Currency', val(v.currency)))}
      ${section('Bank', row('Account Holder', val(v.accountHolder)) + row('Bank', val(v.bankName)) + row('Account No.', val(v.accountNumber)) + row('IFSC', val(v.ifsc)))}
      ${section('Legal', row('GST', val(v.gstNumber)) + row('PAN', val(v.panNumber)))}
      ${section('Documents Attached', row('Files', docList(v)))}
      ${section('Record', row('Declaration Name', val(v.vendorName)) + row('Signatory', val(v.authorizedSignatory)) + row('Date', val(v.declarationDate)) + row('Registered', v.createdAt ? fmtDate(v.createdAt) : '—') + row('Updated', v.updatedAt ? fmtDate(v.updatedAt) : '—'))}
    </div>`;
  };

  const w = window.open('', '_blank');
  if (!w) { toast('Please allow pop-ups for this site, then try again', 'error', 6000); return; }
  w.document.write(`<html><head><title>Vendor Report</title><meta charset="utf-8"><style>
    *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#0f172a;margin:0;padding:28px}
    .rhead{border-bottom:3px solid #2563eb;padding-bottom:12px;margin-bottom:20px}
    .rhead h1{color:#1e3a8a;margin:0 0 4px;font-size:22px}
    .rhead p{margin:0;color:#666;font-size:12px}
    .vendor{page-break-after:always}
    .vendor:last-child{page-break-after:auto}
    .vhead{background:#1e3a8a;color:#fff;padding:12px 16px;border-radius:8px;margin-bottom:10px}
    .vname{font-size:18px;font-weight:800}
    .vmeta{font-size:12px;opacity:.9;margin-top:2px}
    h3{color:#2563eb;font-size:13px;margin:14px 0 4px;border-bottom:1px solid #e5e7eb;padding-bottom:3px}
    table.detail{width:100%;border-collapse:collapse;font-size:12px}
    table.detail td{padding:4px 8px;border-bottom:1px solid #f1f5f9;vertical-align:top}
    td.lbl{color:#666;width:160px;font-weight:600}
    .proj{margin-bottom:6px}
    @media print{ body{padding:0} }
  </style></head><body>
    <div class="rhead"><h1>Vivo Vendor Onboarding &mdash; Vendor Report</h1>
    <p>Fangs Technology Pvt Ltd &middot; Generated ${esc(new Date().toLocaleString('en-IN'))} &middot; ${vendors.length} vendor(s)</p></div>
    ${vendors.map(vendorHtml).join('')}
  </body></html>`);
  w.document.close();
  setTimeout(() => w.print(), 500);
  toast('Opening report — choose "Save as PDF" in the print dialog', 'info', 5000);
}

function exportAnalytics() {
  const vendors = DataStore.getAll();
  const report = {
    generated: new Date().toISOString(),
    totalVendors: vendors.length,
    approved: vendors.filter(v => v.status === 'approved').length,
    pending: vendors.filter(v => ['pending', 'submitted'].includes(v.status)).length,
    rejected: vendors.filter(v => v.status === 'rejected').length,
    avgScore: (() => { const s = vendors.map(v => computeScore(v).total).filter(Boolean); return s.length ? Math.round(s.reduce((a, b) => a + b) / s.length) : 0; })(),
    vendors: vendors.map(v => ({ name: v.companyName, status: v.status, score: computeScore(v).total, grade: computeScore(v).grade }))
  };
  downloadFile(JSON.stringify(report, null, 2), 'analytics_report.json', 'application/json');
  toast('Analytics report exported', 'success');
}
function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
function importVendors() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        const list = Array.isArray(data) ? data : (data.vendors || []);
        let count = 0;
        list.forEach(v => { if (v.companyName) { if (!v.id) v.id = uid(); DataStore.save(v); count++; } });
        toast(`Imported ${count} vendors`, 'success');
        navigate('vendors');
      } catch { toast('Invalid JSON file', 'error'); }
    };
    reader.readAsText(file);
  };
  input.click();
}

/* ═══════════════════ SEED DEMO DATA ═══════════════════ */
function seedDemoData() {
  if (DataStore.getAll().length) return;
  const demo = [
    {
      id: uid(), status: 'approved', companyName: 'Frame Fusion Studios', brandName: 'FrameFusion',
      businessType: 'Private Limited', yearEstablished: '2017', natureOfServices: 'Video Production, Ad Films, Post-Production',
      contactPerson: 'Arjun Menon', designation: 'Creative Director', mobile: '9876543210', email: 'arjun@framefusion.in',
      website: 'https://framefusion.in', city: 'Chennai', officeAddress: '12 Anna Salai, Chennai, Tamil Nadu, 600002',
      instagram: '@framefusion', youtube: 'FrameFusionStudios',
      yearsExperience: '8', teamSize: '14', majorClients: 'Vivo, Samsung, Titan, Apollo Hospitals',
      portfolioLink: 'https://framefusion.in/reel',
      primaryCamera: ['Sony FX6', 'RED Komodo'], backupCamera: ['Sony A7 IV'], lens: ['Sony G Master', 'Zeiss'],
      lighting: ['Aputure 600D', 'ARRI SkyPanel'], audio: ['Sennheiser MKH416', 'Rode Wireless GO II'],
      droneModel: 'DJI Mavic 3 Cine', gimbal: 'DJI RS3 Pro', recordingResolution: '6K', frameRates: '24/60/120 fps',
      editingSoftware: ['Adobe Premiere Pro', 'DaVinci Resolve', 'After Effects'], aiTools: ['Runway ML', 'Topaz Video AI', 'ElevenLabs'],
      motionGraphics: ['Adobe After Effects', 'Cinema 4D'], colourGrading: ['DaVinci Resolve'],
      rawFootage: 'Yes', editableFiles: 'Yes', turnaroundTime: '3-5 days', deliveryFormats: 'MP4, ProRes, MOV',
      editingStyle: 'Cinematic', urgentDelivery: '24 hrs', weekendAvailability: 'Yes', tightDeadline: 'Yes',
      communicationPlatform: 'Multiple', feedbackMethod: 'Frame.io', responseTime: 'Within 1 hour', fileSharingPlatform: 'Google Drive',
      contentSpecialization: 'Product films, Ad films, Brand stories', uniqueStrengths: 'High-end colour grading and VFX', bestVideos: 'https://youtu.be/demo1',
      productionCost: '150000', travelCharges: '10000', rateCard: 'Yes', gstIncluded: 'Yes', paymentTerms: '50% Advance, 50% on Delivery', currency: 'INR (₹)',
      accountHolder: 'Frame Fusion Studios Pvt Ltd', bankName: 'HDFC Bank', accountNumber: '50100234567890', ifsc: 'HDFC0001234',
      gstNumber: '33AABCF1234E1Z5', panNumber: 'AABCF1234E',
      documents: { companyReg: { name: 'incorporation.pdf', size: '1.2 MB' }, gstCert: { name: 'gst.pdf', size: '0.8 MB' }, panCard: { name: 'pan.jpg', size: '0.3 MB' }, aadhaar: { name: 'aadhaar.jpg', size: '0.4 MB' }, addressProof: { name: 'address.pdf', size: '0.6 MB' }, vendorAgreement: { name: 'agreement.pdf', size: '1.1 MB' }, gstInvoice: { name: 'invoice.pdf', size: '0.5 MB' }, companyProfile: { name: 'profile.pdf', size: '3.2 MB' }, msme: { name: 'msme.pdf', size: '0.7 MB' } },
      projects: [{ brand: 'Vivo TN', link: 'https://youtu.be/vivo1', status: 'Presently Working', startDate: '2025-01-15', endDate: '', description: 'Regional ad film series for Vivo Tamil Nadu.' }],
      declAgree: true, vendorName: 'Arjun Menon', authorizedSignatory: 'Arjun Menon',
      createdAt: Date.now() - 86400000 * 40, updatedAt: Date.now() - 86400000 * 2
    },
    {
      id: uid(), status: 'pending', companyName: 'Lens & Light Media', brandName: 'L&L',
      businessType: 'Partnership', yearEstablished: '2020', natureOfServices: 'Photography, Event Coverage, Social Media Content',
      contactPerson: 'Priya Raghavan', designation: 'Managing Partner', mobile: '9123456780', email: 'priya@lenslight.in',
      website: 'https://lenslight.in', city: 'Coimbatore', officeAddress: '45 RS Puram, Coimbatore, Tamil Nadu, 641002',
      yearsExperience: '5', teamSize: '6', majorClients: 'PSG Group, Local retail brands',
      primaryCamera: ['Sony A7S III', 'Canon R5'], lens: ['Canon RF', 'Sigma Art'],
      lighting: ['Godox', 'Nanlite'], audio: ['Rode Wireless GO II'],
      editingSoftware: ['Adobe Premiere Pro', 'CapCut Pro'], aiTools: ['Descript', 'Adobe Firefly'],
      rawFootage: 'Yes', editableFiles: 'No', turnaroundTime: '5-7 days',
      urgentDelivery: '48 hrs', weekendAvailability: 'Yes', tightDeadline: 'No',
      communicationPlatform: 'WhatsApp', responseTime: 'Within 3 hours', feedbackMethod: 'Google Drive comments',
      contentSpecialization: 'Social media reels, Event photography',
      productionCost: '60000', travelCharges: '5000', rateCard: 'Yes', paymentTerms: '30% Advance, 70% on Delivery', currency: 'INR (₹)',
      accountHolder: 'Lens and Light Media', bankName: 'ICICI Bank', accountNumber: '000401234567', ifsc: 'ICIC0000123',
      gstNumber: '33AAGFL5678K1Z2', panNumber: 'AAGFL5678K',
      documents: { companyReg: { name: 'partnership.pdf', size: '0.9 MB' }, gstCert: { name: 'gst.pdf', size: '0.7 MB' }, panCard: { name: 'pan.jpg', size: '0.3 MB' }, aadhaar: { name: 'aadhaar.jpg', size: '0.4 MB' } },
      projects: [{ brand: 'PSG Tech Fest', link: 'https://instagram.com/p/demo', status: 'Already Worked', startDate: '2024-08-01', endDate: '2024-08-15', description: 'Event coverage and highlight reels.' }],
      createdAt: Date.now() - 86400000 * 12, updatedAt: Date.now() - 86400000 * 1
    },
    {
      id: uid(), status: 'submitted', companyName: 'Pixel Peak Productions', brandName: 'PixelPeak',
      businessType: 'Proprietorship', yearEstablished: '2021', natureOfServices: 'Corporate Videos, Motion Graphics',
      contactPerson: 'Karthik Subramanian', designation: 'Founder', mobile: '9988776655', email: 'karthik@pixelpeak.in',
      city: 'Madurai', officeAddress: '78 KK Nagar, Madurai, Tamil Nadu, 625020',
      yearsExperience: '3', teamSize: '3', majorClients: 'Regional startups',
      primaryCamera: ['Sony FX30'], lens: ['Sony G Master'], lighting: ['Amaran'], audio: ['Boya'],
      editingSoftware: ['DaVinci Resolve', 'Final Cut Pro'], aiTools: ['Kling AI', 'Runway ML'],
      motionGraphics: ['Blender', 'Apple Motion'],
      rawFootage: 'No', editableFiles: 'Yes', turnaroundTime: '7-10 days',
      urgentDelivery: 'Not available', weekendAvailability: 'No', tightDeadline: 'No',
      communicationPlatform: 'Email', responseTime: 'Within 24 hours',
      contentSpecialization: 'Corporate explainer videos, Motion graphics',
      productionCost: '35000', travelCharges: '3000', rateCard: 'No', paymentTerms: '100% Advance', currency: 'INR (₹)',
      gstNumber: '33ABCPK9012M1Z8', panNumber: 'ABCPK9012M',
      documents: { gstCert: { name: 'gst.pdf', size: '0.6 MB' }, panCard: { name: 'pan.jpg', size: '0.3 MB' } },
      createdAt: Date.now() - 86400000 * 4, updatedAt: Date.now() - 86400000 * 4
    }
  ];
  demo.forEach(v => {
    const all = DataStore.getAll();
    all.push(v);
    localStorage.setItem(DataStore.KEY, JSON.stringify(all));
  });
  DataStore.logActivity('Portal initialized with sample vendors', 'primary');
  DataStore.logActivity('<strong>Frame Fusion Studios</strong> approved', 'green');
  DataStore.logActivity('<strong>Lens & Light Media</strong> marked under review', 'primary');
}

/* ═══════════════════ KEYBOARD SHORTCUTS ═══════════════════ */
document.addEventListener('keydown', e => {
  // Cmd/Ctrl + K → focus search
  if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
    e.preventDefault();
    $('#globalSearch').focus();
  }
  // Esc → close modals
  if (e.key === 'Escape') {
    $('#vendorProfileModal').classList.remove('open');
    $('#confirmModal').classList.remove('open');
    $('#notifDropdown').classList.remove('open');
    $('#searchDropdown').classList.remove('visible');
  }
  // Alt+N → new vendor
  if (e.altKey && e.key === 'n') { e.preventDefault(); navigate('onboarding'); }
});

// Close dropdowns on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.topnav-search')) $('#searchDropdown').classList.remove('visible');
  if (!e.target.closest('.notif-btn') && !e.target.closest('.notif-dropdown')) $('#notifDropdown').classList.remove('open');
});

/* ═══════════════════ INIT ═══════════════════ */
function init() {
  // Theme
  const savedTheme = localStorage.getItem('vendoriq_theme');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  // Dashboard date
  $('#dashDate').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  $('#authYear').textContent = new Date().getFullYear();

  // Wire Firebase auth state → admin view. (No demo seeding: real data only.)
  const startAuth = () => {
    window.FB.onAuth(user => {
      if (user) {
        Auth.enterAdmin();
      } else {
        // Signed out — keep an in-progress vendor session, otherwise show the gate
        if (!document.body.classList.contains('mode-vendor')) {
          document.body.classList.remove('mode-admin');
          Auth.showLanding();
        }
      }
    });
  };
  if (window.FB) startAuth();
  else window.addEventListener('fb-ready', startAuth, { once: true });

  // Fallback: if Firebase is slow/unreachable, still show the landing gate
  setTimeout(() => {
    if (!document.body.classList.contains('mode-admin') && !document.body.classList.contains('mode-vendor')) {
      Auth.showLanding();
    }
  }, 1500);

  // Re-render charts on resize (debounced)
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (State.currentPage === 'dashboard') renderCharts();
      if (State.currentPage === 'analytics') renderAnalytics();
    }, 250);
  });
}

// Hook: when projects step renders, populate projects container
const _origRenderWizardStep = renderWizardStep;
renderWizardStep = function () {
  _origRenderWizardStep();
  if (WIZARD_STEPS[State.wizard.step].id === 'business') renderProjects();
};

document.addEventListener('DOMContentLoaded', init);
