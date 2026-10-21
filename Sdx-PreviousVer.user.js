// ==UserScript==
// @name         SDx Previous Document Version Finder
// @namespace    bmcd-sdx-Previous
// @version      3.0.1
// @description  Finds previous SDx document versions and consolidated (previously reviewed) renditions, and opens the consolidated PDF side by side with the document under review.
// @author       Josue Gutierrez
// @match        https://bum04-sdx.intergraphsmartcloud.com/*
// @match        https://sdx-qarc.burnsmcd.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @grant        GM_getResourceText
// @resource     pdfjsLib    https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js#sha256-W1eZ5vjGgGYyB6xbQu4U7tKkBvp69I9QwVTwwLFWaUY=
// @resource     pdfjsWorker https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js#sha256-/qvfMJdw7SS7oxpUZ4Ns3Iz2OccFryfVK1hbBBu4Uns=
// ==/UserScript==
/*
 * SDx Previous Document Version Finder
 *
 * What it does
 *  - Finds earlier revisions and consolidated renditions (documents
 *    returned after a previous review round) for the document you are
 *    reviewing, using the SDx REST API with your own signed-in session.
 *  - Adds a "Prev Doc Ver" button to the Bluebeam toolbar row of the
 *    reviewer pane (including the "Perform Consolidation" route).
 *  - Checks automatically in the background when a document is opened
 *    and, on an exact consolidated match, shows a small popup offering
 *    to open it side by side.
 *  - Side-by-side viewer (PDF.js): docked beside the document under
 *    review, keeps the Document Summary pane, synced page-by-page
 *    scroll, zoom follow/entry, Download, Open in tab, Tiled window.
 *    It is tied to the review tab it was opened in.
 *
 * How it is built
 *  - One script, three roles: the top SDx page (full UI), the extension
 *    frame on sdx-qarc.burnsmcd.com (reads the Document Summary, lays out
 *    the dock, reports the active tab) and the nested SDx viewer frames
 *    (toolbar button, scroll and zoom reporting). The roles talk through
 *    origin-checked postMessage.
 *  - Generic by design: nothing is hardcoded to a user, token or project.
 *    The project is read from the page URL, the token is captured from
 *    the user's own SDx traffic, and tenant-wide constants can be changed
 *    under Settings > Advanced.
 *
 * Security notes
 *  - The bearer token is only ever sent to the SDx origin it came from.
 *    Captured tokens must look like a JWT, are checked for expiry, and are
 *    kept in this origin's session/local storage (as the sibling SDx
 *    scripts do so new tabs can reuse it). Copy Debug never includes it.
 *  - All text from the page, API and PDF reaches the DOM via textContent
 *    or escapeHtml. OData values are quote-escaped; entity and method
 *    identifiers are restricted to [A-Za-z0-9_].
 *  - postMessage handlers check origin and source and validate every
 *    field; messages are only posted to a fixed target origin.
 *  - PDF.js 3.11.174 is pinned with Subresource Integrity hashes and runs
 *    with isEvalSupported:false (the documented mitigation for
 *    CVE-2024-4367). That release line no longer receives fixes; revisit
 *    this pin if PDF.js ships a classic-script build again.
 *  - Files are fetched only over https; opened links must be https.
 *
 * Changelog
 *  3.0.0  Consolidated release. Full code and security audit, changelog
 *         cleaned up, dead code and the unused PDF.js 6.x loader removed,
 *         hardcoded fallback project removed. New: no automatic popup when
 *         the tab already has a side-by-side open.
 *  2.x    Reviewer-pane support (Perform Consolidation route); toolbar
 *         button via companion frames; docked side-by-side layout that keeps
 *         the Document Summary pane; automatic background check and popup;
 *         PDF.js viewer with page-by-page scroll sync, zoom follow, zoom
 *         entry, Download; per-tab side-by-side; Add Document list handling.
 *  1.x    Search for previous revisions via the OData API, consolidated
 *         rendition lookup and PDF opening, token capture with expiry
 *         checks and cross-tab sharing, strict document-number matching,
 *         user settings (outside-click close, idle timeout, result count).
 */
(function () {
  'use strict';
  /********************************************************************
   * TOP WINDOW ONLY
   *
   * Prevent duplicate buttons inside SDx embedded review/markup frames.
   ********************************************************************/
  const TOP_ORIGIN = 'https://bum04-sdx.intergraphsmartcloud.com';
  const FRAME_ORIGIN = 'https://sdx-qarc.burnsmcd.com';
  // Inside the SDx extension frame this script runs as a light
  // "companion" (toolbar button, page text, viewer layout) - see
  // startFrameModule(), launched at the bottom once everything it
  // depends on has been initialized. Any other frame: do nothing.
  const IS_COMPANION = window.top !== window.self;
  const IS_QARC_COMPANION = IS_COMPANION && window.location.origin === FRAME_ORIGIN && window.parent === window.top;
  const IS_VIEWER_COMPANION = IS_COMPANION && window.location.origin === TOP_ORIGIN;
  if (IS_COMPANION && !IS_QARC_COMPANION && !IS_VIEWER_COMPANION) {
    return;
  }
  /********************************************************************
   * SETTINGS
   ********************************************************************/
  // Intentionally empty: the project is always read from the page URL
  // (see detectProjectConfigUid/refreshProjectConfig below) because every
  // user works in their own projects. The UI flags when none is detected.
  const FALLBACK_PROJECT_CONFIG_UID = '';
  const SETTINGS = {
    buttonRightPx: 330,
    buttonBottomPx: 22,
    // Only show helper on review document pages.
    requireViewAndMarkupRoute: true,
    // projectConfigUid/Value are re-detected per document (see
    // refreshProjectConfig) - the values here are just the initial
    // fallback before the first detection runs.
    projectConfigUid: FALLBACK_PROJECT_CONFIG_UID,
    projectConfigValue: FALLBACK_PROJECT_CONFIG_UID.replace(/^PR_/i, ''),
    // These look like tenant-wide constants (same "AllDocuments"
    // report and "HistoryViewRoute" method definition) rather than
    // per-project - unlike the project UID above, there's no per-page
    // signal to auto-detect them from. Overwritten at boot from
    // USER_SETTINGS.advancedEntityType/advancedHistoryMethodObid in
    // case a different project ever needs different values (see the
    // Settings panel's Advanced section).
    entityType: 'AllDocuments_68290',
    consolidatedEntityType: 'bmcdConsolidatedDocRenditions',
    // Confirmed against a live SDx browse URL - this entity does NOT
    // appear to have Alt_Doc_Name/Title/Attached_File, so filtering on
    // those (like the main entity) causes a blanket 400 on every query.
    consolidatedSearchFields: ['Name'],
    // Confirmed via live network capture: resolves a rendition's Id
    // to a viewable File OBID, which RetrieveFileUris then exchanges
    // for a direct file URL.
    consolidatedFileCompositionPath: 'SPFFileComposition_21',
    // Keep API broad enough to find revisions, but visible list short.
    top: 50,
    minScore: 18,
    maxDisplayedResults: 12, // overwritten at boot from USER_SETTINGS
    openInBackground: false,
    historyMethodObid: '001A64A',
    // Treat a token as expired this many ms before its real exp claim,
    // so we swap it out before the server rejects it.
    tokenExpirySkewMs: 30000,
    // Small pause between successive API search queries.
    requeryDelayMs: 120
  };
  const HARD_MAX_RESULTS = 20;
  /********************************************************************
   * USER-CONFIGURABLE SETTINGS (persisted locally, per browser)
   ********************************************************************/
  // Key name is versioned so a future change of the settings shape can
  // start clean.
  const SETTINGS_STORAGE_KEY = 'sdx-prevsub-user-settings-v2';
  const DEFAULT_USER_SETTINGS = {
    // Closing when you click outside the popup (or into the SDx
    // viewer iframe) is the originally-requested default-on behavior.
    closeOnOutsideClick: true,
    // The idle/inactivity timer is the part that was too aggressive -
    // off by default, opt in via Settings.
    idleTimeoutEnabled: false,
    autoCloseSeconds: 20,
    maxDisplayedResults: 5,
    // Advanced/escape-hatch overrides - see the SETTINGS comment above
    // for why these (unlike the project UID) aren't auto-detected.
    advancedEntityType: 'AllDocuments_68290',
    advancedHistoryMethodObid: '001A64A',
    dockRightOffsetPx: 0,
    autoCheckConsolidated: true
  };
  function clampNumber(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  function cleanIdentifier(value, fallback) {
    const text = String(value === undefined || value === null ? '' : value).trim();
    return /^[A-Za-z0-9_]{1,64}$/.test(text) ? text : fallback;
  }
  function loadUserSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return { ...DEFAULT_USER_SETTINGS };
      const parsed = JSON.parse(raw);
      return {
        closeOnOutsideClick: parsed.closeOnOutsideClick === undefined ? DEFAULT_USER_SETTINGS.closeOnOutsideClick : Boolean(parsed.closeOnOutsideClick),
        idleTimeoutEnabled: Boolean(parsed.idleTimeoutEnabled),
        autoCloseSeconds: clampNumber(parsed.autoCloseSeconds, 0, 600, DEFAULT_USER_SETTINGS.autoCloseSeconds),
        maxDisplayedResults: clampNumber(parsed.maxDisplayedResults, 1, HARD_MAX_RESULTS, DEFAULT_USER_SETTINGS.maxDisplayedResults),
        advancedEntityType: cleanIdentifier(parsed.advancedEntityType, DEFAULT_USER_SETTINGS.advancedEntityType),
        advancedHistoryMethodObid: cleanIdentifier(parsed.advancedHistoryMethodObid, DEFAULT_USER_SETTINGS.advancedHistoryMethodObid),
        dockRightOffsetPx: clampNumber(parsed.dockRightOffsetPx, 0, 1200, 0),
        autoCheckConsolidated: parsed.autoCheckConsolidated === undefined ? true : Boolean(parsed.autoCheckConsolidated)
      };
    } catch {
      return { ...DEFAULT_USER_SETTINGS };
    }
  }
  function saveUserSettings(next) {
    const clamped = {
      closeOnOutsideClick: Boolean(next.closeOnOutsideClick),
      idleTimeoutEnabled: Boolean(next.idleTimeoutEnabled),
      autoCloseSeconds: clampNumber(next.autoCloseSeconds, 0, 600, DEFAULT_USER_SETTINGS.autoCloseSeconds),
      maxDisplayedResults: clampNumber(next.maxDisplayedResults, 1, HARD_MAX_RESULTS, DEFAULT_USER_SETTINGS.maxDisplayedResults),
      advancedEntityType: cleanIdentifier(next.advancedEntityType, DEFAULT_USER_SETTINGS.advancedEntityType),
      advancedHistoryMethodObid: cleanIdentifier(next.advancedHistoryMethodObid, DEFAULT_USER_SETTINGS.advancedHistoryMethodObid),
      dockRightOffsetPx: clampNumber(next.dockRightOffsetPx, 0, 1200, 0),
      autoCheckConsolidated: Boolean(next.autoCheckConsolidated)
    };
    try { localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(clamped)); } catch { /* non-fatal */ }
    Object.assign(USER_SETTINGS, clamped);
    SETTINGS.maxDisplayedResults = USER_SETTINGS.maxDisplayedResults;
    SETTINGS.entityType = USER_SETTINGS.advancedEntityType;
    SETTINGS.historyMethodObid = USER_SETTINGS.advancedHistoryMethodObid;
    return clamped;
  }
  const USER_SETTINGS = loadUserSettings();
  SETTINGS.maxDisplayedResults = USER_SETTINGS.maxDisplayedResults;
  SETTINGS.entityType = USER_SETTINGS.advancedEntityType;
  SETTINGS.historyMethodObid = USER_SETTINGS.advancedHistoryMethodObid;
  /********************************************************************
   * PROJECT DETECTION
   *
   * The project config UID is re-derived from the current page's own
   * URL on every load and route change, rather than trusted from a
   * hardcoded value. This mirrors the same `config=["PR_XXXXXX"]` segment
   * this script already reads/writes when building its own links
   * (buildHistoryViewUrlFromObid, buildDocumentsListUrl, etc).
   ********************************************************************/
  let projectConfigDetected = false;
  function detectProjectConfigUid(url) {
    try {
      const decoded = decodeURIComponent(url || window.location.href);
      const match = decoded.match(/config=(\[[^\]]*\])/i);
      if (!match) return null;
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed) && parsed.length) {
        const candidate = String(parsed[0] || '').trim();
        if (/^PR_\d+$/i.test(candidate)) return candidate;
      }
    } catch {
      // non-fatal - fall through to the caller's fallback
    }
    return null;
  }
  function refreshProjectConfig() {
    const detectedUid = detectProjectConfigUid(window.location.href);
    if (detectedUid) {
      SETTINGS.projectConfigUid = detectedUid;
      SETTINGS.projectConfigValue = detectedUid.replace(/^PR_/i, '');
      projectConfigDetected = true;
    } else {
      SETTINGS.projectConfigUid = FALLBACK_PROJECT_CONFIG_UID;
      SETTINGS.projectConfigValue = FALLBACK_PROJECT_CONFIG_UID.replace(/^PR_/i, '');
      projectConfigDetected = false;
    }
  }
  refreshProjectConfig();
  /********************************************************************
   * ROUTE HELPERS
   ********************************************************************/
  function isViewAndMarkupRoute() {
    return /#\/viewAndMarkup(?:;|$)/i.test(window.location.href);
  }
  // The reviewer pane has moved between routes across SDx releases:
  // classic #/viewAndMarkup, and the newer extensibility host
  // #/external;...;MethodName=BMcD_PerformConsolidation (or other
  // review-style methods).
  function isReviewExternalRoute() {
    let href = window.location.href;
    try { href = decodeURIComponent(href); } catch { /* use raw */ }
    return /#\/external;/i.test(href) && /MethodName=[^;]*(consolidat|review)/i.test(href);
  }
  function shouldShowHelper() {
    if (!SETTINGS.requireViewAndMarkupRoute) return true;
    return isViewAndMarkupRoute() || isReviewExternalRoute();
  }
  function removeUi() {
    hideToast();
    removeLaunchers();
    document.querySelector('#sdx-prevsub-panel')?.remove();
    document.querySelector('#sdx-prevsub-scroll-top')?.remove();
    dockStates.clear();
    closeDock();
  }
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  /********************************************************************
   * SDx AUTH CAPTURE
   *
   * This is why this
   * section differs from a simple "grab one header and cache it"
   * approach.
   ********************************************************************/
  const AUTH_STORAGE_KEY = 'sdx-prevsub-auth';             // legacy, tab-scoped
  const AUTH_SHARED_STORAGE_KEY = 'sdx-shared-auth-token'; // cross-tab
  let sdxCapturedAuthorization = '';
  let sdxCapturedAt = 0;

  function base64UrlDecode(input) {
    try {
      let str = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
      while (str.length % 4) str += '=';
      const decoded = atob(str);
      return decodeURIComponent(
        decoded.split('').map(c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
      );
    } catch {
      return '';
    }
  }
  function decodeJwtPayload(bearerOrToken) {
    try {
      const token = String(bearerOrToken || '').replace(/^Bearer\s+/i, '').trim();
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const json = base64UrlDecode(parts[1]);
      if (!json) return null;
      return JSON.parse(json);
    } catch {
      return null;
    }
  }
  function getTokenExpiryMs(bearerOrToken) {
    const payload = decodeJwtPayload(bearerOrToken);
    if (!payload || !payload.exp) return null;
    return payload.exp * 1000;
  }
  function isTokenExpired(bearerOrToken, skewMs) {
    const expMs = getTokenExpiryMs(bearerOrToken);
    if (expMs === null) return false; // unknown expiry - don't block on it
    return Date.now() > (expMs - (skewMs || 0));
  }
  function formatExpiry(bearerOrToken) {
    const expMs = getTokenExpiryMs(bearerOrToken);
    if (expMs === null) return 'unknown expiry';
    const diffMin = Math.round((expMs - Date.now()) / 60000);
    return diffMin >= 0 ? `expires in ~${diffMin}m` : `expired ~${Math.abs(diffMin)}m ago`;
  }
  function persistAuthorization(text) {
    try { sessionStorage.setItem(AUTH_STORAGE_KEY, text); } catch { /* non-fatal */ }
    try { localStorage.setItem(AUTH_SHARED_STORAGE_KEY, text); } catch { /* non-fatal */ }
  }
  function rememberAuthorization(value) {
    if (!value) return;
    const text = String(value).trim();
    if (!/^Bearer\s+eyJ/i.test(text)) return;
    if (sdxCapturedAuthorization === text) return;
    // If we already hold a still-valid token, only replace it with one
    // that lives at least as long (avoids a stray stale token from a
    // background call clobbering a good one).
    if (sdxCapturedAuthorization && !isTokenExpired(sdxCapturedAuthorization, 0)) {
      const existingExp = getTokenExpiryMs(sdxCapturedAuthorization);
      const newExp = getTokenExpiryMs(text);
      if (existingExp !== null && newExp !== null && newExp <= existingExp) return;
    }
    sdxCapturedAuthorization = text;
    sdxCapturedAt = Date.now();
    persistAuthorization(text);
  }
  function extractAuthorizationFromHeaders(headers) {
    if (!headers) return '';
    try {
      if (headers instanceof Headers) {
        return headers.get('authorization') || headers.get('Authorization') || '';
      }
      if (Array.isArray(headers)) {
        const found = headers.find(([k]) => String(k).toLowerCase() === 'authorization');
        return found ? found[1] : '';
      }
      if (typeof headers === 'object') {
        return headers.authorization || headers.Authorization || '';
      }
    } catch {
      return '';
    }
    return '';
  }
  function scanCookiesForBearer() {
    try {
      const cookieText = document.cookie || '';
      const bearerMatch = cookieText.match(/Bearer\s+(eyJ[A-Za-z0-9_\-.]+)/i);
      if (bearerMatch) return `Bearer ${bearerMatch[1]}`;
      const jwtMatch = cookieText.match(/\b(eyJ[A-Za-z0-9_\-.]+)\b/);
      if (jwtMatch && jwtMatch[1].split('.').length === 3) return `Bearer ${jwtMatch[1]}`;
    } catch {
      // non-fatal
    }
    return '';
  }
  function scanStorageForBearer() {
    const stores = [localStorage, sessionStorage];
    const found = [];
    for (const store of stores) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        const value = store.getItem(key) || '';
        const bearerMatch = value.match(/Bearer\s+(eyJ[A-Za-z0-9_\-.]+)/i);
        if (bearerMatch) {
          found.push(`Bearer ${bearerMatch[1]}`);
          continue;
        }
        const jwtMatch = value.match(/\b(eyJ[A-Za-z0-9_\-.]+)\b/);
        if (jwtMatch && jwtMatch[1].split('.').length === 3) {
          found.push(`Bearer ${jwtMatch[1]}`);
        }
      }
    }
    const cookieHit = scanCookiesForBearer();
    if (cookieHit) found.push(cookieHit);
    if (!found.length) return '';
    // Prefer the candidate with the furthest-out (or unknown) expiry.
    const uniqueFound = [...new Set(found)];
    uniqueFound.sort((a, b) => {
      const ea = getTokenExpiryMs(a);
      const eb = getTokenExpiryMs(b);
      if (ea === null && eb === null) return 0;
      if (ea === null) return -1;
      if (eb === null) return 1;
      return eb - ea;
    });
    return uniqueFound[0];
  }
  function getAuthorizationHeader(options) {
    const forceRescan = Boolean(options && options.forceRescan);
    if (!forceRescan && sdxCapturedAuthorization && !isTokenExpired(sdxCapturedAuthorization, SETTINGS.tokenExpirySkewMs)) {
      return sdxCapturedAuthorization;
    }
    // In-memory token missing/expired, or a rescan was requested -
    // widen the search across every source we know about.
    const candidates = [];
    try {
      const fromLocal = localStorage.getItem(AUTH_SHARED_STORAGE_KEY) || '';
      if (fromLocal) candidates.push(fromLocal);
    } catch { /* non-fatal */ }
    try {
      const fromSession = sessionStorage.getItem(AUTH_STORAGE_KEY) || '';
      if (fromSession) candidates.push(fromSession);
    } catch { /* non-fatal */ }
    const scanned = scanStorageForBearer();
    if (scanned) candidates.push(scanned);
    if (sdxCapturedAuthorization) candidates.push(sdxCapturedAuthorization);
    const uniqueCandidates = [...new Set(candidates.filter(Boolean))];
    if (!uniqueCandidates.length) return '';
    const fresh = uniqueCandidates.find(t => !isTokenExpired(t, SETTINGS.tokenExpirySkewMs));
    const chosen = fresh || uniqueCandidates[0];
    rememberAuthorization(chosen);
    return chosen;
  }
  function invalidateAuthorization() {
    sdxCapturedAuthorization = '';
    sdxCapturedAt = 0;
    try { sessionStorage.removeItem(AUTH_STORAGE_KEY); } catch { /* non-fatal */ }
    // Deliberately leave the shared localStorage key alone here - another
    // tab may still be relying on it, and getAuthorizationHeader will
    // simply skip it next time if it really is expired.
  }
  function getAuthorizationStatus() {
    const token = sdxCapturedAuthorization || getAuthorizationHeader();
    if (!token) return { state: 'missing', label: 'No token captured yet' };
    if (isTokenExpired(token, 0)) return { state: 'expired', label: `Token expired (${formatExpiry(token)})` };
    return { state: 'ok', label: `Token captured (${formatExpiry(token)})` };
  }
  // Only tokens sent to the SDx origin itself are captured (never a
  // token the page sends to some other service).
  function isSdxUrl(url) {
    try { return new URL(String(url), window.location.href).origin === TOP_ORIGIN; } catch { return false; }
  }
  function installAuthSniffer() {
    if (window.fetch && !window.fetch.__sdxPrevSubWrapped) {
      const originalFetch = window.fetch;
      const wrappedFetch = function (input, init) {
        try {
          if (isSdxUrl(input instanceof Request ? input.url : String(input && input.url || input))) {
            rememberAuthorization(extractAuthorizationFromHeaders(init && init.headers));
            if (input instanceof Request) {
              rememberAuthorization(input.headers.get('authorization'));
            }
          }
        } catch {
          // non-fatal
        }
        return originalFetch.apply(this, arguments);
      };
      wrappedFetch.__sdxPrevSubWrapped = true;
      window.fetch = wrappedFetch;
    }
    if (window.XMLHttpRequest && !XMLHttpRequest.prototype.__sdxPrevSubWrapped) {
      const originalOpen = XMLHttpRequest.prototype.open;
      const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__sdxPrevSubUrl = url;
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
          if (String(name).toLowerCase() === 'authorization' && isSdxUrl(this.__sdxPrevSubUrl)) {
            rememberAuthorization(value);
          }
        } catch {
          // non-fatal
        }
        return originalSetRequestHeader.apply(this, arguments);
      };
      XMLHttpRequest.prototype.__sdxPrevSubWrapped = true;
    }
    // Pick up a token captured by this script (or a sibling SDx script
    // sharing the same origin) in a *different* tab/window, live.
    if (!window.__sdxPrevSubStorageListener) {
      window.__sdxPrevSubStorageListener = true;
      window.addEventListener('storage', e => {
        if (!e || !e.newValue) return;
        if (e.key === AUTH_SHARED_STORAGE_KEY || e.key === AUTH_STORAGE_KEY) {
          rememberAuthorization(e.newValue);
        }
      });
    }
  }
  if (!IS_COMPANION) installAuthSniffer();
  // Seed from whatever is already available (own storage, a sibling
  // script's storage, or cookies) before the first native SDx call.
  sdxCapturedAuthorization = getAuthorizationHeader() || '';
  /********************************************************************
   * STYLES
   ********************************************************************/
  function addStyles() {
    if (document.querySelector('#sdx-prevsub-style')) return;
    const css = `
      #sdx-prevsub-btn {
        position: fixed;
        right: ${SETTINGS.buttonRightPx}px;
        bottom: ${SETTINGS.buttonBottomPx}px;
        z-index: 2147483647;
        border: 1px solid #6546b5;
        background: linear-gradient(135deg, #2a155f, #6c4bd3);
        color: #fff;
        border-radius: 999px;
        padding: 8px 12px;
        font-size: 12px;
        font-family: Segoe UI, Arial, sans-serif;
        cursor: pointer;
        box-shadow: 0 4px 12px rgba(0,0,0,0.25);
        opacity: 0.95;
      }
      #sdx-prevsub-btn.in-ribbon {
        position: static;
        height: 28px;
        padding: 0 12px;
        margin: 0 10px 0 0;
        border-radius: 14px;
        font: 700 12px "Segoe UI", Arial, sans-serif;
        white-space: nowrap;
        flex: 0 0 auto;
        box-shadow: none;
        opacity: 1;
      }
      #sdx-prevsub-btn:hover {
        opacity: 1;
        transform: translateY(-1px);
      }
      #sdx-prevsub-panel {
        position: fixed;
        right: ${SETTINGS.buttonRightPx}px;
        bottom: ${SETTINGS.buttonBottomPx + 44}px;
        z-index: 2147483647;
        width: 740px;
        max-width: calc(100vw - 30px);
        max-height: 80vh;
        overflow: auto;
        background: #fff;
        color: #1f1f1f;
        border: 1px solid #d0d0d0;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.28);
        padding: 12px;
        font-family: Segoe UI, Arial, sans-serif;
        font-size: 12px;
        display: none;
      }
      #sdx-prevsub-panel h3 {
        margin: 0;
        font-size: 14px;
      }
      #sdx-prevsub-panel .sdx-row {
        margin: 7px 0;
        line-height: 1.35;
      }
      #sdx-prevsub-panel code {
        background: #f2f2f2;
        padding: 2px 4px;
        border-radius: 4px;
        word-break: break-word;
      }
      #sdx-prevsub-panel button {
        margin-top: 8px;
        margin-right: 6px;
        border: 1px solid #6c4bd3;
        background: #6c4bd3;
        color: white;
        border-radius: 5px;
        padding: 6px 8px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
      }
      #sdx-prevsub-panel button.secondary {
        background: white;
        color: #4a2ea8;
      }
      #sdx-prevsub-panel button.best {
        background: #0a7f28;
        border-color: #0a7f28;
      }
      #sdx-prevsub-panel button.warn {
        background: #9a5a00;
        border-color: #9a5a00;
      }
      .sdx-prevsub-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 8px;
      }
      .sdx-prevsub-close-btn {
        background: transparent !important;
        border: none !important;
        color: #888 !important;
        font-size: 18px !important;
        line-height: 1 !important;
        padding: 0 4px !important;
        margin: 0 !important;
        cursor: pointer;
        font-weight: 700 !important;
      }
      .sdx-prevsub-close-btn:hover {
        color: #a80000 !important;
      }
      #sdx-prevsub-run {
        display: block;
        width: 100%;
        box-sizing: border-box;
        padding: 10px 12px;
        font-size: 13px;
      }
      .sdx-prevsub-btn-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-top: 8px;
      }
      .sdx-prevsub-btn-grid button {
        margin: 0;
        width: 100%;
        box-sizing: border-box;
        padding: 5px 6px;
        font-size: 11px;
      }
      .sdx-prevsub-settings-box {
        display: none;
        border: 1px solid #ddd;
        border-radius: 8px;
        padding: 10px;
        margin: 8px 0;
        background: #f8f8fb;
      }
      .sdx-prevsub-settings-box input[type=number] {
        width: 80px;
        padding: 4px 6px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 12px;
      }
      .sdx-prevsub-settings-box label.sdx-prevsub-checkbox-row {
        display: flex;
        align-items: center;
        gap: 6px;
        font-weight: 400;
      }
      .sdx-prevsub-settings-box input[type=text] {
        width: 100%;
        box-sizing: border-box;
        padding: 4px 6px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-size: 12px;
      }
      .sdx-prevsub-advanced-label {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px dashed #ccc;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.03em;
        color: #888;
      }
      #sdx-prevsub-progress {
        display: none;
        height: 6px;
        border-radius: 3px;
        background: #e6e2f7;
        overflow: hidden;
        margin: 6px 0 2px 0;
      }
      #sdx-prevsub-progress-fill {
        height: 100%;
        width: 0%;
        background: linear-gradient(90deg, #6c4bd3, #9a5ad3);
        transition: width 0.2s ease;
      }
      #sdx-prevsub-status {
        margin-top: 8px;
        color: #555;
        font-size: 11px;
      }
      .sdx-prevsub-query {
        display: inline-block;
        margin: 2px 4px 2px 0;
      }
      .sdx-prevsub-result {
        border: 1px solid #ddd;
        border-radius: 7px;
        padding: 8px;
        margin: 7px 0;
        background: #fafafa;
      }
      .sdx-prevsub-rev {
        border: 1px solid #d8d8d8;
        border-left: 4px solid #6c4bd3;
        border-radius: 7px;
        padding: 8px;
        margin: 7px 0;
        background: #fff;
      }
      .sdx-prevsub-rev.previous {
        border-left-color: #0a7f28;
        background: #f7fff8;
      }
      .sdx-prevsub-rev.current {
        border-left-color: #9a5a00;
        background: #fffaf0;
      }
      .sdx-prevsub-rev.unknown {
        border-left-color: #6c4bd3;
        background: #fbfaff;
      }
      .sdx-prevsub-result-title {
        font-weight: 600;
        font-size: 13px;
        margin-bottom: 4px;
      }
      .sdx-prevsub-muted {
        color: #666;
      }
      .sdx-prevsub-good {
        color: #0a7f28;
        font-weight: 600;
      }
      .sdx-prevsub-warn {
        color: #9a5a00;
        font-weight: 600;
      }
      .sdx-prevsub-bad {
        color: #a80000;
        font-weight: 600;
      }
      .sdx-prevsub-consolidated-box {
        border: 2px solid #c0392b;
        background: #fdecea;
        border-radius: 8px;
        padding: 10px;
        margin: 4px 0 14px 0;
      }
      .sdx-prevsub-consolidated-title {
        color: #a80000;
        font-weight: 700;
        font-size: 13px;
        margin-bottom: 6px;
      }
      .sdx-prevsub-consolidated-row {
        border: 1px solid #eab5ae;
        background: #fff;
        border-radius: 6px;
        padding: 8px;
        margin: 6px 0;
      }
      .sdx-prevsub-consolidated-row button.best {
        background: #a80000;
        border-color: #a80000;
      }
      #sdx-prevsub-dock {
        position: fixed;
        bottom: 0;
        z-index: 2147483000;
        display: flex;
        flex-direction: column;
        background: #fff;
        border-left: 1px solid #c8c8c8;
        box-shadow: none;
        font-family: Arial, sans-serif;
      }
      .sdx-prevsub-dock-handle {
        position: absolute;
        left: -8px;
        top: 0;
        bottom: 0;
        width: 10px;
        cursor: ew-resize;
        z-index: 1;
      }
      .sdx-prevsub-dock-bar {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 4px 8px;
        background: #f5f5f5;
        border-bottom: 1px solid #ddd;
        color: #333;
        font-size: 12px;
      }
      .sdx-prevsub-dock-bar span {
        flex: 1;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .sdx-prevsub-dock-bar button {
        border: 1px solid #2d7fb8;
        background: #fff;
        color: #2d7fb8;
        border-radius: 4px;
        font-size: 11px;
        padding: 3px 8px;
        cursor: pointer;
      }
      #sdx-prevsub-dock-body {
        flex: 1;
        min-height: 0;
        font-size: 12px;
        color: #555;
        padding: 0;
      }
      #sdx-prevsub-dock-body iframe {
        width: 100%;
        height: 100%;
        border: 0;
      }
      #sdx-prevsub-scroll-top {
        position: fixed;
        right: ${SETTINGS.buttonRightPx + 14}px;
        bottom: ${SETTINGS.buttonBottomPx + 58}px;
        z-index: 2147483647;
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 1px solid #6546b5;
        background: #6c4bd3;
        color: #fff;
        font-size: 15px;
        line-height: 30px;
        text-align: center;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(0,0,0,0.3);
        padding: 0;
        margin: 0;
        display: none;
      }
    `;
    if (typeof GM_addStyle === 'function') {
      GM_addStyle(css);
    } else {
      const style = document.createElement('style');
      style.id = 'sdx-prevsub-style';
      style.textContent = css;
      document.head.appendChild(style);
    }
  }
  /********************************************************************
   * UTILITIES
   ********************************************************************/
  function cleanText(value) {
    return String(value || '')
      .replace(//g, '-')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function unique(items) {
    return [...new Set(items.map(x => cleanText(x)).filter(Boolean))];
  }
  // --- scroll helpers (used on both sides of the sync) ---
  function findScrollElementIn(win) {
    try {
      const doc = win.document;
      try {
        const dv = win.Core && win.Core.documentViewer;
        const el = dv && dv.getScrollViewElement && dv.getScrollViewElement();
        if (el && el.scrollHeight > el.clientHeight + 20) return el;
      } catch { /* try DOM lookups */ }
      for (const sel of ['#DocumentContainer', '.DocumentContainer', '[id*="DocumentContainer" i]']) {
        const el = doc.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight + 20) return el;
      }
      let best = null;
      doc.querySelectorAll('div').forEach(el => {
        if (el.clientHeight > 200 && el.scrollHeight > el.clientHeight * 1.5) {
          const oy = win.getComputedStyle(el).overflowY;
          if (/auto|scroll/.test(oy) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
        }
      });
      return best;
    } catch {
      return null;
    }
  }
  function getScrollFraction(el) {
    const max = el.scrollHeight - el.clientHeight;
    return max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
  }
  function pageAnchor(el, pages) {
    if (!pages || !pages.length) return null;
    const er = el.getBoundingClientRect();
    for (let i = 0; i < pages.length; i++) {
      const r = pages[i].getBoundingClientRect();
      if (r.bottom > er.top + 1) return { p: i, pf: r.height > 0 ? Math.min(1, Math.max(0, (er.top - r.top) / r.height)) : 0 };
    }
    return { p: pages.length - 1, pf: 1 };
  }
  function setPageAnchor(el, pages, p, pf) {
    if (!pages || !pages.length) return false;
    const pg = pages[Math.min(Math.max(0, p), pages.length - 1)];
    if (!pg) return false;
    const er = el.getBoundingClientRect();
    const r = pg.getBoundingClientRect();
    el.scrollTop += (r.top - er.top) + Math.min(1, Math.max(0, pf)) * r.height;
    return true;
  }
  function setScrollFraction(el, f) {
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = Math.min(1, Math.max(0, f)) * max;
  }
  // Companion running inside the SDx viewAndMarkup frame (nested under
  // the sdx-qarc frame): owns the toolbar button.
  function startViewerModule() {
    const isPdftronFrame = /\/viewers\/pdftron\//i.test(window.location.pathname);
    const viewerPages = () => {
      try {
        const list = Array.from(document.querySelectorAll('[id^="pageContainer"], .pageContainer'))
          .filter((el, i, arr) => arr.indexOf(el) === i && el.getBoundingClientRect().height > 0);
        const num = el => { const m = /(\d+)$/.exec(el.id || ''); return m ? Number(m[1]) : NaN; };
        if (list.every(el => Number.isFinite(num(el)))) list.sort((a, b) => num(a) - num(b));
        return list;
      } catch { return []; }
    };
    let scrollEl = null;
    let suppressUntil = 0;
    let scrollRaf = 0;
    let lastZoomSent = 0;
    let urlTick = 0;
    let showLauncher = false;
    let lastError = '';
    const tabKey = () => {
      const re = /ContextObjectOBIDs=%5B%22([A-Za-z0-9]+)%22/;
      try { const m = re.exec(window.location.href); if (m) return m[1]; } catch { /* ignore */ }
      try { const m = re.exec(window.parent.location.href); if (m) return m[1]; } catch { /* ignore */ }
      return '';
    };
    const post = msg => {
      try { window.top.postMessage(Object.assign({ prevsub: true, from: 'viewer', tab: tabKey() }, msg), TOP_ORIGIN); } catch { /* non-fatal */ }
    };
    const rectOf = el => {
      const r = el.getBoundingClientRect();
      const off = getTopOffset(el);
      return [r.left + off.left, r.top + off.top, r.right + off.left, r.bottom + off.top].map(Math.round);
    };
    if (isPdftronFrame) {
      // Report this viewer's own URL/config (so the dock can open a
      // second copy of it) and its scroll position (for synced scroll).
      let zoomDiag = '';
      const readZoom = () => {
        const pct = /^(\d{1,3}(?:\.\d+)?)\s*%$/;
        try {
          let best = null;
          const els = document.querySelectorAll('button,span,input,div,a,label');
          for (const el of els) {
            const raw = el.tagName === 'INPUT' ? String(el.value || '') : String(el.textContent || '');
            const t = raw.replace(/[\s\u00a0]+/g, ' ').trim();
            if (t.length > 8) continue;
            const m = pct.exec(t) || (el.tagName === 'INPUT' && /^\d{1,3}$/.test(t) && /zoom/i.test(`${el.id} ${el.className} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-element') || ''}`) ? [t, t] : null);
            if (!m) continue;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0 || r.top > 260) continue;
            if (!best || el.getElementsByTagName('*').length < best.n) best = { z: parseFloat(m[1]) / 100, n: el.getElementsByTagName('*').length };
          }
          if (best) { zoomDiag = 'toolbar text'; return { z: best.z, src: 'toolbar' }; }
          zoomDiag = 'no % text found in toolbar';
        } catch (err) { zoomDiag = `dom scan error: ${String(err && err.message || err).slice(0, 60)}`; }
        try {
          const cands = [
            window.Core && window.Core.documentViewer,
            window.instance && window.instance.Core && window.instance.Core.documentViewer,
            window.instance && window.instance.UI && window.instance.UI.getZoomLevel ? { getZoomLevel: () => window.instance.UI.getZoomLevel() } : null,
            window.instance && window.instance.getZoomLevel ? { getZoomLevel: () => window.instance.getZoomLevel() } : null
          ];
          for (const dv of cands) {
            if (!dv || typeof dv.getZoomLevel !== 'function') continue;
            const z = dv.getZoomLevel();
            if (z > 0) { zoomDiag += '; api ok'; return { z, src: 'api' }; }
          }
          zoomDiag += '; api: no usable getZoomLevel';
        } catch (err) { zoomDiag += `; api error: ${String(err && err.message || err).slice(0, 60)}`; }
        return null;
      };
      let zoomDiagSent = '';
      setInterval(() => {
        const zr = readZoom();
        if (zr && Math.abs(zr.z - lastZoomSent) > 0.001) { lastZoomSent = zr.z; post({ type: 'zoom', z: zr.z, src: zr.src, diag: zoomDiag }); }
        else if (!zr && zoomDiag !== zoomDiagSent) { zoomDiagSent = zoomDiag; post({ type: 'zoom-diag', diag: zoomDiag }); }
      }, 400);
      setInterval(() => {
        try {
          if (urlTick++ % 3 === 0) post({ type: 'viewer-url', url: window.location.href });

          const el = findScrollElementIn(window);
          if (el && el !== scrollEl) {
            scrollEl = el;
            el.addEventListener('scroll', () => {
              if (Date.now() < suppressUntil || scrollRaf) return;
              scrollRaf = requestAnimationFrame(() => {
                scrollRaf = 0;
                const a = pageAnchor(el, viewerPages());
                post({ type: 'scroll', f: getScrollFraction(el), p: a ? a.p : undefined, pf: a ? a.pf : undefined });
              });
            }, { passive: true });
          }
        } catch { /* non-fatal */ }
      }, 1000);
    }
    setInterval(() => {
      try {
        const c = findToolbarContainer();
        let el = c ? c.querySelector('#' + LAUNCHER_ID) : null;
        if (c && showLauncher && !el) {
          el = buildLauncher(c.ownerDocument, true, {
            press: () => post({ type: 'launcher-press' }),
            click: () => post({ type: 'toggle-panel', rect: rectOf(el) })
          });
          c.appendChild(el);
        }
        if (el && !showLauncher) { el.remove(); el = null; }
        if (el && c.lastElementChild !== el) c.appendChild(el); // keep it glued to the right end
        let rect = el ? rectOf(el) : null;
        if (rect && (rect[2] - rect[0] <= 0 || rect[3] - rect[1] <= 0)) rect = null;
        post({
          type: 'status',
          present: Boolean(rect),
          rect,
          ribbon: (() => {
            if (!c) return null;
            let t = c;
            const p = c.parentElement;
            if (p && p.getBoundingClientRect().height <= 64) t = p;
            return rectOf(t);
          })(),
          diag: {
            version: '3.0.0',
            where: 'viewer frame',
            showLauncher,
            containerFound: Boolean(c),
            href: window.location.href.slice(0, 120),
            frames: describeFrames(document, 0).slice(0, 8),
            lastError
          }
        });
      } catch (err) {
        lastError = String(err && err.message || err).slice(0, 200);
        post({ type: 'status', present: false, rect: null, diag: { version: '3.0.0', where: 'viewer frame', lastError } });
      }
    }, 1000);
    window.addEventListener('message', e => {
      if (e.origin !== TOP_ORIGIN || e.source !== window.top) return;
      const d = e.data;
      if (!d || d.prevsub !== true) return;
      if (d.type === 'state') {
        showLauncher = Boolean(d.show);
      } else if (d.type === 'scroll-set' && scrollEl && (Number.isFinite(d.f) || Number.isFinite(d.p))) {
        suppressUntil = Date.now() + 250;
        const pgs = Number.isFinite(d.p) ? viewerPages() : [];
        if (!(pgs.length && setPageAnchor(scrollEl, pgs, d.p, Number.isFinite(d.pf) ? d.pf : 0))) setScrollFraction(scrollEl, d.f);
      }
    });
  }
  // Companion instance running inside the sdx-qarc frame (direct child
  // of the top window only).
  function startFrameModule() {
    if (window.parent !== window.top) return;
    let showLauncher = false;
    const post = msg => {
      try { window.parent.postMessage(Object.assign({ prevsub: true }, msg), TOP_ORIGIN); } catch { /* non-fatal */ }
    };
    const rectOf = el => {
      const r = el.getBoundingClientRect();
      const off = getTopOffset(el);
      return [r.left + off.left, r.top + off.top, r.right + off.left, r.bottom + off.top].map(Math.round);
    };
    // --- page text reporter
    let lastText = '';
    setInterval(() => {
      try {
        const text = cleanText(document.body ? document.body.innerText : '').slice(0, 20000);
        if (text && text !== lastText) {
          lastText = text;
          post({ type: 'sdx-prevsub-frame-text', text });
        }
      } catch { /* non-fatal */ }
    }, 1500);
    // --- launcher in the Bluebeam toolbar row
    let lastError = '';
    const countRibbonish = () => {
      let n = 0;
      walkDocs(document, d => { try { n += d.querySelectorAll('[class*="ribbon" i]').length; } catch { /* ignore */ } return null; }, 0);
      return n;
    };
    setInterval(() => {
      try {
        const c = findToolbarContainer();
        const vf = findViewerFrameEl();
        const vr = vf ? vf.getBoundingClientRect() : null;
        post({
          type: 'status',
          present: false,
          rect: null,
          viewerFrameRect: vr ? [vr.left, vr.top, vr.right, vr.bottom].map(Math.round) : null,
          diag: {
            version: '3.0.0',
            where: 'qarc frame',
            showLauncher,
            containerFound: Boolean(c),
            ribbonish: countRibbonish(),
            frames: describeFrames(document, 0).slice(0, 12),
            lastError
          }
        });
      } catch (err) {
        lastError = String(err && err.message || err).slice(0, 200);
        post({ type: 'status', present: false, rect: null, diag: { version: '3.0.0', where: 'qarc frame', lastError } });
      }
    }, 1000);
    setInterval(() => {
      try { post({ type: 'tabstate', activeTab: tabKeyOfFrame(findViewerFrameEl()), overlay: addDocumentOpen() }); } catch { /* non-fatal */ }
    }, 300);
    // --- messages from the top page
    window.addEventListener('message', e => {
      if (e.origin !== TOP_ORIGIN || e.source !== window.parent) return;
      const d = e.data;
      if (!d || d.prevsub !== true) return;
      if (d.type === 'state') {
        showLauncher = Boolean(d.show);
      } else if (d.type === 'dock-layout') {
        frameDockLayout(d);
      } else if (d.type === 'dock-restore') {
        restoreViewerColumn();
        dockGeom = null;
      }
    });
    function frameDockLayout(msg) {
      if (msg.fresh || !dockGeom) {
        restoreViewerColumn();
        const rect = findRightPaneRect();
        const rightOffset = Number(msg.rightOffset) > 0 ? Number(msg.rightOffset) : (rect ? Math.round(rect.width) : 380);
        const rightLeft = window.innerWidth - rightOffset;
        const col = findViewerColumn(rightLeft);
        const cr = col ? col.getBoundingClientRect() : null;
        const saved = {};
        if (col) {
          for (const prop of COL_PROPS) saved[prop] = { value: col.style.getPropertyValue(prop), priority: col.style.getPropertyPriority(prop) };
        }
        dockGeom = {
          col, saved, rightLeft,
          colLeft: cr ? Math.round(cr.left) : 0,
          top: cr ? Math.round(cr.top) : (rect ? Math.max(0, Math.round(rect.top)) : 48),
          bottom: cr ? Math.round(cr.bottom) : window.innerHeight
        };
      }
      const g = dockGeom;
      const available = Math.max(400, g.rightLeft - g.colLeft);
      const requested = Number(msg.width) > 0 ? Number(msg.width) : Math.round(available * 0.5);
      const width = Math.min(Math.max(280, requested), available - 300);
      if (g.col) {
        const colW = Math.round(available - width);
        g.col.style.setProperty('width', `${colW}px`, 'important');
        g.col.style.setProperty('min-width', '0', 'important');
        g.col.style.setProperty('max-width', `${colW}px`, 'important');
        g.col.style.setProperty('flex', '0 0 auto', 'important');
      g.col.style.setProperty('margin-right', `${Math.round(width)}px`, 'important');
      }
      post({ type: 'dock-geometry', geom: { rightLeft: g.rightLeft, colLeft: g.colLeft, top: g.top, bottom: g.bottom, width, hasCol: Boolean(g.col) } });
    }
  }
  let frameText = '';
  function allowedMessageOrigins() {
    const set = allowedFrameOrigins();
    set.add(TOP_ORIGIN); // the viewer frame shares the SDx origin
    return set;
  }
  function allowedFrameOrigins() {
    // Only the known extension frame origin is trusted (a link's own
    // apiParam1 value is attacker-controllable, so it is not used).
    return new Set([FRAME_ORIGIN]);
  }
  // State reported by the companion instance inside the extension frame.
  let frameStatusAt = 0;
  let frameDiag = null;
  let viewerStatusAt = 0;
  let pdftronUrl = '';
  let pdftronWindow = null;
  let activeTab = '';
  let overlayOpen = false;
  let dockTabKey = '';
  let dockReopening = false;
  const dockStates = new Map();
  let dockMode = 'none';
  let dockNote = '';
  let dockSyncOn = true;
  let dockIgnoreUntil = 0;
  let dockScrollEl = null;
  let dockTimers = [];
  let viewerLauncherRect = null;
  let qarcViewerRect = null;
  let viewerDiag = null;
  let frameDockGeom = null;
  function findQarcFrame() {
    const allowed = allowedFrameOrigins();
    for (const f of document.querySelectorAll('iframe')) {
      try {
        if (allowed.has(new URL(f.src, window.location.href).origin)) return f;
      } catch { /* ignore */ }
    }
    return null;
  }
  function frameModeActive() {
    return Date.now() - frameStatusAt < 5000 && Boolean(findQarcFrame());
  }
  function postToFrame(msg) {
    const f = findQarcFrame();
    if (!f || !f.contentWindow) return;
    try {
      f.contentWindow.postMessage(Object.assign({ prevsub: true }, msg), new URL(f.src, window.location.href).origin);
    } catch { /* ignore */ }
  }
  // Absolute (top-window) rectangle of the launcher button inside the
  // viewer frame: qarc frame position + viewer frame position inside it
  // + button position inside the viewer frame.
  function placedLauncherRect() {
    if (Date.now() - viewerStatusAt > 5000 || !viewerLauncherRect || !qarcViewerRect) return null;
    const f = findQarcFrame();
    if (!f) return null;
    const fr = f.getBoundingClientRect();
    const v = qarcViewerRect;
    const l = viewerLauncherRect;
    return [fr.left + v[0] + l[0], fr.top + v[1] + l[1], fr.left + v[0] + l[2], fr.top + v[1] + l[3]];
  }
  const isRect = r => Array.isArray(r) && r.length === 4 && r.every(Number.isFinite);
  window.addEventListener('message', e => {
    if (!allowedMessageOrigins().has(e.origin)) return;
    const d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type === 'sdx-prevsub-frame-text' && typeof d.text === 'string') {
      if (e.origin !== TOP_ORIGIN) frameText = d.text.slice(0, 20000);
      return;
    }
    if (d.prevsub !== true) return;
    const fromViewer = d.from === 'viewer';
    if (d.type === 'tabstate' && !fromViewer && e.origin !== TOP_ORIGIN) {
      activeTab = typeof d.activeTab === 'string' ? d.activeTab : '';
      overlayOpen = Boolean(d.overlay);
      return;
    }
    const staleTab = fromViewer && Boolean(activeTab) && Boolean(d.tab) && d.tab !== activeTab;
    if (fromViewer && d.type !== 'status' && staleTab) return;
    if (d.type === 'status') {
      const diag = (() => { try { return d.diag ? JSON.parse(JSON.stringify(d.diag)) : null; } catch { return null; } })();
      if (fromViewer && staleTab) {
        /* background tab: ignore its toolbar report */
      } else if (fromViewer) {
        viewerStatusAt = Date.now();
        viewerLauncherRect = d.present && isRect(d.rect) ? d.rect : null;
        try {
          const abs = placedLauncherRect();
          if (abs && viewerLauncherRect && isRect(d.ribbon)) {
            const dy = abs[1] - viewerLauncherRect[1];
            const nr = [d.ribbon[1] + dy, d.ribbon[3] + dy];
            if (!ribbonAbs || ribbonAbs[0] !== nr[0] || ribbonAbs[1] !== nr[1]) { ribbonAbs = nr; applyDockHeights(); }
          }
        } catch { /* ignore */ }
        viewerDiag = diag;
      } else if (e.origin !== TOP_ORIGIN) {
        frameStatusAt = Date.now();
        frameDiag = diag;
        qarcViewerRect = isRect(d.viewerFrameRect) ? d.viewerFrameRect : null;
      } else {
        return;
      }
      try { e.source.postMessage({ prevsub: true, type: 'state', show: shouldShowHelper() }, e.origin); } catch { /* ignore */ }
    } else if (d.type === 'viewer-url' && fromViewer) {
      if (typeof d.url === 'string' && d.url.startsWith(`${TOP_ORIGIN}/enr01/viewers/pdftron/`)) {
        pdftronUrl = d.url.slice(0, 6000);
        pdftronWindow = e.source;
      }
    } else if (d.type === 'scroll' && fromViewer) {
      pdftronWindow = e.source;
      if (Number.isFinite(d.f)) onMainScroll(d.f, d.p, d.pf);
    } else if (d.type === 'zoom' && fromViewer) {
      pdftronWindow = e.source;
      if (Number.isFinite(d.z) && d.z > 0) { lastMainZoom = d.z; lastZoomSrc = String(d.src || ''); if (dockSyncOn && dockSetScale) dockSetScale(d.z); }
    } else if (d.type === 'zoom-diag' && fromViewer) {
      lastZoomSrc = `none: ${String(d.diag || '').slice(0, 160)}`;
    } else if (d.type === 'launcher-press') {
      launcherPressedAt = Date.now();
    } else if (d.type === 'toggle-panel' && fromViewer) {
      launcherPressedAt = Date.now();
      if (isRect(d.rect)) { viewerLauncherRect = d.rect; viewerStatusAt = Date.now(); }
      createUi();
      togglePanel();
    } else if (d.type === 'dock-geometry' && d.geom && typeof d.geom === 'object' && e.origin !== TOP_ORIGIN) {
      const g = d.geom;
      if (![g.rightLeft, g.top, g.bottom, g.width].every(Number.isFinite)) return;
      frameDockGeom = g;
      placeDockFromFrameGeom();
    }
  });
  function placeDockFromFrameGeom() {
    const dock = document.querySelector('#sdx-prevsub-dock');
    const f = findQarcFrame();
    const g = frameDockGeom;
    if (!dock || !f || !g) return;
    const fr = f.getBoundingClientRect();
    dock.style.right = 'auto';
    dock.style.bottom = 'auto';
    dock.style.left = `${Math.round(fr.left + g.rightLeft - g.width)}px`;
    dock.style.top = `${Math.round(fr.top + g.top)}px`;
    dock.style.width = `${Math.round(g.width)}px`;
    dock.style.height = `${Math.max(200, Math.round(g.bottom - g.top))}px`;
  }
  function requestFrameLayout(width, fresh) {
    postToFrame({
      type: 'dock-layout',
      width: width || 0,
      fresh: Boolean(fresh),
      rightOffset: USER_SETTINGS.dockRightOffsetPx
    });
  }
  function isOwnUi(el) {
    return el.id === 'sdx-prevsub-panel' || el.id === 'sdx-prevsub-dock' ||
      el.id === 'sdx-prevsub-scroll-top' || el.id === LAUNCHER_ID;
  }
  function inspectElementDeep(el, out) {
    if (el.shadowRoot) out.push(el.shadowRoot.textContent || '');
    if (el.tagName === 'IFRAME') {
      try {
        const doc = el.contentDocument;
        if (doc && doc.body) out.push(doc.body.innerText || '');
      } catch { /* cross-origin */ }
    }
  }
  function collectShadowText(root, out, depth) {
    if (depth > 6 || out.length > 200) return;
    inspectElementDeep(root, out);
    root.querySelectorAll('*').forEach(el => {
      inspectElementDeep(el, out);
      if (el.shadowRoot) collectShadowText(el.shadowRoot, out, depth + 1);
    });
  }
  let lastDetectionDebug = {};
  // Reads page text from everything EXCEPT this script's own UI (its
  // panel text would otherwise be scraped back in as "document" data).
  function getPageText() {
    const top = [];
    const deep = [];
    if (document.body) {
      for (const child of document.body.children) {
        if (isOwnUi(child) || /^(SCRIPT|STYLE)$/.test(child.tagName)) continue;
        top.push(child.innerText || '');
        try { collectShadowText(child, deep, 0); } catch { /* ignore */ }
      }
    }
    const topText = top.join(' ');
    const deepText = deep.join(' ');
    const has = t => /SDx Name:/i.test(t);
    lastDetectionDebug = {
      topTextLength: topText.length,
      shadowOrSameOriginFrameTextLength: deepText.length,
      crossOriginFrameTextLength: frameText.length,
      summaryFoundIn: has(topText) ? 'page' : has(deepText) ? 'shadow/same-origin frame' : has(frameText) ? 'extension frame' : 'nowhere',
      frameTextSample: cleanText(frameText).slice(0, 300)
    };
    return cleanText([topText, deepText, frameText].join(' ')).slice(0, 300000);
  }
  // Only https links are ever opened or fetched.
  function isHttpsUrl(url) {
    try { return new URL(String(url), window.location.href).protocol === 'https:'; } catch { return false; }
  }
  function openTab(url) {
    if (url && !isHttpsUrl(url)) {
      setStatus('<span class="sdx-prevsub-bad">Blocked a non-https link.</span>');
      return;
    }
    if (!url) {
      setStatus('<span class="sdx-prevsub-bad">No URL was available for that result.</span>');
      return;
    }
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(url, {
        active: !SETTINGS.openInBackground,
        insert: true,
        setParent: true
      });
    } else {
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  }
  function copyText(text) {
    if (typeof GM_setClipboard === 'function') {
      GM_setClipboard(text);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }
  function waitForBody() {
    return new Promise(resolve => {
      if (document.body) {
        resolve();
        return;
      }
      const timer = setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }
  function setStatus(html) {
    const el = document.querySelector('#sdx-prevsub-status');
    if (el) el.innerHTML = html;
  }
  function setResults(html) {
    const el = document.querySelector('#sdx-prevsub-results');
    if (el) el.innerHTML = html;
  }
  function showProgress() {
    const bar = document.querySelector('#sdx-prevsub-progress');
    if (bar) bar.style.display = 'block';
    setProgressPercent(0);
  }
  function hideProgress() {
    const bar = document.querySelector('#sdx-prevsub-progress');
    if (bar) bar.style.display = 'none';
  }
  function setProgressPercent(pct) {
    const fill = document.querySelector('#sdx-prevsub-progress-fill');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
  function clearPerPageState() {
    setResults('');
    setStatus('<span class="sdx-prevsub-warn">Route changed. Refreshing document detection...</span>');
  }
  /********************************************************************
   * PANEL VISIBILITY / AUTO-CLOSE
   ********************************************************************/
  let autoCloseTimer = null;
  function clearAutoCloseTimer() {
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }
  }
  function scheduleAutoClose() {
    clearAutoCloseTimer();
    if (!USER_SETTINGS.idleTimeoutEnabled) return;
    const panel = document.querySelector('#sdx-prevsub-panel');
    if (!panel || panel.style.display !== 'block') return;
    const seconds = USER_SETTINGS.autoCloseSeconds;
    if (!seconds || seconds <= 0) return; // 0 = disabled
    autoCloseTimer = setTimeout(closePanel, seconds * 1000);
  }
  function closePanel() {
    clearAutoCloseTimer();
    const panel = document.querySelector('#sdx-prevsub-panel');
    if (panel) panel.style.display = 'none';
    const scrollTopBtn = document.querySelector('#sdx-prevsub-scroll-top');
    if (scrollTopBtn) scrollTopBtn.style.display = 'none';
  }
  // Non-destructive refresh used when the panel opens/reopens: updates
  // the header fields (doc/title/token) but never touches the results
  // area, so results from an earlier search in this same session stay
  // visible instead of being wiped every time the panel is reopened.
  function reopenPanelDetection() {
    refreshPanel();
    setTimeout(refreshPanel, 350);
    setTimeout(refreshPanel, 1200);
  }
  // Launcher placement. The Bluebeam toolbar row lives inside the
  // pdftron viewer iframe (same-origin), so look there - same approach
  // the Bluebeam userscript uses for its own buttons.
  const LAUNCHER_ID = 'sdx-prevsub-btn';
  let launcherTicks = 0;
  let launcherPressedAt = 0;
  let launcherTimer = null;
  // Depth-first search through this document and every reachable
  // (same-origin) nested iframe document. fn(doc, depth) returns a
  // truthy value to stop.
  function walkDocs(doc, fn, depth) {
    if (!doc || depth > 6) return null;
    let hit = null;
    try { hit = fn(doc, depth); } catch { hit = null; }
    if (hit) return hit;
    let frames = [];
    try { frames = Array.from(doc.querySelectorAll('iframe')); } catch { frames = []; }
    for (const f of frames) {
      let child = null;
      try { child = f.contentDocument; } catch { child = null; }
      const r = walkDocs(child, fn, depth + 1);
      if (r) return r;
    }
    return null;
  }
  function findToolbarContainer() {
    return walkDocs(document, d => d.querySelector('.custom-ribbons-container'), 0);
  }
  // Cumulative offset of an element's document inside the top window.
  function getTopOffset(el) {
    let left = 0;
    let top = 0;
    try {
      let win = el.ownerDocument.defaultView;
      while (win && win !== window && win.frameElement) {
        const r = win.frameElement.getBoundingClientRect();
        left += r.left;
        top += r.top;
        win = win.parent;
      }
    } catch { /* cross-origin: stop */ }
    return { left, top };
  }
  function buildLauncher(doc, inRibbon, handlers) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.id = LAUNCHER_ID;
    b.textContent = 'Prev Doc Ver';
    b.title = 'Find previous versions / consolidated renditions of this document';
    if (inRibbon) {
      b.style.cssText = 'height:28px;padding:0 12px;margin:0 10px 0 0;border-radius:14px;border:1px solid #6546b5;background:#6c4bd3;color:#fff;font:700 12px "Segoe UI",Arial,sans-serif;cursor:pointer;white-space:nowrap;flex:0 0 auto;';
    }
    const h = handlers || {};
    b.addEventListener('mousedown', h.press || (() => { launcherPressedAt = Date.now(); }));
    b.addEventListener('click', h.click || togglePanel);
    return b;
  }
  function getRibbonLauncher() {
    const c = findToolbarContainer();
    return c ? c.querySelector('#' + LAUNCHER_ID) : null;
  }
  function removeLaunchers() {
    document.getElementById(LAUNCHER_ID)?.remove();
    getRibbonLauncher()?.remove();
  }
  function ensureLauncher() {
    if (!shouldShowHelper()) return;
    // The companion inside the extension frame owns the toolbar button.
    if (placedLauncherRect()) {
      launcherTicks = 0;
      document.getElementById(LAUNCHER_ID)?.remove();
      return;
    }
    const container = findToolbarContainer();
    if (container) {
      launcherTicks = 0;
      document.getElementById(LAUNCHER_ID)?.remove();
      if (!container.querySelector('#' + LAUNCHER_ID)) {
        container.appendChild(buildLauncher(container.ownerDocument, true));
      }
      return;
    }
    if (++launcherTicks < 12) return;
    if (!document.getElementById(LAUNCHER_ID) && document.body) {
      document.body.appendChild(buildLauncher(document, false));
    }
  }
  function startLauncherLoop() {
    if (launcherTimer) return;
    launcherTimer = setInterval(ensureLauncher, 1000);
    ensureLauncher();
  }
  function positionPanel() {
    const panel = document.querySelector('#sdx-prevsub-panel');
    if (!panel) return;
    const el = getRibbonLauncher();
    const abs = placedLauncherRect();
    if (abs) {
      const top = Math.round(abs[3] + 6);
      panel.style.top = `${top}px`;
      panel.style.bottom = 'auto';
      panel.style.right = `${Math.max(12, Math.round(window.innerWidth - abs[2]))}px`;
      panel.style.maxHeight = `${Math.max(240, window.innerHeight - top - 16)}px`;
    } else if (el) {
      const r = el.getBoundingClientRect();
      const off = getTopOffset(el);
      const top = Math.round(off.top + r.bottom + 6);
      panel.style.top = `${top}px`;
      panel.style.bottom = 'auto';
      panel.style.right = `${Math.max(12, Math.round(window.innerWidth - (off.left + r.right)))}px`;
      panel.style.maxHeight = `${Math.max(240, window.innerHeight - top - 16)}px`;
    } else {
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.right = '';
      panel.style.maxHeight = '';
    }
  }
  function openPanel() {
    const panel = document.querySelector('#sdx-prevsub-panel');
    if (!panel) return;
    positionPanel();
    panel.style.display = 'block';
    reopenPanelDetection();
    scheduleAutoClose();
  }
  function togglePanel() {
    const panel = document.querySelector('#sdx-prevsub-panel');
    if (!panel) return;
    if (panel.style.display === 'block') {
      closePanel();
    } else {
      openPanel();
    }
  }
  function isInsidePanelOrButton(target) {
    const panel = document.querySelector('#sdx-prevsub-panel');
    const btn = document.querySelector('#sdx-prevsub-btn');
    const scrollTopBtn = document.querySelector('#sdx-prevsub-scroll-top');
    return Boolean(
      (panel && panel.contains(target)) ||
      (btn && btn.contains(target)) ||
      (scrollTopBtn && scrollTopBtn.contains(target))
    );
  }
  function installPanelAutoCloseWatchers() {
    if (window.__sdxPrevSubAutoCloseInstalled) return;
    window.__sdxPrevSubAutoCloseInstalled = true;
    // Capture phase so we see the click even if SDx's own handlers
    // stop propagation during the bubble phase.
    document.addEventListener('click', e => {
      if (!USER_SETTINGS.closeOnOutsideClick) return;
      const panel = document.querySelector('#sdx-prevsub-panel');
      if (!panel || panel.style.display !== 'block') return;
      if (!isInsidePanelOrButton(e.target)) {
        closePanel();
      }
    }, true);
    // A click inside an iframe (e.g. the SDx document viewer) never
    // bubbles to this document, so detect it indirectly via focus
    // moving to an <iframe> element instead.
    window.addEventListener('blur', () => {
      if (!USER_SETTINGS.closeOnOutsideClick) return;
      setTimeout(() => {
        const panel = document.querySelector('#sdx-prevsub-panel');
        if (!panel || panel.style.display !== 'block') return;
        if (Date.now() - launcherPressedAt < 800) return; // click on our own toolbar button
        if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
          closePanel();
        }
      }, 150);
    });
  }
  /********************************************************************
   * CURRENT DOCUMENT DETECTION
   ********************************************************************/
  function extractDocumentNumbers(text) {
    const results = [];
    results.push(...(text.match(/\b\d{5,6}-\d(?:\.\d{3,5})+-\d{3,5}\b/g) || []));
    results.push(...(text.match(/\b[A-Z]{2,5}-[A-Z0-9]{2,5}-[A-Z0-9]{2,8}-\d{4,8}\b/g) || []));
    results.push(...(text.match(/\b[A-Z]?\d{4,8}-[A-Z0-9]{2,8}-\d{3,6}\b/g) || []));
    return unique(results);
  }
  function extractCurrentRevisionFromPage(text, docNo) {
    if (!docNo) return '';
    const idx = text.indexOf(docNo);
    if (idx < 0) return '';
    const after = text.slice(idx + docNo.length, idx + docNo.length + 160);
    const tuple = after.match(/\(\s*([A-Z0-9]+)\s*,\s*([A-Z0-9]+)\s*,\s*([A-Z]+)\s*\)/i);
    if (tuple) return tuple[1];
    const revMatch = after.match(/\bRev(?:ision)?\.?\s*([A-Z0-9]+)\b/i);
    if (revMatch) return revMatch[1];
    return '';
  }
  function extractTitleNearDoc(text, docNo) {
    if (!docNo) return '';
    const idx = text.indexOf(docNo);
    if (idx < 0) return '';
    let tail = text.slice(idx + docNo.length, idx + docNo.length + 360);
    tail = tail.replace(/^\s*[,:\-]\s*/, '');
    tail = tail.replace(/\(\s*[A-Z0-9]+\s*,\s*[A-Z0-9]+\s*,\s*[A-Z]+\s*\)/ig, '');
    tail = tail.replace(/\bSearch\b.*$/i, '');
    tail = tail.replace(/\bQuery\b.*$/i, '');
    tail = tail.replace(/\bNEW LAYER\b.*$/i, '');
    tail = tail.replace(/\bName Description\b.*$/i, '');
    tail = tail.replace(/\bEmbedded Comments\b.*$/i, '');
    return cleanText(tail).slice(0, 180);
  }
  // Fallback for pages whose content isn't readable from this document
  // (e.g. rendered in a cross-origin frame): look the document up from
  // the ContextObjectOBIDs in the route.
  let contextDetected = null;
  let contextFetchedFor = '';
  let contextDebug = {};
  function getContextObjectObid() {
    try {
      const decoded = decodeURIComponent(window.location.href);
      const m = decoded.match(/ContextObjectOBIDs=(\[[^\]]*\])/i);
      if (!m) return '';
      const arr = JSON.parse(m[1]);
      const first = Array.isArray(arr) ? String(arr[0] || '').trim() : '';
      return /^[A-Z0-9]{4,20}$/i.test(first) ? first : '';
    } catch {
      return '';
    }
  }
  async function fetchContextDocument() {
    const obid = getContextObjectObid();
    if (!obid || contextFetchedFor === obid) return false;
    contextFetchedFor = obid;
    contextDebug = { obid, status: 'fetching' };
    try {
      const url = `${window.location.origin}/ENR01Server/api/v2/SDA/Objects('${encodeURIComponent(obid)}')`;
      const res = await authorizedRequest(url, { method: 'GET' });
      const json = await res.json();
      const obj = (Array.isArray(json && json.value) ? json.value[0] : json) || {};
      const text = Object.values(obj).filter(v => typeof v === 'string').join(' | ');
      const docs = extractDocumentNumbers(text);
      contextDebug = { obid, status: docs.length ? 'ok' : 'no document number found in object', keys: Object.keys(obj).slice(0, 40) };
      if (!docs.length) return false;
      contextDetected = {
        obid,
        docNo: docs[0],
        title: cleanText(firstNonEmpty(obj, ['Title', 'Description', 'Name'])),
        currentRev: cleanText(String(firstNonEmpty(obj, ['Doc_Rev', 'Revision', 'Rev']))),
        source: 'SDx object lookup (route context OBID)'
      };
      return true;
    } catch (err) {
      contextDebug = { obid, status: 'error', error: String(err && err.message || err).slice(0, 200) };
      return false;
    }
  }
  // Parses the reviewer pane's "Document Summary" labels from flattened
  // page text, e.g. "SDx Name: 123456-1.2345-0001 Document Number:
  // E17 - MH-03 Title: MH-03 Doc Rev: 1 Date Recived: ...".
  function parseSummaryLabels(text) {
    const grab = re => { const m = text.match(re); return m ? cleanText(m[1]) : ''; };
    return {
      sdxName: grab(/SDx Name:\s*([A-Za-z0-9._-]+)/i),
      altDocNo: grab(/Document Number:\s*(.+?)\s+Title:/i).slice(0, 80),
      title: grab(/\sTitle:\s*(.+?)\s+Doc Rev:/i).slice(0, 180),
      docRev: grab(/Doc Rev:\s*([A-Za-z0-9]+)/i)
    };
  }
  function detectCurrentDocument() {
    const text = getPageText();
    const docs = extractDocumentNumbers(text);
    if (!docs.length && contextDetected && contextDetected.obid === getContextObjectObid()) {
      return {
        docNo: contextDetected.docNo,
        title: contextDetected.title,
        currentRev: contextDetected.currentRev,
        source: contextDetected.source
      };
    }
    if (!docs.length) {
      return {
        docNo: '',
        title: '',
        currentRev: '',
        source: 'not detected'
      };
    }
    const labels = parseSummaryLabels(text);
    const docNo = (labels.sdxName && docs.includes(labels.sdxName)) ? labels.sdxName : docs[0];
    const title = labels.title || extractTitleNearDoc(text, docNo);
    const currentRev = labels.docRev || extractCurrentRevisionFromPage(text, docNo);
    return {
      docNo,
      altDocNo: labels.altDocNo,
      title,
      currentRev,
      source: labels.sdxName ? `review page Document Summary (${lastDetectionDebug.summaryFoundIn})` : 'current tab review page'
    };
  }
  /********************************************************************
   * SEARCH HEURISTICS
   ********************************************************************/
  function getDocNumberParts(docNo) {
    const parts = String(docNo || '').split('-');
    return { project: parts[0] || '', pkg: parts[1] || '', seq: parts[2] || '' };
  }
  function tokenizeTitle(title) {
    const stop = new Set([
      'the', 'and', 'for', 'with', 'from', 'into', 'onto',
      'drawing', 'drawings', 'document', 'documents',
      'general', 'arrangement', 'detail', 'details',
      'specification', 'specifications', 'submittal',
      'review', 'perform', 'wf', 'rev', 'revision'
    ]);
    return unique(
      String(title || '')
        .replace(/[^\w.\- ]+/g, ' ')
        .split(/\s+/)
        .map(x => x.trim())
        .filter(x => x.length >= 2)
        .filter(x => !stop.has(x.toLowerCase()))
    );
  }
  function normalizeTitle(title) {
    return cleanText(title)
      .replace(/\(\s*[A-Z0-9]+\s*,\s*[A-Z0-9]+\s*,\s*[A-Z]+\s*\)/ig, '')
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }
  function createQueries(detected) {
    const docNo = detected.docNo || '';
    const rawTitle = detected.title || '';
    const cleanedTitle = rawTitle
      .replace(/\(\s*[A-Z0-9]+\s*,\s*[A-Z0-9]+\s*,\s*[A-Z]+\s*\)/ig, '')
      .trim();
    const titleNoPunctuation = cleanedTitle
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const { project, pkg, seq } = getDocNumberParts(docNo);
    const tokens = tokenizeTitle(cleanedTitle);
    const queries = [
      detected.altDocNo || '',
      cleanedTitle,
      titleNoPunctuation,
      docNo,
      project && pkg ? `${project}-${pkg}` : '',
      pkg && seq ? `${pkg}-${seq}` : '',
      seq,
      tokens.slice(0, 4).join(' '),
      tokens.slice(0, 3).join(' '),
      tokens[0],
      tokens.find(t => /\d/.test(t)),
      pkg && tokens[0] ? `${pkg} ${tokens[0]}` : '',
      project && tokens.length >= 2 ? `${project} ${tokens.slice(0, 3).join(' ')}` : ''
    ];
    return unique(queries).slice(0, 12);
  }
  // The Consolidated Renditions entity stores document-number-style
  // names (e.g. "CIT-0276"), not free-text titles, and its Name field
  // doesn't include the project prefix - so give it its own, tighter
  // query list built purely from the document number instead of the
  // title-heavy list above.
  function createConsolidatedQueries(detected) {
    const docNo = detected.docNo || '';
    const { project, pkg, seq } = getDocNumberParts(docNo);
    const candidates = [
      docNo,
      detected.altDocNo || '',
      pkg && seq ? `${pkg}-${seq}` : '',
      project && pkg ? `${project}-${pkg}` : '',
      seq,
      pkg
    ];
    return unique(candidates).slice(0, 6);
  }
  /********************************************************************
   * SDx API SEARCH
   ********************************************************************/
  function escapeODataString(value) {
    return String(value || '').replace(/'/g, "''");
  }
  function buildApiUrl(searchText, entityType, fields) {
    const type = entityType || SETTINGS.entityType;
    const fieldList = fields && fields.length ? fields : ['Name', 'Alt_Doc_Name', 'Title', 'Attached_File'];
    const value = `*${escapeODataString(searchText)}`;
    const filter = '(' + fieldList.map(f => `contains(${f},'${value}')`).join(' or ') + ')';
    const params = new URLSearchParams();
    params.set('$format', 'json');
    params.set('$top', String(SETTINGS.top));
    params.set('$filter', filter);
    params.set('$count', 'false');
    params.set('_', String(Date.now()));
    return `${root(type)}?${params.toString()}`;
  }
  function root(entityType) {
    return `${window.location.origin}/ENR01Server/api/v2/SDA/${entityType}`;
  }
  // Project scoping headers (sent only when the project was detected).
  function projectHeaders() {
    const uid = SETTINGS.projectConfigUid;
    return uid ? { spfconfiguid: uid, spfcreateconfiguid: uid, spfqueryconfiguid: uid } : {};
  }
  async function apiSearch(searchText, entityType, retryState, fields) {
    const attempt = (retryState && retryState.attempt) || 1;
    const url = buildApiUrl(searchText, entityType, fields);
    const authorization = getAuthorizationHeader();
    if (!authorization) {
      throw new Error(
        'No SDx authorization token found yet. Run one normal SDx search (this tab or any other SDx tab), or click "Force Re-scan Token", then try again.'
      );
    }
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      mode: 'cors',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        authorization: authorization,
        'x-requested-with': 'XMLHttpRequest',
        ...projectHeaders()
      }
    });
    if (res.status === 401 || res.status === 403) {
      invalidateAuthorization();
      if (attempt < 2) {
        const rescanned = getAuthorizationHeader({ forceRescan: true });
        if (rescanned && rescanned !== authorization) {
          return apiSearch(searchText, entityType, { attempt: attempt + 1 }, fields);
        }
      }
      const body = await res.text().catch(() => '');
      throw new Error(
        `SDx API search failed: ${res.status} ${res.statusText}. Token was rejected/expired. Open the main SDx tab, run one manual search there, then click "Force Re-scan Token" here. ${body.slice(0, 160)}`
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SDx API search failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    return await res.json();
  }
  /*
   * Shared authenticated GET/POST helper for the two-step "open the
   * consolidated PDF" chain (findConsolidatedFileCompositionObid /
   * retrieveFileUri below). Mirrors apiSearch's 401-retry behavior:
   * on a 401/403 it invalidates the cached token, re-scans once for a
   * fresher one, and retries a single time before giving up.
   */
  async function authorizedRequest(url, options, attempt) {
    attempt = attempt || 1;
    const authorization = getAuthorizationHeader();
    if (!authorization) {
      throw new Error(
        'No SDx authorization token found yet. Run one normal SDx search, or click "Force Re-scan Token", then try again.'
      );
    }
    const headers = Object.assign(
      {
        accept: 'application/json, text/javascript, */*; q=0.01',
        authorization,
        'x-requested-with': 'XMLHttpRequest',
        ...projectHeaders()
      },
      (options && options.headers) || {}
    );
    const res = await fetch(url, Object.assign({ credentials: 'include', mode: 'cors' }, options, { headers }));
    if (res.status === 401 || res.status === 403) {
      invalidateAuthorization();
      if (attempt < 2) {
        const rescanned = getAuthorizationHeader({ forceRescan: true });
        if (rescanned && rescanned !== authorization) {
          return authorizedRequest(url, options, attempt + 1);
        }
      }
      const body = await res.text().catch(() => '');
      throw new Error(`Request failed: ${res.status} ${res.statusText}. Token was rejected/expired. ${body.slice(0, 160)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Request failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    return res;
  }
  // Step 1 of opening a consolidated PDF: resolve the rendition
  // record's Id (e.g. "SDI7000A") to a viewable File OBID.
  async function findConsolidatedFileCompositionObid(objectObid) {
    const url =
      `${window.location.origin}/ENR01Server/api/v2/SDA/Objects('${encodeURIComponent(objectObid)}')/` +
      `${SETTINGS.consolidatedFileCompositionPath}?$filter=${encodeURIComponent('SPFViewInd eq true')}&$top=1&$count=true`;
    const res = await authorizedRequest(url, { method: 'GET' });
    const json = await res.json();
    const items = extractRawResultArray(json);
    if (!items.length || !items[0].OBID) {
      throw new Error('No viewable file composition found for this rendition.');
    }
    return items[0].OBID;
  }
  // Step 2: exchange the File OBID for an actual, directly-openable
  // file URL.
  async function retrieveFileUri(fileCompositionObid) {
    const url = `${window.location.origin}/ENR01Server/api/v2/SDA/Files('${encodeURIComponent(fileCompositionObid)}')/Intergraph.SPF.Server.API.Model.RetrieveFileUris`;
    const res = await authorizedRequest(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purposes: ['Markup'], downloadFile: false })
    });
    const json = await res.json();
    const items = extractRawResultArray(json);
    const primary = items.find(i => i.Purpose === 'Primary') || items[0];
    if (!primary || !primary.Uri) {
      throw new Error('RetrieveFileUris returned no usable file URI.');
    }
    return primary.Uri;
  }
  async function openConsolidatedPdf(objectObid, buttonEl) {
    if (!objectObid) {
      setStatus('<span class="sdx-prevsub-bad">No rendition Id available for this consolidated record.</span>');
      return;
    }
    const originalText = buttonEl ? buttonEl.textContent : '';
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = 'Opening...';
    }
    try {
      setStatus('Looking up consolidated file composition...');
      const fileCompositionObid = await findConsolidatedFileCompositionObid(objectObid);
      setStatus('Retrieving file URI...');
      const uri = await retrieveFileUri(fileCompositionObid);
      openTab(uri);
      setStatus('<span class="sdx-prevsub-good">Opened consolidated PDF.</span>');
    } catch (err) {
      setStatus(`<span class="sdx-prevsub-bad">Could not open consolidated PDF: ${escapeHtml(err.message)}</span>`);
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = originalText;
      }
    }
  }

  /********************************************************************
   * SIDE-BY-SIDE DOCK
   *
   * Overlays the consolidated PDF on the viewer area while leaving the
   * right-hand comments / reviewer-actions pane uncovered.
   ********************************************************************/
  const DOCK_WIDTH_KEY = 'sdx-prevsub-dock-width-v1';
  let dockBlobUrl = '';
  let dockCurrentUri = '';
  function findRightPaneRect() {
    // 1) an extension frame hugging the right window edge
    for (const f of document.querySelectorAll('iframe')) {
      if (f.closest('#sdx-prevsub-dock')) continue;
      const r = f.getBoundingClientRect();
      if (r.right >= window.innerWidth - 6 && r.width >= 220 && r.width <= window.innerWidth * 0.45 && r.height >= window.innerHeight * 0.5) return r;
    }
    // 2) by well-known text, climbing to the widest ancestor on the right edge
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const t = node.nodeValue || '';
        if (!/Document Summary|Return Code|Review Comments/.test(t)) continue;
        let el = node.parentElement;
        if (el && el.closest('#sdx-prevsub-panel, #sdx-prevsub-dock')) continue;
        let best = null;
        for (let i = 0; el && i < 14; i++, el = el.parentElement) {
          const r = el.getBoundingClientRect();
          if (r.right >= window.innerWidth - 6 && r.width >= 220 && r.width <= window.innerWidth * 0.45 && r.height >= window.innerHeight * 0.5) best = r;
        }
        if (best) return best;
      }
    } catch { /* fall through to defaults */ }
    return null;
  }
  // The viewer column = topmost ancestor of the pdftron viewer(s) that
  // stops at the left edge of the right-hand pane.
  // Elements in the TOP document that contain the PDF viewer: either a
  // pdftron iframe directly, or any iframe (however deep) that holds one.
  const isViewerFrameEl = f => /viewAndMarkup/i.test(f.getAttribute('src') || '') || /^viewer-frame/i.test(f.id);
  // With several review tabs open there are several viewer frames; the
  // active one is the visible one that is on top at its own center.
  function findViewerFrameEl() {
    const all = Array.from(document.querySelectorAll('iframe')).filter(f => !f.closest('#sdx-prevsub-dock') && isViewerFrameEl(f));
    const vis = all.filter(f => {
      try {
        const r = f.getBoundingClientRect();
        if (r.width < 100 || r.height < 100) return false;
        const cs = getComputedStyle(f);
        return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
      } catch { return false; }
    });
    const onTop = vis.filter(f => {
      try {
        const r = f.getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 200)) === f;
      } catch { return false; }
    });
    return onTop[0] || vis[0] || all[0] || null;
  }
  function addDocumentOpen() {
    try {
      for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,div,span,p,label')) {
        if (el.children.length > 0) continue;
        if ((el.textContent || '').trim() !== 'Add Document') continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth) {
          const cs = getComputedStyle(el);
          if (cs.visibility !== 'hidden' && cs.display !== 'none') return true;
        }
      }
    } catch { /* ignore */ }
    return false;
  }
  const tabKeyOfFrame = f => (f && /^viewer-frame-(.+)$/i.exec(f.id || '') || [])[1] || '';
  function findViewerRoots() {
    const roots = [];
    const activeViewerFrame = findViewerFrameEl();
    for (const f of document.querySelectorAll('iframe')) {
      if (f.closest('#sdx-prevsub-dock')) continue;
      if (/pdftron|viewAndMarkup/i.test(f.getAttribute('src') || '') || /^viewer-frame/i.test(f.id)) {
        if (isViewerFrameEl(f) && activeViewerFrame && f !== activeViewerFrame) continue;   // background tab
        roots.push(f);
        continue;
      }
      let child = null;
      try { child = f.contentDocument; } catch { child = null; }
      if (child && walkDocs(child, d => d.querySelector('iframe[src*="pdftron" i], .custom-ribbons-container'), 0)) roots.push(f);
    }
    return roots;
  }
  function findViewerColumn(rightLeft) {
    for (const root of findViewerRoots()) {
      let el = root;
      while (el && el !== document.body && el !== document.documentElement) {
        const p = el.parentElement;
        const r = el.getBoundingClientRect();
        if (p && r.width >= 300 && Math.abs(r.right - rightLeft) <= 16 && p.getBoundingClientRect().right >= window.innerWidth - 6) return el;
        el = p;
      }
    }
    return null;
  }
  function describeFrames(doc, depth) {
    const out = [];
    if (!doc || depth > 6) return out;
    let frames = [];
    try { frames = Array.from(doc.querySelectorAll('iframe')); } catch { return out; }
    for (const f of frames) {
      let child = null;
      try { child = f.contentDocument; } catch { child = null; }
      const r = f.getBoundingClientRect();
      out.push({
        depth,
        src: (f.getAttribute('src') || '').slice(0, 500),
        globals: (() => { try { return Object.keys(f.contentWindow).filter(k => /webviewer|instance|^Core$|PDFNet|readerControl|documentViewer|annotManager/i.test(k)).slice(0, 20); } catch { return null; } })(),
        id: f.id || '',
        sameOrigin: Boolean(child),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        hasRibbon: Boolean(child && child.querySelector('.custom-ribbons-container'))
      });
      if (child) out.push(...describeFrames(child, depth + 1));
    }
    return out;
  }
  function describeLayout() {
    const rect = findRightPaneRect();
    const rightLeft = rect ? Math.round(rect.left) : null;
    const col = rightLeft ? findViewerColumn(rightLeft) : null;
    return {
      toolbarFound: Boolean(findToolbarContainer()),
      rightPaneLeft: rightLeft,
      viewerRoots: findViewerRoots().length,
      column: col ? `${col.tagName.toLowerCase()}#${col.id}.${String(col.className || '').slice(0, 60)}` : null,
      frames: describeFrames(document, 0)
    };
  }
  let dockGeom = null;   // { col, saved, rightLeft, colLeft, top, bottom }
  const COL_PROPS = ['width', 'min-width', 'max-width', 'flex', 'margin-right'];
  function restoreViewerColumn() {
    if (!dockGeom || !dockGeom.col) return;
    for (const prop of COL_PROPS) {
      const v = dockGeom.saved[prop];
      if (v && v.value) dockGeom.col.style.setProperty(prop, v.value, v.priority);
      else dockGeom.col.style.removeProperty(prop);
    }
  }
  function applyDockWidth(requested) {
    const dock = document.querySelector('#sdx-prevsub-dock');
    if (!dock || !dockGeom) return;
    const g = dockGeom;
    const available = Math.max(400, g.rightLeft - g.colLeft);
    const width = Math.min(Math.max(280, requested), available - 300);
    dock.style.width = `${width}px`;
    if (g.col) {
      const colW = Math.round(available - width);
      g.col.style.setProperty('width', `${colW}px`, 'important');
      g.col.style.setProperty('min-width', '0', 'important');
      g.col.style.setProperty('max-width', `${colW}px`, 'important');
      g.col.style.setProperty('flex', '0 0 auto', 'important');
      g.col.style.setProperty('margin-right', `${Math.round(width)}px`, 'important');
    }
  }
  function layoutDock() {
    const dock = document.querySelector('#sdx-prevsub-dock');
    if (!dock) return;
    if (frameModeActive()) {
      let w = 0;
      try { w = Number(localStorage.getItem(DOCK_WIDTH_KEY)) || 0; } catch { /* ignore */ }
      requestFrameLayout(w, true);
      return;
    }
    restoreViewerColumn();
    const rect = findRightPaneRect();
    const override = USER_SETTINGS.dockRightOffsetPx;
    const rightOffset = override > 0 ? override : (rect ? Math.round(rect.width) : 380);
    const rightLeft = window.innerWidth - rightOffset;
    const col = findViewerColumn(rightLeft);
    const cr = col ? col.getBoundingClientRect() : null;
    const saved = {};
    if (col) {
      for (const prop of COL_PROPS) saved[prop] = { value: col.style.getPropertyValue(prop), priority: col.style.getPropertyPriority(prop) };
    }
    const top = cr ? Math.round(cr.top) : (rect ? Math.max(0, Math.round(rect.top)) : 48);
    const bottom = cr ? Math.max(0, Math.round(window.innerHeight - cr.bottom)) : 0;
    dockGeom = { col, saved, rightLeft, colLeft: cr ? Math.round(cr.left) : 0, top, bottom };
    dock.style.top = `${top}px`;
    dock.style.bottom = `${bottom}px`;
    dock.style.right = `${rightOffset}px`;
    let width = 0;
    try { width = Number(localStorage.getItem(DOCK_WIDTH_KEY)) || 0; } catch { /* ignore */ }
    if (!width) width = Math.round((rightLeft - dockGeom.colLeft) * 0.5);
    applyDockWidth(width);
  }
  function applyDockHeights() {
    try {
      const dock = document.querySelector('#sdx-prevsub-dock');
      if (!dock || !ribbonAbs) return;
      const top = dock.getBoundingClientRect().top;
      const header = Math.round(ribbonAbs[0] - top);
      const tool = Math.round(ribbonAbs[1] - ribbonAbs[0]);
      const bar = dock.querySelector('.sdx-prevsub-dock-bar');
      if (bar && header >= 20 && header <= 80) { bar.style.height = `${header}px`; bar.style.boxSizing = 'border-box'; bar.style.paddingTop = '0'; bar.style.paddingBottom = '0'; }
      const pb = document.querySelector('#sdx-prevsub-pdf-toolbar');
      if (pb && tool >= 24 && tool <= 80) { pb.style.height = `${tool}px`; pb.style.boxSizing = 'border-box'; pb.style.paddingTop = '0'; pb.style.paddingBottom = '0'; }
    } catch { /* ignore */ }
  }
  function closeDock() {
    clearDockTimers();
    if (dockViewerDestroy) { try { dockViewerDestroy(); } catch { /* ignore */ } dockViewerDestroy = null; }
    dockMode = 'none';
    dockScrollEl = null;
    if (frameModeActive()) postToFrame({ type: 'dock-restore' });
    frameDockGeom = null;
    restoreViewerColumn();
    dockGeom = null;
    document.querySelector('#sdx-prevsub-dock')?.remove();
    if (dockBlobUrl) {
      try { URL.revokeObjectURL(dockBlobUrl); } catch { /* ignore */ }
      dockBlobUrl = '';
    }
    dockCurrentUri = '';
  }
  function popOutTiled(uri) {
    if (!isHttpsUrl(uri)) return;
    const w = Math.round(screen.availWidth / 2);
    const h = screen.availHeight;
    const left = (window.screenX || 0) >= screen.availWidth / 2 ? 0 : Math.round(screen.availWidth / 2);
    window.open(uri, 'sdxConsolidatedPdf', `popup=yes,width=${w},height=${h},left=${left},top=0,noopener,noreferrer`);
  }
  function ensureDock() {
    let dock = document.querySelector('#sdx-prevsub-dock');
    if (dock) return dock;
    dock = document.createElement('div');
    dock.id = 'sdx-prevsub-dock';
    const handle = document.createElement('div');
    handle.className = 'sdx-prevsub-dock-handle';
    handle.title = 'Drag to resize';
    const bar = document.createElement('div');
    bar.className = 'sdx-prevsub-dock-bar';
    const label = document.createElement('span');
    label.id = 'sdx-prevsub-dock-label';
    const mk = (text, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    bar.append(
      label,
      (() => {
        const b = mk('Sync scroll: on', 'Scroll the review document and this PDF together', () => {
          dockSyncOn = !dockSyncOn;
          updateSyncButton();
          if (dockSyncOn && dockSetScale && lastMainZoom > 0) dockSetScale(lastMainZoom);
        });
        b.id = 'sdx-prevsub-dock-sync';
        b.style.display = 'none';
        return b;
      })(),
      mk('Download', 'Save this PDF', () => {
        try {
          if (!dockBuffer) { openTab(dockCurrentUri); return; }
          const url = URL.createObjectURL(new Blob([dockBuffer], { type: 'application/pdf' }));
          const a = document.createElement('a');
          const base = String(document.querySelector('#sdx-prevsub-dock-label')?.textContent || 'consolidated').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'consolidated';
          a.href = url;
          a.download = /\.pdf$/i.test(base) ? base : `${base}.pdf`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 10000);
        } catch { openTab(dockCurrentUri); }
      }),
      mk('Open in tab', 'Open this PDF in a new browser tab', () => openTab(dockCurrentUri)),
      mk('Tiled window', 'Open in its own window on the other half of the screen', () => popOutTiled(dockCurrentUri)),
      (() => {
        const b = mk('\u00d7', 'Close side-by-side view', () => { dockStates.delete(dockTabKey); closeDock(); });
        b.style.cssText = 'background:#c62828;border-color:#b71c1c;color:#fff;min-width:44px;font-weight:700;font-size:14px;line-height:1;';
        return b;
      })()
    );
    const body = document.createElement('div');
    body.id = 'sdx-prevsub-dock-body';
    dock.append(handle, bar, body);
    document.body.appendChild(dock);
    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const frames = Array.from(document.querySelectorAll('iframe'));
      frames.forEach(f => { f.style.pointerEvents = 'none'; });
      const onMove = ev => {
        if (frameModeActive() && frameDockGeom) {
          const fr = findQarcFrame().getBoundingClientRect();
          requestFrameLayout((fr.left + frameDockGeom.rightLeft) - ev.clientX, false);
        } else {
          const rightOffset = parseInt(dock.style.right, 10) || 0;
          applyDockWidth(window.innerWidth - rightOffset - ev.clientX);
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        frames.forEach(f => { f.style.pointerEvents = ''; });
        try { localStorage.setItem(DOCK_WIDTH_KEY, String(parseInt(dock.style.width, 10) || 0)); } catch { /* ignore */ }
        if (frameModeActive()) requestFrameLayout(parseInt(dock.style.width, 10) || 0, false);
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
    return dock;
  }
  // --- Side-by-side viewer (PDF.js) ------------------------------------
  let dockViewerDestroy = null;
  let dockCommentCount = 0;
  let pdfjsRef = null;
  function clearDockTimers() {
    dockTimers.forEach(t => clearInterval(t));
    dockTimers = [];
  }
  function postToViewer(msg) {
    if (!pdftronWindow) return;
    try { pdftronWindow.postMessage(Object.assign({ prevsub: true }, msg), TOP_ORIGIN); } catch { /* ignore */ }
  }
  function dockPages() {
    return dockScrollEl ? Array.from(dockScrollEl.querySelectorAll('[data-page]')) : [];
  }
  function onMainScroll(f, p, pf) {
    if (!dockSyncOn || dockMode !== 'pdfjs' || !dockScrollEl) return;
    dockIgnoreUntil = Date.now() + 250;
    const pgs = Number.isFinite(p) ? dockPages() : [];
    if (!(pgs.length && setPageAnchor(dockScrollEl, pgs, p, Number.isFinite(pf) ? pf : 0))) setScrollFraction(dockScrollEl, f);
  }
  function hookDockScroll(el) {
    dockScrollEl = el;
    let raf = 0;
    el.addEventListener('scroll', () => {
      if (!dockSyncOn || Date.now() < dockIgnoreUntil || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const a = pageAnchor(el, dockPages());
        postToViewer({ type: 'scroll-set', f: getScrollFraction(el), p: a ? a.p : undefined, pf: a ? a.pf : undefined });
      });
    }, { passive: true });
  }
  function updateSyncButton() {
    const b = document.querySelector('#sdx-prevsub-dock-sync');
    if (!b) return;
    b.style.display = dockMode === 'pdfjs' ? '' : 'none';
    b.textContent = dockSyncOn ? 'Sync scroll: on' : 'Sync scroll: off';
  }
  // PDF.js is kept as Tampermonkey @resource text (integrity-checked) and
  // evaluated only here, in the top page, on first use.
  let pdfjsNote = '';
  let pdfjsStage = '';
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
  // PDF.js 3.11.174: the last release shipped as a classic script.
  function loadPdfjsClassic() {
    if (typeof GM_getResourceText !== 'function') throw new Error('Tampermonkey resource API unavailable');
    const libText = GM_getResourceText('pdfjsLib');
    const workerText = GM_getResourceText('pdfjsWorker');
    if (!libText || !workerText) {
      throw new Error('PDF.js was not downloaded by Tampermonkey (it needs access to cdn.jsdelivr.net when the script is installed) - reinstall the script');
    }
    const libMod = { exports: {} };
    new Function('module', 'exports', libText)(libMod, libMod.exports);
    const lib = libMod.exports;
    if (!lib || typeof lib.getDocument !== 'function') throw new Error('PDF.js did not initialize');
    const workerMod = { exports: {} };
    new Function('module', 'exports', workerText)(workerMod, workerMod.exports);
    if (!workerMod.exports || !workerMod.exports.WorkerMessageHandler) throw new Error('PDF.js worker did not initialize');
    globalThis.pdfjsWorker = { WorkerMessageHandler: workerMod.exports.WorkerMessageHandler };
    lib.GlobalWorkerOptions.workerSrc = 'pdf.worker.js';
    return lib;
  }
  function loadPdfjs() {
    if (!pdfjsRef) {
      pdfjsRef = loadPdfjsClassic();
      pdfjsNote = `PDF.js ${pdfjsRef.version || '3.11.174'}`;
    }
    return pdfjsRef;
  }
  function parsePdfDate(str) {
    const m = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(String(str || ''));
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1), Number(m[4] || 0), Number(m[5] || 0), Number(m[6] || 0));
  }
  const COMMENT_SUBTYPES = new Set(['Text', 'FreeText', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Stamp', 'Ink', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Caret', 'FileAttachment']);
  async function mountPdfViewer(body, buffer, labelText) {
    const lib = loadPdfjs();
    pdfjsStage = 'opening PDF';
    const task = lib.getDocument({
      data: new Uint8Array(buffer.slice(0)),
      isEvalSupported: false,      // mitigates CVE-2024-4367
      enableXfa: false,
      useSystemFonts: true
    });
    let pdf;
    try {
      pdf = await withTimeout(task.promise, 30000, 'opening the PDF');
    } catch (err) {
      try { task.destroy(); } catch { /* ignore */ }
      throw err;
    }
    const mk = (tag, css, text) => {
      const el = document.createElement(tag);
      if (css) el.style.cssText = css;
      if (text) el.textContent = text;
      return el;
    };
    const btnCss = 'border:1px solid #2d7fb8;background:#fff;color:#2d7fb8;border-radius:4px;font-size:11px;padding:2px 8px;cursor:pointer;';
    body.textContent = '';
    const wrap = mk('div', 'display:flex;flex-direction:column;height:100%;');
    const bar = mk('div', 'display:flex;align-items:center;gap:6px;padding:3px 8px;background:#fafafa;border-bottom:1px solid #e0e0e0;font-size:11px;');
    bar.id = 'sdx-prevsub-pdf-toolbar';
    const zoomOut = mk('button', btnCss, '−');
    const zoomIn = mk('button', btnCss, '+');
    const fitBtn = mk('button', btnCss, 'Fit width');
    const zoomLabel = mk('input', 'width:40px !important;min-width:0 !important;flex:0 0 auto !important;text-align:center;font-size:11px;border:1px solid #bbb;border-radius:3px;padding:2px 0 !important;box-sizing:border-box;');
    zoomLabel.type = 'text';
    zoomLabel.title = 'Type a zoom percentage and press Enter';
    const pageLabel = mk('span', 'flex:1;text-align:center;color:#555;');
    const commentsBtn = mk('button', btnCss, 'Comments');
    [zoomOut, zoomIn, fitBtn, commentsBtn].forEach(b => { b.type = 'button'; });
    bar.append(zoomOut, zoomLabel, zoomIn, fitBtn, pageLabel, commentsBtn);
    const main = mk('div', 'position:relative;flex:1;min-height:0;');
    const scroller = mk('div', 'position:absolute;top:0;left:0;right:0;bottom:0;overflow:auto;background:#e8e8e8;');
    const list = mk('div', 'position:absolute;top:0;left:0;right:0;bottom:0;overflow:auto;background:#fff;padding:8px;display:none;z-index:2;font-size:12px;');
    main.append(scroller, list);
    wrap.append(bar, main);
    body.appendChild(wrap);
    applyDockHeights();
    const pageDivs = [];
    const rendered = new Set();
    const rendering = new Set();
    let scale = 1;
    let baseW = 612;
    let baseH = 792;
    let destroyed = false;
    const first = await pdf.getPage(1);
    const v1 = first.getViewport({ scale: 1 });
    baseW = v1.width;
    baseH = v1.height;
    const dpr = window.devicePixelRatio || 1;
    const observer = new IntersectionObserver(entries => {
      entries.forEach(en => { if (en.isIntersecting) renderPage(Number(en.target.dataset.page)); });
    }, { root: scroller, rootMargin: '900px 0px' });
    function sizePlaceholders() {
      pageDivs.forEach(d => {
        d.style.width = `${Math.round(baseW * scale)}px`;
        d.style.height = `${Math.round(baseH * scale)}px`;
      });
      zoomLabel.value = `${Math.round(scale * 100)}%`;
    }
    async function renderPage(n) {
      if (destroyed || rendered.has(n) || rendering.has(n)) return;
      rendering.add(n);
      try {
        const page = await pdf.getPage(n);
        if (destroyed) return;
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width * dpr);
        canvas.height = Math.floor(vp.height * dpr);
        canvas.style.cssText = `width:${Math.floor(vp.width)}px;height:${Math.floor(vp.height)}px;display:block;`;
        const ctx = canvas.getContext('2d');
        await page.render({ canvas, canvasContext: ctx, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
        if (destroyed) return;
        const d = pageDivs[n - 1];
        d.querySelector('canvas')?.remove();
        d.insertBefore(canvas, d.firstChild);
        d.style.width = `${Math.floor(vp.width)}px`;
        d.style.height = `${Math.floor(vp.height)}px`;
        rendered.add(n);
      } catch { /* a page that fails to render stays blank */ } finally {
        rendering.delete(n);
      }
    }
    for (let n = 1; n <= pdf.numPages; n++) {
      const d = mk('div', 'position:relative;margin:8px auto;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,0.3);');
      d.dataset.page = String(n);
      pageDivs.push(d);
      scroller.appendChild(d);
    }
    function fitWidth() {
      scale = Math.max(0.3, (scroller.clientWidth - 24) / baseW);
    }
    function relayout() {
      const f = getScrollFraction(scroller);
      rendered.clear();
      pageDivs.forEach(d => { d.querySelector('canvas')?.remove(); });
      sizePlaceholders();
      pageDivs.forEach(d => { observer.unobserve(d); observer.observe(d); });
      requestAnimationFrame(() => setScrollFraction(scroller, f));
    }
    fitWidth();
    if (dockSyncOn && lastMainZoom > 0) scale = Math.min(4, Math.max(0.3, lastMainZoom));
    sizePlaceholders();
    pageDivs.forEach(d => observer.observe(d));
    dockSetScale = z => {
      const ns = Math.min(4, Math.max(0.3, z));
      if (Math.abs(ns - scale) < 0.005) return;
      scale = ns;
      relayout();
    };
    zoomIn.addEventListener('click', () => { scale = Math.min(4, scale * 1.2); relayout(); });
    zoomOut.addEventListener('click', () => { scale = Math.max(0.3, scale / 1.2); relayout(); });
    fitBtn.addEventListener('click', () => { fitWidth(); relayout(); });
    const commitZoom = () => {
      const v = parseFloat(String(zoomLabel.value).replace('%', ''));
      if (Number.isFinite(v) && v > 0) { scale = Math.min(4, Math.max(0.3, v / 100)); relayout(); } else { zoomLabel.value = `${Math.round(scale * 100)}%`; }
    };
    zoomLabel.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { commitZoom(); zoomLabel.blur(); } });
    zoomLabel.addEventListener('keyup', e => e.stopPropagation());
    zoomLabel.addEventListener('blur', commitZoom);
    commentsBtn.addEventListener('click', () => { list.style.display = list.style.display === 'none' ? 'block' : 'none'; });
    const updatePage = () => {
      const probe = scroller.scrollTop + scroller.clientHeight / 3;
      let cur = 1;
      for (let i = 0; i < pageDivs.length; i++) { if (pageDivs[i].offsetTop <= probe) cur = i + 1; else break; }
      pageLabel.textContent = `Page ${cur} of ${pdf.numPages}`;
    };
    scroller.addEventListener('scroll', updatePage, { passive: true });
    updatePage();
    hookDockScroll(scroller);
    // ---- comments (read from the PDF's own markup annotations)
    list.appendChild(mk('div', 'color:#666;', 'Loading comments...'));
    (async () => {
      const rows = [];
      for (let n = 1; n <= pdf.numPages && !destroyed; n++) {
        try {
          const page = await pdf.getPage(n);
          const anns = await page.getAnnotations();
          anns.forEach(a => {
            if (!COMMENT_SUBTYPES.has(a.subtype)) return;
            const contents = String((a.contentsObj && a.contentsObj.str) || a.contents || '').trim();
            const author = String((a.titleObj && a.titleObj.str) || a.title || '').trim();
            if (!contents && !author) return;
            const when = parsePdfDate(a.modificationDate) || parsePdfDate(a.creationDate);
            rows.push({ page: n, author: author || '(unknown author)', when, contents, kind: a.subtype, rect: a.rect });
          });
        } catch { /* skip this page's annotations */ }
      }
      if (destroyed) return;
      dockCommentCount = rows.length;
      list.textContent = '';
      const authors = [...new Set(rows.map(r => r.author))];
      list.appendChild(mk('div', 'font-weight:600;margin-bottom:6px;',
        rows.length
          ? `${rows.length} comment${rows.length === 1 ? '' : 's'} by ${authors.join(', ')}`
          : 'No comment markups were found in this PDF (they may have been flattened into the page image).'));
      rows.forEach(r => {
        const item = mk('div', 'border:1px solid #ddd;border-radius:5px;padding:6px;margin:5px 0;cursor:pointer;');
        item.append(
          mk('div', 'font-weight:600;', `${r.author}${r.when ? ' • ' + r.when.toLocaleString() : ''}`),
          mk('div', 'color:#666;', `Page ${r.page} • ${r.kind}`),
          mk('div', 'white-space:pre-wrap;margin-top:3px;', r.contents || '(no text)')
        );
        item.addEventListener('click', async () => {
          list.style.display = 'none';
          const d = pageDivs[r.page - 1];
          try {
            const page = await pdf.getPage(r.page);
            const vp = page.getViewport({ scale });
            const [x1, y1, x2, y2] = vp.convertToViewportRectangle(r.rect);
            const box = mk('div', `position:absolute;left:${Math.min(x1, x2)}px;top:${Math.min(y1, y2)}px;width:${Math.abs(x2 - x1)}px;height:${Math.abs(y2 - y1)}px;border:2px solid #e67e00;background:rgba(255,200,0,0.25);pointer-events:none;`);
            d.appendChild(box);
            setTimeout(() => box.remove(), 2800);
            scroller.scrollTop = Math.max(0, d.offsetTop + Math.min(y1, y2) - 60);
          } catch {
            scroller.scrollTop = Math.max(0, d.offsetTop - 12);
          }
        });
        list.appendChild(item);
      });
      commentsBtn.textContent = `Comments (${rows.length})`;
      if (!rows.length) { commentsBtn.style.display = 'none'; list.style.display = 'none'; }
    })();
    dockViewerDestroy = () => {
      destroyed = true;
      dockSetScale = null;
      try { observer.disconnect(); } catch { /* ignore */ }
      try { pdf.destroy(); } catch { /* ignore */ }
    };
  }
  const MAX_PDF_BYTES = 300 * 1024 * 1024;
  async function fetchPdfBuffer(uri) {
    try {
      if (!isHttpsUrl(uri)) return null;
      // Fetched with the user's own session; the token only ever goes to
      // our own origin.
      const sameOrigin = new URL(uri).origin === window.location.origin;
      const headers = {};
      const auth = getAuthorizationHeader();
      if (sameOrigin && auth) headers.authorization = auth;
      const res = await fetch(uri, { credentials: 'include', headers });
      if (!res.ok) return null;
      const declared = Number(res.headers.get('content-length')) || 0;
      if (declared > MAX_PDF_BYTES) return null;
      const buf = await res.arrayBuffer();
      return buf.byteLength > MAX_PDF_BYTES ? null : buf;
    } catch {
      return null;
    }
  }
  async function showDock(uri, labelText, buffer) {
    const dock = ensureDock();
    layoutDock();
    dockCurrentUri = uri;
    dockBuffer = buffer || null;
    dockTabKey = activeTab;
    if (buffer) dockStates.set(dockTabKey, { uri, label: labelText, buffer });
    document.querySelector('#sdx-prevsub-dock-label').textContent = labelText || 'Consolidated rendition';
    const body = document.querySelector('#sdx-prevsub-dock-body');
    body.textContent = 'Loading consolidated PDF...';
    clearDockTimers();
    if (dockViewerDestroy) { try { dockViewerDestroy(); } catch { /* ignore */ } dockViewerDestroy = null; }
    dockMode = 'none';
    dockScrollEl = null;
    dockCommentCount = 0;
    if (dockBlobUrl) {
      try { URL.revokeObjectURL(dockBlobUrl); } catch { /* ignore */ }
      dockBlobUrl = '';
    }
    dock.style.display = 'flex';
    hideToast();
    applyDockHeights();
    setTimeout(applyDockHeights, 400);
    try {
      if (!buffer) throw new Error('the file could not be downloaded');
      await withTimeout(mountPdfViewer(body, buffer, labelText), 45000, `PDF viewer (${pdfjsStage || 'start'})`);
      dockMode = 'pdfjs';
      dockNote = pdfjsNote || 'PDF.js viewer';
      updateSyncButton();
      setStatus('<span class="sdx-prevsub-good">Consolidated PDF is open next to the review document. Use Comments in its toolbar to see who made each comment.</span>');
    } catch (err) {
      dockMode = 'chrome';
      dockNote = `PDF.js viewer unavailable: ${String(err && err.message || err).slice(0, 200)}`;
      if (dockViewerDestroy) { try { dockViewerDestroy(); } catch { /* ignore */ } dockViewerDestroy = null; }
      body.textContent = '';
      const frame = document.createElement('iframe');
      frame.title = 'Consolidated rendition';
      if (buffer) {
        dockBlobUrl = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
        frame.src = dockBlobUrl;
      } else {
        frame.src = isHttpsUrl(uri) ? uri : 'about:blank';
      }
      body.appendChild(frame);
      updateSyncButton();
      setStatus(`<span class="sdx-prevsub-warn">${escapeHtml(dockNote)}. Showing the browser's PDF viewer instead.</span>`);
    }
  }
  async function showSideBySide(abs, labelText) {
    setStatus('Fetching consolidated PDF...');
    const buffer = await fetchPdfBuffer(abs);
    await showDock(abs, labelText, buffer);
    closePanel();
  }
  async function openConsolidatedDocked(objectObid, labelText, buttonEl) {
    if (!objectObid) {
      setStatus('<span class="sdx-prevsub-bad">No rendition Id available for this consolidated record.</span>');
      return;
    }
    const originalText = buttonEl ? buttonEl.textContent : '';
    if (buttonEl) {
      buttonEl.disabled = true;
      buttonEl.textContent = 'Opening...';
    }
    try {
      closePanel();
      setStatus('Looking up consolidated file...');
      const fileObid = await findConsolidatedFileCompositionObid(objectObid);
      const uri = await retrieveFileUri(fileObid);
      const abs = new URL(uri, window.location.origin).href;
      await showSideBySide(abs, labelText);
    } catch (err) {
      setStatus(`<span class="sdx-prevsub-bad">Could not open side-by-side: ${escapeHtml(err.message)}</span>`);
      showInfoToast(`Could not open side-by-side: ${err.message}`);
    } finally {
      if (buttonEl) {
        buttonEl.disabled = false;
        buttonEl.textContent = originalText;
      }
    }
  }
  window.addEventListener('resize', () => layoutDock());
  function firstNonEmpty(item, names) {
    for (const name of names) {
      if (item && item[name] !== undefined && item[name] !== null && String(item[name]).trim() !== '') {
        return item[name];
      }
    }
    return '';
  }
  function extractRawResultArray(json) {
    const raw =
      json?.value ||
      json?.d?.results ||
      json?.results ||
      json?.Items ||
      [];
    return Array.isArray(raw) ? raw : [];
  }
  function normalizeMainItem(item, query) {
    const revision = firstNonEmpty(item, [
      'Revision',
      'MajorRev',
      'MajorRevision',
      'Major_Rev',
      'Rev',
      'RevNumber',
      'RevisionNumber',
      'Issue',
      'IssueIndex'
    ]);
    const version = firstNonEmpty(item, [
      'Version',
      'VersionNumber',
      'MinorRev',
      'MinorRevision',
      'Minor_Rev'
    ]);
    const obid = firstNonEmpty(item, [
      'OBID',
      'ObjectOBID'
    ]);
    const name = firstNonEmpty(item, [
      'Name',
      'DisplayName',
      'DocName',
      'DocumentName'
    ]);
    const title = firstNonEmpty(item, [
      'Title',
      'Description',
      'DocTitle',
      'DocumentTitle'
    ]);
    return {
      query,
      raw: item,
      uid: obid || name || title || JSON.stringify(item).slice(0, 80),
      obid,
      name,
      altName: firstNonEmpty(item, ['Alt_Doc_Name', 'AlternateName', 'AltDocName']),
      title,
      attachedFile: firstNonEmpty(item, ['Attached_File', 'AttachedFile', 'FileName']),
      revision,
      version,
      updated: firstNonEmpty(item, ['UpdatedDate', 'Updated_Date', 'LastUpdated', 'ModifiedDate', 'UpdateDate']),
      created: firstNonEmpty(item, ['CreationDate', 'Creation_Date', 'CreatedDate', 'CreateDate']),
      config: firstNonEmpty(item, ['Config', 'ConfigUID', 'ConfigName'])
    };
  }
  function normalizeApiResults(json, query) {
    return extractRawResultArray(json).map(item => normalizeMainItem(item, query));
  }
  /*
   * Confirmed bmcdConsolidatedDocRenditions field shape (from a live
   * raw result):
   *   UID, Name, Alt_Doc_Name, Title, Doc_Rev, Actual_Returned,
   *   Return_Code, Comments_By, Actual_Received, Contract, Submittal,
   *   Classification, Sys_Rev, Rev_State, Config, Id
   * There is NO direct PDF/file-URL field on this entity. "Id" (e.g.
   * "SDFK000A") matches the same OBID shape used across the rest of
   * this script, so it's mapped to `obid` and fed through the same
   * collectObidCandidates/HistoryViewRoute path as the main entity.
   */
  function normalizeConsolidatedItem(item, query) {
    const obid = firstNonEmpty(item, ['Id', 'OBID', 'ObjectOBID']);
    const name = firstNonEmpty(item, ['Name', 'DisplayName']);
    const title = firstNonEmpty(item, ['Title', 'Description']);
    return {
      query,
      raw: item,
      uid: item.UID || obid || name || title || JSON.stringify(item).slice(0, 80),
      obid,
      name,
      altName: firstNonEmpty(item, ['Alt_Doc_Name']),
      title,
      attachedFile: '',
      revision: firstNonEmpty(item, ['Doc_Rev', 'Sys_Rev']),
      version: '',
      updated: firstNonEmpty(item, ['Actual_Returned']),
      created: firstNonEmpty(item, ['Actual_Received']),
      contract: firstNonEmpty(item, ['Contract']),
      submittal: firstNonEmpty(item, ['Submittal']),
      classification: firstNonEmpty(item, ['Classification']),
      revState: firstNonEmpty(item, ['Rev_State']),
      returnCode: firstNonEmpty(item, ['Return_Code'])
    };
  }
  function normalizeConsolidatedResults(json, query) {
    return extractRawResultArray(json).map(item => normalizeConsolidatedItem(item, query));
  }
  function dedupeByUid(items) {
    const map = new Map();
    items.forEach(it => {
      if (!map.has(it.uid)) map.set(it.uid, it);
    });
    return [...map.values()];
  }
  /********************************************************************
   * SCORING AND REVISION GROUPING
   ********************************************************************/
  function revisionValue(label) {
    const text = cleanText(label);
    if (!text) return null;
    const numeric = text.match(/\d+/);
    if (numeric) return Number(numeric[0]);
    const alpha = text.match(/[A-Z]/i);
    if (alpha) return alpha[0].toUpperCase().charCodeAt(0) - 64;
    return null;
  }
  function getResultRevisionLabel(result) {
    const rev = cleanText(result.revision);
    const version = cleanText(result.version);
    if (rev && version && rev !== version) return `${rev}.${version}`;
    return rev || version || '';
  }
  function getPrimaryRevisionValue(result) {
    const rev = cleanText(result.revision);
    const version = cleanText(result.version);
    return revisionValue(rev || version || getResultRevisionLabel(result));
  }
  function getResultSortDate(result) {
    const dateText = result.updated || result.created || '';
    const date = new Date(dateText);
    if (!isNaN(date.getTime())) return date.getTime();
    return 0;
  }
  // Strict "is this actually the same document" check, used anywhere
  // that needs to be authoritative (grouping revisions, consolidated
  // matches) rather than just casting a broad net. Deliberately does
  // NOT fall back to title-word overlap: this project's drawing sets
  // reuse near-identical boilerplate titles across every sheet in a
  // series (e.g. "Stack, 3D View & Connection details (Sheet 1)" vs
  // "(Sheet 2)"), so word overlap alone will confidently match the
  // wrong sheet. Only an exact document-number substring counts.
  function sameDocumentNumber(result, detected) {
    const docNo = detected.docNo || '';
    if (!docNo && !detected.altDocNo) return false;
    const haystack = [result.name, result.altName, result.attachedFile].join(' ').toLowerCase();
    if (haystack.includes(docNo.toLowerCase())) return true;
    return Boolean(detected.altDocNo && haystack.includes(detected.altDocNo.toLowerCase()));
  }
  // Same idea as sameDocumentNumber, but also accepts the short
  // "PKG-SEQ" form (e.g. "CIT-0276") since the Consolidated Renditions
  // entity's Name field doesn't include the project number prefix.
  function consolidatedMatchesDetected(item, detected) {
    const haystack = [item.name, item.altName, item.title, item.attachedFile].join(' ').toLowerCase();
    const { pkg, seq } = getDocNumberParts(detected.docNo);
    const pkgSeq = pkg && seq ? `${pkg}-${seq}` : '';
    if (detected.docNo && haystack.includes(detected.docNo.toLowerCase())) return true;
    if (pkgSeq && haystack.includes(pkgSeq.toLowerCase())) return true;
    if (detected.altDocNo && haystack.includes(detected.altDocNo.toLowerCase())) return true;
    return false;
  }
  function scoreResult(result, detected) {
    const docNo = detected.docNo || '';
    const title = detected.title || '';
    const tokens = tokenizeTitle(title);
    const haystack = [
      result.name,
      result.altName,
      result.title,
      result.attachedFile,
      result.revision,
      result.version,
      result.updated,
      result.created
    ].join(' ').toLowerCase();
    let score = 0;
    if (docNo && haystack.includes(docNo.toLowerCase())) score += 80;
    const titleClean = normalizeTitle(title);
    if (titleClean && haystack.includes(titleClean)) score += 90;
    tokens.forEach(t => {
      if (haystack.includes(t.toLowerCase())) {
        score += /\d/.test(t) ? 18 : 12;
      }
    });
    const { project, pkg, seq } = getDocNumberParts(docNo);
    if (project && haystack.includes(project.toLowerCase())) score += 10;
    if (pkg && haystack.includes(pkg.toLowerCase())) score += 20;
    if (seq && haystack.includes(seq.toLowerCase())) score += 20;
    return score;
  }
  function mergeAndRankResults(results, detected) {
    const map = new Map();
    results.forEach(r => {
      const key = r.uid || `${r.name}|${r.title}|${r.revision}|${r.version}`;
      const score = scoreResult(r, detected);
      if (score < SETTINGS.minScore) return;
      const existing = map.get(key);
      const scored = { ...r, score };
      if (!existing || scored.score > existing.score) {
        map.set(key, scored);
      }
    });
    return [...map.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, SETTINGS.maxDisplayedResults);
  }
  function compareRevisionDescending(a, b) {
    if (a.revVal !== null && b.revVal !== null && a.revVal !== b.revVal) {
      return b.revVal - a.revVal;
    }
    if (a.dateVal !== b.dateVal) return b.dateVal - a.dateVal;
    return String(b.revLabel).localeCompare(String(a.revLabel));
  }
  function buildRevisionList(results, detected) {
    const filtered = results.filter(r => sameDocumentNumber(r, detected));
    const currentVal = revisionValue(detected.currentRev);
    const withData = filtered.map(r => {
      const label = getResultRevisionLabel(r);
      const revVal = getPrimaryRevisionValue(r);
      const dateVal = getResultSortDate(r);
      let relation = 'unknown';
      if (currentVal !== null && revVal !== null) {
        if (revVal < currentVal) relation = 'previous';
        else if (revVal === currentVal) relation = 'current';
        else if (revVal > currentVal) relation = 'newer';
      }
      return {
        ...r,
        revLabel: label,
        revVal,
        currentVal,
        dateVal,
        relation
      };
    });
    if (currentVal === null) {
      const sortedProbe = [...withData].sort(compareRevisionDescending);
      return sortedProbe.map((r, idx) => ({
        ...r,
        relation: idx === 0 ? 'current' : 'previous'
      }));
    }
    return withData.sort(compareRevisionDescending);
  }
  function getBestPreviousRevision(revisions) {
    const previous = revisions.filter(r => r.relation === 'previous');
    if (!previous.length) return null;
    return previous.sort(compareRevisionDescending)[0];
  }
  /********************************************************************
   * URL BUILDERS
   ********************************************************************/
  function collectObidCandidates(result) {
    const raw = result?.raw || {};
    const candidates = [];
    function addCandidate(key, value, sourcePath) {
      if (value === undefined || value === null) return;
      const text = String(value).trim();
      const matches = text.match(/\b[A-Z0-9]{6,14}A\b/g);
      if (!matches || !matches.length) return;
      matches.forEach(obid => {
        const keyText = String(key || '').toLowerCase();
        const pathText = String(sourcePath || '').toLowerCase();
        let weight = 0;
        if (/history/i.test(keyText)) weight += 130;
        if (/history/i.test(pathText)) weight += 110;
        if (/composition|version|revision|rendition|review/i.test(keyText)) weight += 100;
        if (/composition|version|revision|rendition|review/i.test(pathText)) weight += 75;
        if (/obid/i.test(keyText)) weight += 60;
        if (/obid/i.test(pathText)) weight += 40;
        if (/documentreviewversion/i.test(keyText)) weight += 150;
        if (/documentreviewversion/i.test(pathText)) weight += 125;
        if (/filecomposition/i.test(keyText)) weight += 120;
        if (/filecomposition/i.test(pathText)) weight += 100;
        if (/markupcontext/i.test(keyText)) weight += 90;
        if (/markupcontext/i.test(pathText)) weight += 75;
        if (/objectobidforrenditiongeneration/i.test(keyText)) weight += 90;
        if (/objectobidforrenditiongeneration/i.test(pathText)) weight += 75;
        if (/file/i.test(keyText) && !/composition/i.test(keyText)) weight -= 20;
        if (/master/i.test(keyText)) weight -= 25;
        if (/uid|name|title|description/i.test(keyText)) weight -= 80;
        candidates.push({
          obid,
          key: key || '',
          sourcePath: sourcePath || '',
          weight
        });
      });
    }
    addCandidate('normalized.obid', result?.obid, 'result.obid');
    [
      'DocumentReviewVersionOBID',
      'documentReviewVersionOBID',
      'FileCompositionOBID',
      'fileCompositionOBID',
      'ObjectOBIDForRenditionGeneration',
      'objectOBIDForRenditionGeneration',
      'RevisionOBID',
      'DocumentRevisionOBID',
      'VersionOBID',
      'CompositionOBID',
      'RenditionOBID',
      'MarkupContextOBID',
      'markupContextOBID',
      'HistoryOBID',
      'HistoryObjectOBID',
      'OBID',
      'ObjectOBID'
    ].forEach(k => addCandidate(k, raw[k], `raw.${k}`));
    function scan(obj, path, depth) {
      if (!obj || typeof obj !== 'object' || depth > 4) return;
      Object.keys(obj).forEach(key => {
        const value = obj[key];
        const nextPath = path ? `${path}.${key}` : key;
        if (typeof value === 'string' || typeof value === 'number') {
          addCandidate(key, value, nextPath);
        } else if (value && typeof value === 'object') {
          scan(value, nextPath, depth + 1);
        }
      });
    }
    scan(raw, 'raw', 0);
    const map = new Map();
    candidates.forEach(c => {
      const existing = map.get(c.obid);
      if (!existing || c.weight > existing.weight) {
        map.set(c.obid, c);
      }
    });
    return [...map.values()].sort((a, b) => b.weight - a.weight);
  }
  function buildHistoryViewUrlFromObid(obid) {
    if (!obid) return '';
    const base = `${window.location.origin}${window.location.pathname}`;
    const configEncoded = encodeURIComponent(JSON.stringify([SETTINGS.projectConfigUid]));
    const contextEncoded = encodeURIComponent(JSON.stringify([obid]));
    return `${base}#/external/HistoryViewRoute;config=${configEncoded};MethodOBID=${SETTINGS.historyMethodObid};ContextObjectOBIDs=${contextEncoded};ClientAPI=HistoryViewRoute`;
  }
  function buildDocumentsListUrl(searchText, entityType, titleLabel) {
    const type = entityType || SETTINGS.entityType;
    const label = titleLabel || 'All Documents';
    // The Consolidated Renditions entity doesn't have Alt_Doc_Name/
    // Title/Attached_File - filtering on them (like the main entity)
    // produces "Invalid $filter parameter supplied" here too, same as
    // the raw API search fixed a few versions back.
    const fields = type === SETTINGS.consolidatedEntityType
      ? SETTINGS.consolidatedSearchFields
      : ['Name', 'Alt_Doc_Name', 'Title', 'Attached_File'];
    const base = `${window.location.origin}${window.location.pathname}`;
    const queryFilter = {
      filters: [
        {
          logic: 'and',
          filters: [
            {
              logic: 'and',
              filters: [
                {
                  logic: 'or',
                  filters: fields.map(field => ({ logic: 'and', field, operator: 'contains', value: `*${searchText}` }))
                }
              ]
            }
          ]
        }
      ],
      pageSize: 100,
      page: 1,
      ignoreQueryBySelectedConfig: false,
      isLoaded: true,
      ignoreEffectivity: false,
      returnMarkedForDeleteObjects: false,
      relatedItemFilters: [],
      entityType: type,
      config: {
        key: SETTINGS.projectConfigUid,
        value: SETTINGS.projectConfigValue
      }
    };
    const queryFilterEncoded = encodeURIComponent(JSON.stringify(queryFilter));
    const configEncoded = encodeURIComponent(JSON.stringify([SETTINGS.projectConfigUid]));
    const titleEncoded = encodeURIComponent(label);
    const searchId = `GlobalSearch:${crypto.randomUUID ? crypto.randomUUID() : Date.now()}`;
    return `${base}#/results;queryFilter=${queryFilterEncoded};config=${configEncoded};title=${titleEncoded};searchId=${searchId};selected=${SETTINGS.projectConfigUid}`;
  }
  function buildDocumentsListUrlForResult(result, entityType, titleLabel) {
    const searchText =
      result.name ||
      result.altName ||
      result.title ||
      result.attachedFile ||
      result.query;
    return buildDocumentsListUrl(searchText, entityType, titleLabel);
  }
  function renderHistoryButtonsForResult(result, primaryLabel, entityType, titleLabel) {
    const candidates = collectObidCandidates(result).slice(0, 4);
    const fallbackUrl = buildDocumentsListUrlForResult(result, entityType, titleLabel);
    if (!candidates.length) {
      return `
        <button class="warn" data-open-rev="${escapeHtml(fallbackUrl)}">
          OBID Missing, Open Documents List
        </button>
      `;
    }
    const buttons = candidates.map((c, idx) => {
      const label = idx === 0
        ? primaryLabel
        : `Try Alternate History Target ${idx + 1}`;
      return `
        <button class="${idx === 0 ? '' : 'secondary'}" data-open-rev="${escapeHtml(buildHistoryViewUrlFromObid(c.obid))}">
          ${escapeHtml(label)}
        </button>
      `;
    }).join('');
    return `
      ${buttons}
      <button class="secondary" data-open-rev="${escapeHtml(fallbackUrl)}">
        Open Documents List Fallback
      </button>
    `;
  }
  function renderObidCandidateSummary(result) {
    const candidates = collectObidCandidates(result).slice(0, 4);
    if (!candidates.length) {
      return `<div>OBID candidates: <code>none found</code></div>`;
    }
    return `
      <div>OBID candidates:</div>
      ${candidates.map(c => `
        <div>
          <code>${escapeHtml(c.obid)}</code>
          <span class="sdx-prevsub-muted">
            weight ${escapeHtml(c.weight)} from ${escapeHtml(c.sourcePath || c.key)}
          </span>
        </div>
      `).join('')}
    `;
  }
  function renderConsolidatedSection(items) {
    if (!items.length) return '';
    const rows = items.map(item => {
      // HistoryViewRoute is confirmed invalid for this entity (live
      // test: "Method name: HistoryRoute" warning dialog). The real
      // "open PDF" flow (confirmed via network capture) is the
      // Id -> FileComposition OBID -> RetrieveFileUris chain run by
      // openConsolidatedPdf() below. The Documents List link is kept
      // as a secondary fallback in case that lookup ever comes back
      // empty for a given record.
      const listUrl = buildDocumentsListUrlForResult(item, SETTINGS.consolidatedEntityType, 'Consolidated Renditions');
      return `
        <div class="sdx-prevsub-consolidated-row">
          <div class="sdx-prevsub-result-title">${escapeHtml(item.name || item.title || 'Consolidated rendition')}</div>
          <div>Title: <code>${escapeHtml(item.title || '')}</code></div>
          <div>Doc Rev: <code>${escapeHtml(item.revision || '')}</code></div>
          <div>Rev State: <code>${escapeHtml(item.revState || '')}</code></div>
          <div>Contract: <code>${escapeHtml(item.contract || '')}</code></div>
          <div>Return Code: <code>${escapeHtml(item.returnCode || '')}</code></div>
          <div>Classification: <code>${escapeHtml(item.classification || '')}</code></div>
          <div>Returned: <code>${escapeHtml(item.updated || item.created || '')}</code></div>
          <div>Rendition Id: <code>${escapeHtml(item.obid || '')}</code></div>
          <button class="best" data-dock-consolidated-obid="${escapeHtml(item.obid || '')}" data-dock-label="${escapeHtml(item.name || item.title || 'Consolidated rendition')}">
            Open Side-by-Side (with prior review comments)
          </button>
          <button class="best" data-open-consolidated-obid="${escapeHtml(item.obid || '')}">
            Open Consolidated PDF in New Tab
          </button>
          <button class="secondary" data-open-rev="${escapeHtml(listUrl)}">
            Open Consolidated Renditions List Fallback
          </button>
          <button class="secondary" data-copy-json="${escapeHtml(JSON.stringify(item.raw, null, 2))}">Copy Raw Result</button>
        </div>
      `;
    }).join('');
    return `
      <div class="sdx-prevsub-consolidated-box">
        <div class="sdx-prevsub-consolidated-title">Consolidated Rendition Found - Prior Review Comments Available</div>
        <div class="sdx-row">This document appears to have a consolidated rendition from a previous review cycle. Check it first.</div>
        ${rows}
      </div>
    `;
  }
  /********************************************************************
   * UI REFRESH AND SEARCH
   ********************************************************************/
  function refreshPanel() {
    if (!shouldShowHelper()) {
      removeUi();
      return;
    }
    refreshProjectConfig();
    const detected = detectCurrentDocument();
    if (!detected.docNo && getContextObjectObid() && getContextObjectObid() !== contextFetchedFor) {
      fetchContextDocument().then(found => { if (found) refreshPanel(); });
    }
    const queries = createQueries(detected);
    const docEl = document.querySelector('#sdx-prevsub-doc');
    const titleEl = document.querySelector('#sdx-prevsub-title');
    const revEl = document.querySelector('#sdx-prevsub-current-rev');
    const sourceEl = document.querySelector('#sdx-prevsub-source');
    const projectEl = document.querySelector('#sdx-prevsub-project');
    const queriesEl = document.querySelector('#sdx-prevsub-queries');
    const tokenStatusEl = document.querySelector('#sdx-prevsub-token-status');
    if (docEl) docEl.textContent = detected.docNo || 'Not detected';
    if (titleEl) titleEl.textContent = detected.title || 'Not detected';
    if (revEl) revEl.textContent = detected.currentRev || 'Not detected';
    if (sourceEl) sourceEl.textContent = detected.source || 'none';
    const companionEl = document.querySelector('#sdx-prevsub-companion');
    if (companionEl) {
      companionEl.textContent =
        `extension frame: ${frameStatusAt ? 'connected' : 'NOT connected'}; ` +
        `viewer frame: ${viewerStatusAt ? (placedLauncherRect() ? 'connected, button placed' : 'connected, toolbar not found') : 'NOT connected'}`;
    }
    if (projectEl) {
      projectEl.textContent = projectConfigDetected
        ? SETTINGS.projectConfigUid
        : 'not detected from the page URL';
      projectEl.className = projectConfigDetected ? 'sdx-prevsub-good' : 'sdx-prevsub-bad';
    }
    if (queriesEl) {
      queriesEl.innerHTML = queries
        .map(q => `<span class="sdx-prevsub-query"><code>${escapeHtml(q)}</code></span>`)
        .join('');
    }
    const authStatus = getAuthorizationStatus();
    if (tokenStatusEl) {
      tokenStatusEl.textContent = authStatus.label;
      tokenStatusEl.className =
        authStatus.state === 'ok' ? 'sdx-prevsub-good' :
        authStatus.state === 'expired' ? 'sdx-prevsub-warn' :
        'sdx-prevsub-bad';
    }
    const resultsEl = document.querySelector('#sdx-prevsub-results');
    const hasExistingResults = Boolean(resultsEl && resultsEl.innerHTML.trim());
    if (!detected.docNo && !detected.title) {
      setStatus('<span class="sdx-prevsub-bad">Could not detect current document from this viewAndMarkup page.</span>');
    } else if (authStatus.state === 'missing') {
      setStatus('<span class="sdx-prevsub-warn">Document detected, but no SDx token captured yet. Run a normal SDx search (any tab), or click "Force Re-scan Token".</span>');
    } else if (authStatus.state === 'expired') {
      setStatus('<span class="sdx-prevsub-warn">Document detected, but the captured token looks expired. Click "Force Re-scan Token", or refresh SDx.</span>');
    } else if (hasExistingResults) {
      setStatus('<span class="sdx-prevsub-good">Showing previous search results. Click "Find Previous Versions" to refresh.</span>');
    } else {
      setStatus('<span class="sdx-prevsub-good">Ready for this review document. Auth token appears captured.</span>');
    }
  }
  function forceFreshDetection() {
    if (!shouldShowHelper()) {
      removeUi();
      return;
    }
    setResults('');
    setStatus('<span class="sdx-prevsub-warn">Refreshing detection from this tab...</span>');
    setTimeout(refreshPanel, 350);
    setTimeout(refreshPanel, 1200);
  }
  async function runConsolidatedSearch(detected, onStep, silent) {
    const consolidatedQueries = createConsolidatedQueries(detected);
    const all = [];
    const errors = [];
    for (let i = 0; i < consolidatedQueries.length; i++) {
      const q = consolidatedQueries[i];
      if (!silent) setStatus(`Checking Consolidated Renditions ${i + 1} of ${consolidatedQueries.length}: <code>${escapeHtml(q)}</code>`);
      try {
        const json = await apiSearch(q, SETTINGS.consolidatedEntityType, undefined, SETTINGS.consolidatedSearchFields);
        all.push(...normalizeConsolidatedResults(json, q));
      } catch (err) {
        errors.push(`${q}: ${err.message}`);
        if (/401|403|Unauthorized|authorization token|Authorization has been denied|rejected\/expired/i.test(err.message)) {
          if (typeof onStep === 'function') onStep();
          break;
        }
      }
      if (typeof onStep === 'function') onStep();
      await sleep(SETTINGS.requeryDelayMs);
    }
    const deduped = dedupeByUid(all);
    const matches = deduped
      .filter(item => consolidatedMatchesDetected(item, detected))
      .sort((a, b) => {
        const ra = getPrimaryRevisionValue(a);
        const rb = getPrimaryRevisionValue(b);
        if (ra !== null && rb !== null && ra !== rb) return rb - ra;
        return getResultSortDate(b) - getResultSortDate(a);
      })
      .slice(0, 3);
    return { matches, errors };
  }
  async function runApiSearch() {
    if (!shouldShowHelper()) {
      removeUi();
      return;
    }
    const detected = detectCurrentDocument();
    const queries = createQueries(detected);
    setResults('');
    if (!queries.length) {
      setStatus('<span class="sdx-prevsub-bad">No search terms generated.</span>');
      return;
    }
    const consolidatedQueryCount = createConsolidatedQueries(detected).length;
    const totalSteps = queries.length + consolidatedQueryCount;
    let completedSteps = 0;
    const bumpProgress = () => {
      completedSteps++;
      setProgressPercent(totalSteps ? (completedSteps / totalSteps) * 100 : 100);
    };
    showProgress();
    try {
      const all = [];
      const errors = [];
      for (let i = 0; i < queries.length; i++) {
        const q = queries[i];
        setStatus(`API searching ${i + 1} of ${queries.length}: <code>${escapeHtml(q)}</code>`);
        try {
          const json = await apiSearch(q, SETTINGS.entityType);
          const normalized = normalizeApiResults(json, q);
          all.push(...normalized);
        } catch (err) {
          errors.push(`${q}: ${err.message}`);
          if (/401|403|Unauthorized|authorization token|Authorization has been denied|rejected\/expired/i.test(err.message)) {
            bumpProgress();
            break;
          }
        }
        bumpProgress();
        await sleep(SETTINGS.requeryDelayMs);
      }
      const { matches: consolidatedMatches, errors: consolidatedErrors } = await runConsolidatedSearch(detected, bumpProgress);
      setProgressPercent(100);
      const ranked = mergeAndRankResults(all, detected);
      const revisions = buildRevisionList(ranked, detected);
      const allErrors = [...errors, ...consolidatedErrors];
      if (!ranked.length) {
        setStatus('<span class="sdx-prevsub-warn">API search completed, but no strong matches were ranked.</span>');
        renderNoResults(queries, allErrors, consolidatedMatches);
        return;
      }
      const bestPrevious = getBestPreviousRevision(revisions);
      if (consolidatedMatches.length) {
        setStatus(`<span class="sdx-prevsub-bad">Consolidated rendition with prior review comments found - check it before reviewing.</span>`);
      } else if (bestPrevious) {
        setStatus(`<span class="sdx-prevsub-good">Found likely previous document version: Rev ${escapeHtml(bestPrevious.revLabel || '?')}.</span>`);
      } else {
        setStatus('<span class="sdx-prevsub-warn">Found matches, but no definite previous revision was identified.</span>');
      }
      renderResults(ranked, revisions, queries, allErrors, detected, consolidatedMatches);
    } finally {
      setTimeout(hideProgress, 400);
    }
  }
  /********************************************************************
   * RENDER RESULTS
   ********************************************************************/
  function renderRevisionList(revisions, detected) {
    if (!revisions.length) {
      return `
        <div class="sdx-prevsub-result">
          <b>Previous Document Versions</b>
          <br>
          No revision rows could be isolated from the API results.
        </div>
      `;
    }
    const bestPrevious = getBestPreviousRevision(revisions);
    const bestButton = bestPrevious
      ? `
        ${renderHistoryButtonsForResult(
          bestPrevious,
          `Open Best Previous Version History, Rev ${bestPrevious.revLabel || '?'}`
        )}
      `
      : `
        <span class="sdx-prevsub-warn">No definite previous revision was identified.</span>
      `;
    const rows = revisions.map(r => {
      const relationClass =
        r.relation === 'previous' ? 'previous' :
        r.relation === 'current' ? 'current' :
        'unknown';
      const relationLabel =
        r.relation === 'previous' ? 'Previous version' :
        r.relation === 'current' ? 'Current/latest version' :
        r.relation === 'newer' ? 'Newer than detected' :
        'Revision candidate';
      const primaryButton = renderHistoryButtonsForResult(r, 'Open This Version History');
      return `
        <div class="sdx-prevsub-rev ${relationClass}">
          <div class="sdx-prevsub-result-title">
            ${escapeHtml(relationLabel)}: Rev ${escapeHtml(r.revLabel || '?')}
          </div>
          ${renderObidCandidateSummary(r)}
          <div>Name: <code>${escapeHtml(r.name || '')}</code></div>
          <div>Title: <code>${escapeHtml(r.title || '')}</code></div>
          <div>Alt Doc Name: <code>${escapeHtml(r.altName || '')}</code></div>
          <div>Attached File: <code>${escapeHtml(r.attachedFile || '')}</code></div>
          <div class="sdx-prevsub-muted">
            Score: ${escapeHtml(r.score || '')} |
            Found using: <code>${escapeHtml(r.query || '')}</code>
          </div>
          ${primaryButton}
          <button class="secondary" data-copy-json="${escapeHtml(JSON.stringify(r.raw, null, 2))}">
            Copy Raw Result
          </button>
        </div>
      `;
    }).join('');
    return `
      <div class="sdx-prevsub-result">
        <b>Previous Document Versions</b>
        <div class="sdx-row">
          Detected current review revision:
          <code>${escapeHtml(detected.currentRev || 'not detected')}</code>
        </div>
        <div class="sdx-row">
          Primary action tries:
          <code>HistoryViewRoute</code>
        </div>
        ${bestButton}
      </div>
      ${rows}
    `;
  }
  function renderResults(results, revisions, queries, errors, detected, consolidatedMatches) {
    const consolidatedHtml = renderConsolidatedSection(consolidatedMatches || []);
    const revisionHtml = renderRevisionList(revisions, detected);
    const resultHtml = results.map((r, idx) => {
      const primaryButton = renderHistoryButtonsForResult(r, 'Open History');
      return `
        <div class="sdx-prevsub-result">
          <div class="sdx-prevsub-result-title">
            ${idx + 1}. ${escapeHtml(r.name || r.title || 'Unnamed result')}
          </div>
          <div>Score: <span class="sdx-prevsub-good">${escapeHtml(r.score)}</span></div>
          ${renderObidCandidateSummary(r)}
          <div>Title: <code>${escapeHtml(r.title || '')}</code></div>
          <div>Alt Doc Name: <code>${escapeHtml(r.altName || '')}</code></div>
          <div>Attached File: <code>${escapeHtml(r.attachedFile || '')}</code></div>
          <div>Revision / Version: <code>${escapeHtml(getResultRevisionLabel(r) || '')}</code></div>
          <div class="sdx-prevsub-muted">Found using query: <code>${escapeHtml(r.query)}</code></div>
          ${primaryButton}
          <button class="secondary" data-copy-json="${escapeHtml(JSON.stringify(r.raw, null, 2))}">Copy Raw Result</button>
        </div>
      `;
    }).join('');
    const errorHtml = errors.length
      ? `<div class="sdx-prevsub-result"><b>API errors:</b><br>${errors.map(e => escapeHtml(e)).join('<br>')}</div>`
      : '';
    setResults(`
      ${consolidatedHtml}
      ${revisionHtml}
      <div class="sdx-prevsub-result"><b>All likely API matches, limited to ${SETTINGS.maxDisplayedResults}</b></div>
      ${resultHtml}
      ${errorHtml}
      <button id="sdx-prevsub-copy-queries" class="secondary">Copy Search Terms</button>
    `);
    document.querySelectorAll('[data-open-rev]').forEach(btn => {
      btn.addEventListener('click', () => openTab(btn.getAttribute('data-open-rev')));
    });
    document.querySelectorAll('[data-open-consolidated-obid]').forEach(btn => {
      btn.addEventListener('click', () => openConsolidatedPdf(btn.getAttribute('data-open-consolidated-obid'), btn));
    });
    document.querySelectorAll('[data-dock-consolidated-obid]').forEach(btn => {
      btn.addEventListener('click', () => openConsolidatedDocked(btn.getAttribute('data-dock-consolidated-obid'), btn.getAttribute('data-dock-label'), btn));
    });
    document.querySelectorAll('[data-copy-json]').forEach(btn => {
      btn.addEventListener('click', () => {
        copyText(btn.getAttribute('data-copy-json'));
        setStatus('Copied raw SDx result JSON.');
      });
    });
    document.querySelector('#sdx-prevsub-copy-queries')?.addEventListener('click', () => {
      copyText(queries.join('\n'));
      setStatus('Copied search terms.');
    });
  }
  function renderNoResults(queries, errors, consolidatedMatches) {
    const consolidatedHtml = renderConsolidatedSection(consolidatedMatches || []);
    const queryHtml = queries.map(q => {
      const url = buildDocumentsListUrl(q);
      return `
        <div class="sdx-prevsub-result">
          <code>${escapeHtml(q)}</code>
          <br>
          <button data-open-rev="${escapeHtml(url)}">Open Documents List Search</button>
        </div>
      `;
    }).join('');
    const errorHtml = errors.length
      ? `<div class="sdx-prevsub-result"><b>API errors:</b><br>${errors.map(e => escapeHtml(e)).join('<br>')}</div>`
      : '';
    setResults(`
      ${consolidatedHtml}
      <div><b>No ranked API matches. Manual search fallback:</b></div>
      ${queryHtml}
      ${errorHtml}
    `);
    document.querySelectorAll('[data-open-rev]').forEach(btn => {
      btn.addEventListener('click', () => openTab(btn.getAttribute('data-open-rev')));
    });
    document.querySelectorAll('[data-open-consolidated-obid]').forEach(btn => {
      btn.addEventListener('click', () => openConsolidatedPdf(btn.getAttribute('data-open-consolidated-obid'), btn));
    });
    document.querySelectorAll('[data-dock-consolidated-obid]').forEach(btn => {
      btn.addEventListener('click', () => openConsolidatedDocked(btn.getAttribute('data-dock-consolidated-obid'), btn.getAttribute('data-dock-label'), btn));
    });
    document.querySelectorAll('[data-copy-json]').forEach(btn => {
      btn.addEventListener('click', () => {
        copyText(btn.getAttribute('data-copy-json'));
        setStatus('Copied raw SDx result JSON.');
      });
    });
  }
  function copyDebugInfo() {
    const detected = detectCurrentDocument();
    const queries = createQueries(detected);
    const consolidatedQueries = createConsolidatedQueries(detected);
    const authStatus = getAuthorizationStatus();
    const info = {
      route: window.location.href,
      isViewAndMarkupRoute: isViewAndMarkupRoute(),
      detected,
      queries,
      consolidatedQueries,
      companion: {
        connected: frameModeActive(),
        statusAgeMs: frameStatusAt ? Date.now() - frameStatusAt : null,
        launcherRectAbsolute: placedLauncherRect(),
        viewerLauncherRect,
        qarcViewerRect,
        viewerReported: viewerDiag,
        pdfViewer: { activeTab, overlayOpen, dockTabKey, savedTabs: Array.from(dockStates.keys()), mode: dockMode, note: dockNote, stage: pdfjsStage, mainZoom: lastMainZoom, zoomSrc: lastZoomSrc, comments: dockCommentCount, syncOn: dockSyncOn, viewerUrlKnown: Boolean(pdftronUrl) },
        autoCheck: { enabled: USER_SETTINGS.autoCheckConsolidated, lastKey: autoKeyDone, match: autoMatch ? autoMatch.name : null, note: autoNote },
        viewerStatusAgeMs: viewerStatusAt ? Date.now() - viewerStatusAt : null,
        qarcFrameFound: Boolean(findQarcFrame()),
        reported: frameDiag
      },
      layoutDebug: describeLayout(),
      detectionDebug: { ...lastDetectionDebug, context: contextDebug, altDocNo: detected.altDocNo || '' },
      authStatus,
      userSettings: USER_SETTINGS,
      settings: {
        projectConfigUid: SETTINGS.projectConfigUid,
        projectConfigDetected,
        entityType: SETTINGS.entityType,
        consolidatedEntityType: SETTINGS.consolidatedEntityType,
        consolidatedSearchFields: SETTINGS.consolidatedSearchFields,
        top: SETTINGS.top,
        maxDisplayedResults: SETTINGS.maxDisplayedResults,
        hardMaxResults: HARD_MAX_RESULTS,
        historyMethodObid: SETTINGS.historyMethodObid
      },
      exampleHistoryRouteFormat: {
        config: [SETTINGS.projectConfigUid],
        MethodOBID: SETTINGS.historyMethodObid,
        ContextObjectOBIDs: ['<result OBID candidate>'],
        ClientAPI: 'HistoryViewRoute'
      },
      apiUrls: queries.map(q => buildApiUrl(q, SETTINGS.entityType)),
      consolidatedApiUrls: consolidatedQueries.map(q => buildApiUrl(q, SETTINGS.consolidatedEntityType, SETTINGS.consolidatedSearchFields))
    };
    copyText(JSON.stringify(info, null, 2));
    setStatus('Copied debug info. Token is not fully copied, only previewed.');
  }
  /********************************************************************
   * CREATE UI
   ********************************************************************/
  function createUi() {
    if (!shouldShowHelper()) {
      removeUi();
      return;
    }
    if (document.querySelector('#sdx-prevsub-panel')) {
      startLauncherLoop();
      return;
    }
    addStyles();
    const panel = document.createElement('div');
    panel.id = 'sdx-prevsub-panel';
    panel.innerHTML = `
      <div class="sdx-prevsub-header">
        <h3>SDx Previous Document Version Finder v3.0.0</h3>
        <button type="button" id="sdx-prevsub-close" class="sdx-prevsub-close-btn" title="Close">&times;</button>
      </div>
      <div class="sdx-row">
        Current document:
        <br>
        <code id="sdx-prevsub-doc">Detecting...</code>
      </div>
      <div class="sdx-row">
        Detected title:
        <br>
        <code id="sdx-prevsub-title">Detecting...</code>
      </div>
      <div class="sdx-row">
        Detected current revision:
        <br>
        <code id="sdx-prevsub-current-rev">Detecting...</code>
      </div>
      <div class="sdx-row">
        Source:
        <code id="sdx-prevsub-source">Detecting...</code>
      </div>
      <div class="sdx-row">
        Project:
        <code id="sdx-prevsub-project">Detecting...</code>
      </div>
      <div class="sdx-row">
        Toolbar companion:
        <code id="sdx-prevsub-companion">Checking...</code>
      </div>
      <div class="sdx-row">
        Token status:
        <br>
        <code id="sdx-prevsub-token-status">Checking...</code>
      </div>
      <div class="sdx-row">
        API search terms:
        <br>
        <span id="sdx-prevsub-queries"></span>
      </div>
      <button id="sdx-prevsub-run">Find Previous Versions</button>
      <div id="sdx-prevsub-progress">
        <div id="sdx-prevsub-progress-fill"></div>
      </div>
      <div class="sdx-prevsub-btn-grid">
        <button id="sdx-prevsub-refresh" class="secondary">Refresh Detection</button>
        <button id="sdx-prevsub-rescan-token" class="secondary">Force Re-scan Token</button>
        <button id="sdx-prevsub-settings-btn" class="secondary">Settings</button>
      </div>
      <div id="sdx-prevsub-settings-box" class="sdx-prevsub-settings-box">
        <div class="sdx-row">
          <label class="sdx-prevsub-checkbox-row">
            <input type="checkbox" id="sdx-prevsub-setting-outside-click">
            Close when clicking outside the popup
          </label>
        </div>
        <div class="sdx-row">
          <label class="sdx-prevsub-checkbox-row">
            <input type="checkbox" id="sdx-prevsub-setting-autocheck">
            Automatically check for a consolidated version when a review opens
          </label>
        </div>
        <div class="sdx-row">
          <label class="sdx-prevsub-checkbox-row">
            <input type="checkbox" id="sdx-prevsub-setting-idle-enabled">
            Also auto-close after inactivity, seconds:
          </label>
          <input type="number" id="sdx-prevsub-setting-autoclose" min="0" max="600" step="5">
        </div>
        <div class="sdx-row">
          Max results shown (hard limit ${HARD_MAX_RESULTS}):
          <br>
          <input type="number" id="sdx-prevsub-setting-maxresults" min="1" max="${HARD_MAX_RESULTS}" step="1">
        </div>
        <div class="sdx-prevsub-advanced-label">Advanced (only change if instructed - affects API queries)</div>
        <div class="sdx-row">
          Entity type:
          <br>
          <input type="text" id="sdx-prevsub-setting-entitytype" maxlength="64">
        </div>
        <div class="sdx-row">
          History method OBID:
          <br>
          <input type="text" id="sdx-prevsub-setting-historyobid" maxlength="64">
        </div>
        <div class="sdx-row">
          Side-by-side: right pane width override, px (0 = auto):
          <br>
          <input type="number" id="sdx-prevsub-setting-dockoffset" min="0" max="1200" step="10">
        </div>
        <button id="sdx-prevsub-settings-save">Save Settings</button>
        <button id="sdx-prevsub-settings-cancel" class="secondary">Cancel</button>
        <button id="sdx-prevsub-copy-debug" class="secondary">Copy Debug</button>
      </div>
      <div id="sdx-prevsub-status">Ready.</div>
      <div id="sdx-prevsub-results"></div>
    `;
    document.body.appendChild(panel);
    startLauncherLoop();
    const scrollTopBtn = document.createElement('button');
    scrollTopBtn.id = 'sdx-prevsub-scroll-top';
    scrollTopBtn.type = 'button';
    scrollTopBtn.title = 'Back to top';
    scrollTopBtn.textContent = '↑';
    document.body.appendChild(scrollTopBtn);
    scrollTopBtn.addEventListener('click', () => {
      panel.scrollTop = 0;
    });
    panel.addEventListener('scroll', () => {
      scrollTopBtn.style.display = panel.scrollTop > 150 ? 'block' : 'none';
    });
    // Any interaction inside the panel resets the idle auto-close timer.
    panel.addEventListener('click', scheduleAutoClose);
    panel.addEventListener('keydown', scheduleAutoClose);
    panel.addEventListener('input', scheduleAutoClose);
    document.querySelector('#sdx-prevsub-close').addEventListener('click', closePanel);
    document.querySelector('#sdx-prevsub-run').addEventListener('click', runApiSearch);
    document.querySelector('#sdx-prevsub-refresh').addEventListener('click', forceFreshDetection);
    document.querySelector('#sdx-prevsub-rescan-token').addEventListener('click', () => {
      const token = getAuthorizationHeader({ forceRescan: true });
      refreshPanel();
      setStatus(token
        ? '<span class="sdx-prevsub-good">Re-scanned storage/cookies and found a token.</span>'
        : '<span class="sdx-prevsub-bad">Still no token found anywhere. Run one manual SDx search in any tab, then try again.</span>');
    });
    const outsideClickInput = document.querySelector('#sdx-prevsub-setting-outside-click');
    const idleEnabledInput = document.querySelector('#sdx-prevsub-setting-idle-enabled');
    const autoCloseSecondsInput = document.querySelector('#sdx-prevsub-setting-autoclose');
    idleEnabledInput.addEventListener('change', () => {
      autoCloseSecondsInput.disabled = !idleEnabledInput.checked;
    });
    document.querySelector('#sdx-prevsub-settings-btn').addEventListener('click', () => {
      const box = document.querySelector('#sdx-prevsub-settings-box');
      if (!box) return;
      const showing = box.style.display === 'block';
      box.style.display = showing ? 'none' : 'block';
      if (!showing) {
        outsideClickInput.checked = USER_SETTINGS.closeOnOutsideClick;
        idleEnabledInput.checked = USER_SETTINGS.idleTimeoutEnabled;
        autoCloseSecondsInput.value = USER_SETTINGS.autoCloseSeconds;
        autoCloseSecondsInput.disabled = !USER_SETTINGS.idleTimeoutEnabled;
        document.querySelector('#sdx-prevsub-setting-maxresults').value = USER_SETTINGS.maxDisplayedResults;
        document.querySelector('#sdx-prevsub-setting-entitytype').value = USER_SETTINGS.advancedEntityType;
        document.querySelector('#sdx-prevsub-setting-historyobid').value = USER_SETTINGS.advancedHistoryMethodObid;
        document.querySelector('#sdx-prevsub-setting-dockoffset').value = USER_SETTINGS.dockRightOffsetPx;
        document.querySelector('#sdx-prevsub-setting-autocheck').checked = USER_SETTINGS.autoCheckConsolidated;
      }
    });
    document.querySelector('#sdx-prevsub-settings-save').addEventListener('click', () => {
      const closeOnOutsideClick = outsideClickInput.checked;
      const idleTimeoutEnabled = idleEnabledInput.checked;
      const autoCloseInput = autoCloseSecondsInput.value;
      const maxResultsInput = document.querySelector('#sdx-prevsub-setting-maxresults').value;
      const advancedEntityType = document.querySelector('#sdx-prevsub-setting-entitytype').value;
      const advancedHistoryMethodObid = document.querySelector('#sdx-prevsub-setting-historyobid').value;
      const saved = saveUserSettings({
        closeOnOutsideClick,
        idleTimeoutEnabled,
        autoCloseSeconds: autoCloseInput,
        maxDisplayedResults: maxResultsInput,
        advancedEntityType,
        advancedHistoryMethodObid,
        dockRightOffsetPx: document.querySelector('#sdx-prevsub-setting-dockoffset').value,
        autoCheckConsolidated: document.querySelector('#sdx-prevsub-setting-autocheck').checked
      });
      document.querySelector('#sdx-prevsub-setting-dockoffset').value = saved.dockRightOffsetPx;
      layoutDock();
      outsideClickInput.checked = saved.closeOnOutsideClick;
      idleEnabledInput.checked = saved.idleTimeoutEnabled;
      autoCloseSecondsInput.value = saved.autoCloseSeconds;
      autoCloseSecondsInput.disabled = !saved.idleTimeoutEnabled;
      document.querySelector('#sdx-prevsub-setting-maxresults').value = saved.maxDisplayedResults;
      document.querySelector('#sdx-prevsub-setting-entitytype').value = saved.advancedEntityType;
      document.querySelector('#sdx-prevsub-setting-historyobid').value = saved.advancedHistoryMethodObid;
      SETTINGS.entityType = saved.advancedEntityType;
      SETTINGS.historyMethodObid = saved.advancedHistoryMethodObid;
      document.querySelector('#sdx-prevsub-settings-box').style.display = 'none';
      setStatus(`<span class="sdx-prevsub-good">Settings saved. Outside-click close: ${saved.closeOnOutsideClick ? 'on' : 'off'}, idle timeout: ${saved.idleTimeoutEnabled ? saved.autoCloseSeconds + 's' : 'off'}, max results: ${saved.maxDisplayedResults}.</span>`);
      scheduleAutoClose();
    });
    document.querySelector('#sdx-prevsub-settings-cancel').addEventListener('click', () => {
      document.querySelector('#sdx-prevsub-settings-box').style.display = 'none';
    });
    document.querySelector('#sdx-prevsub-copy-debug').addEventListener('click', copyDebugInfo);
    installPanelAutoCloseWatchers();
    forceFreshDetection();
  }
  /********************************************************************
   * AUTOMATIC CONSOLIDATED-VERSION CHECK + POPUP
   ********************************************************************/
  let autoKeyDone = '';
  let dockSetScale = null;
  let dockBuffer = null;
  let lastZoomSrc = '';
  let lastMainZoom = 0;
  let ribbonAbs = null;
  let autoKeySeen = '';
  let autoSeenAt = 0;
  const AUTO_CHECK_DELAY_MS = 3000;
  let autoRunning = false;
  let autoMatch = null;
  let autoNote = '';
  let autoRetryAt = 0;
  let toastTimer = 0;
  let toastPosTimer = 0;
  function autoKeyNow() {
    const d = detectCurrentDocument();
    return d.docNo ? `${d.docNo}|${d.altDocNo || ''}|${getContextObjectObid()}` : '';
  }
  function isExactConsolidatedMatch(item, detected) {
    const norm = v => String(v || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const name = norm(item.name);
    const alt = norm(item.altName);
    const wanted = [detected.docNo, detected.altDocNo].map(norm).filter(Boolean);
    return wanted.some(w => name === w || alt === w || name.includes(w) || alt.includes(w));
  }
  function hideToast() {
    clearTimeout(toastTimer);
    clearInterval(toastPosTimer);
    document.querySelector('#sdx-prevsub-toast')?.remove();
  }
  function positionToast() {
    const t = document.querySelector('#sdx-prevsub-toast');
    if (!t) return;
    let r = placedLauncherRect();
    if (!r) {
      const b = document.getElementById(LAUNCHER_ID);
      if (b) { const br = b.getBoundingClientRect(); r = [br.left, br.top, br.right, br.bottom]; }
    }
    if (!r) { t.style.top = 'auto'; t.style.bottom = '16px'; t.style.right = '16px'; return; }
    t.style.right = `${Math.max(12, Math.round(window.innerWidth - r[2]))}px`;
    if (r[3] > window.innerHeight / 2) {      // floating button near the bottom: open upward
      t.style.top = 'auto';
      t.style.bottom = `${Math.round(window.innerHeight - r[1] + 8)}px`;
    } else {
      t.style.bottom = 'auto';
      t.style.top = `${Math.round(r[3] + 8)}px`;
    }
  }
  function buildToast(autoHideMs) {
    hideToast();
    const t = document.createElement('div');
    t.id = 'sdx-prevsub-toast';
    t.style.cssText = 'position:fixed;z-index:2147483646;width:230px;box-sizing:border-box;background:#fff;color:#222;border:1px solid #c8c8c8;border-left:3px solid #6c4bd3;border-radius:5px;box-shadow:0 2px 8px rgba(0,0,0,0.22);padding:6px 8px;font:11px "Segoe UI",Arial,sans-serif;';
    document.body.appendChild(t);
    positionToast();
    toastPosTimer = setInterval(positionToast, 1000);
    toastTimer = setTimeout(hideToast, autoHideMs);
    return t;
  }
  function toastButton(text, primary, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.style.cssText = `border:1px solid #6c4bd3 !important;border-radius:3px !important;padding:3px 10px !important;font-size:10px !important;line-height:1.2 !important;cursor:pointer;margin:0 !important;width:auto !important;min-width:0 !important;height:auto !important;white-space:nowrap !important;flex:0 0 auto !important;${primary ? 'background:#6c4bd3 !important;color:#fff !important;' : 'background:#fff !important;color:#6c4bd3 !important;'}`;
    b.addEventListener('click', fn);
    return b;
  }
  function showInfoToast(text) {
    const t = buildToast(9000);
    const line = document.createElement('div');
    line.textContent = text;
    t.appendChild(line);
  }
  function showConsolidatedToast(item) {
    const t = buildToast(30000);
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:600;margin-bottom:1px;';
    title.textContent = 'Consolidated match found';
    const sub = document.createElement('div');
    sub.style.cssText = 'color:#555;margin-bottom:5px;';
    const bits = [];
    if (item.revision !== undefined && item.revision !== '') bits.push(`Rev ${item.revision}`);
    const returned = item.updated || item.created;
    if (returned) bits.push(`returned ${returned}`);
    sub.textContent = `${bits.length ? bits.join(' • ') + '. ' : ''}Open side by side?`;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;flex-direction:row;gap:6px;align-items:center;';
    row.append(
      toastButton('Open', true, () => {
        hideToast();
        openConsolidatedDocked(item.obid, item.name, null);
      }),
      toastButton('Dismiss', false, hideToast)
    );
    t.append(title, sub, row);
  }
  // True when this review tab already has a side-by-side open.
  function sideBySideOpenForTab() {
    if (activeTab && dockStates.has(activeTab)) return true;
    return Boolean(document.querySelector('#sdx-prevsub-dock')) && dockTabKey === activeTab;
  }
  async function autoCheckTick() {
    try {
      if (!USER_SETTINGS.autoCheckConsolidated || !shouldShowHelper() || autoRunning) return;
      if (Date.now() < autoRetryAt || !getAuthorizationHeader()) return;
      const detected = detectCurrentDocument();
      if (!detected.docNo) return;
      const key = autoKeyNow();
      if (!key || key === autoKeyDone) return;
      if (sideBySideOpenForTab()) { autoKeyDone = key; autoNote = 'side-by-side already open for this tab'; hideToast(); return; }
      if (key !== autoKeySeen) { autoKeySeen = key; autoSeenAt = Date.now(); }
      if (Date.now() - autoSeenAt < AUTO_CHECK_DELAY_MS) return;
      autoRunning = true;
      autoKeyDone = key;
      autoMatch = null;
      autoNote = 'checking';
      hideToast();
      const { matches, errors } = await runConsolidatedSearch(detected, null, true);
      autoRunning = false;
      if (!matches.length && errors.length) {
        autoNote = `search errors: ${errors[0].slice(0, 120)}`;
        autoKeyDone = '';                     // try again shortly
        autoRetryAt = Date.now() + 15000;
        return;
      }
      if (autoKeyNow() !== key) { autoNote = 'document changed during check'; return; }
      const exact = matches.filter(m => isExactConsolidatedMatch(m, detected));
      autoNote = exact.length ? 'exact match found' : `no exact match (${matches.length} loose)`;
      if (exact.length && sideBySideOpenForTab()) {
        autoNote = 'exact match found (side-by-side already open)';
      } else if (exact.length) {
        autoMatch = exact[0];
        showConsolidatedToast(autoMatch);
      }
    } catch (err) {
      autoRunning = false;
      autoNote = `error: ${String(err && err.message || err).slice(0, 120)}`;
    }
  }
  /********************************************************************
   * BOOT
   ********************************************************************/
  async function boot() {
    await waitForBody();
    if (shouldShowHelper()) {
      createUi();
    } else {
      removeUi();
    }
    document.addEventListener('keydown', e => {
      if (!shouldShowHelper()) return;
      if (e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        createUi();
        togglePanel();
      }
      if (e.altKey && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        createUi();
        openPanel();
        runApiSearch();
      }
    });
    let lastHref = window.location.href;
    function handleRouteChange() {
      if (window.location.href === lastHref) return;
      lastHref = window.location.href;
      hideToast();
      autoKeyDone = '';
      autoKeySeen = '';
      if (shouldShowHelper()) {
        createUi();
        clearPerPageState();
        forceFreshDetection();
      } else {
        removeUi();
      }
    }
    // hashchange/popstate catch SPA route changes immediately; the
    // interval is kept only as a fallback safety net.
    window.addEventListener('hashchange', handleRouteChange);
    window.addEventListener('popstate', handleRouteChange);
    setInterval(handleRouteChange, 500);
    setInterval(autoCheckTick, 2500);
    setInterval(() => {
      try {
        const dockEl = document.querySelector('#sdx-prevsub-dock');
        if (dockEl) {
          if (overlayOpen || (activeTab && dockTabKey && activeTab !== dockTabKey)) closeDock();   // state is kept for its own tab
        } else if (!overlayOpen && activeTab && !dockReopening && dockStates.has(activeTab)) {
          const st = dockStates.get(activeTab);
          dockReopening = true;
          showDock(st.uri, st.label, st.buffer).finally(() => { dockReopening = false; });
        }
      } catch { /* ignore */ }
    }, 500);
  }
  if (IS_QARC_COMPANION) {
    startFrameModule();
  } else if (IS_VIEWER_COMPANION) {
    startViewerModule();
  } else {
    boot();
  }
})();
