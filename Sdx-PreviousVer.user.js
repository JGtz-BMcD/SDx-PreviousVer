// ==UserScript==
// @name         SDx Previous Document Version Finder
// @namespace    bmcd-sdx-Previous
// @version      2.0
// @description  Finds previous SDx document versions and consolidated (previously-reviewed) renditions from viewAndMarkup pages.
// @author       Josue Gutierrez
// @match        https://bum04-sdx.intergraphsmartcloud.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @grant        GM_openInTab
// @grant        GM_setClipboard
// @downloadURL https://raw.githubusercontent.com/JGtz-BMcD/SDx-PreviousVer/main/Sdx-PreviousVer.user.js
// @updateURL https://raw.githubusercontent.com/JGtz-BMcD/SDx-PreviousVer/main/Sdx-PreviousVer.user.js
// ==/UserScript==
/*
 * v1.1 changelog (auth hardening, mirrors verified fixes in the
 * sibling "SDx Searcher" and "SDx Reviewer" scripts):
 *  - Token is now persisted to localStorage (shared across tabs on
 *    this origin), not just sessionStorage (scoped to one tab).
 *    SDx opens review/history views in NEW tabs, so a token only
 *    captured into sessionStorage never reached those tabs - this
 *    was the actual root cause of "works after I search once
 *    elsewhere, still 401s here."
 *  - Live 'storage' event listener picks up a token captured in
 *    another SDx tab with no manual refresh.
 *  - JWT payload is decoded to check `exp` before trusting a cached
 *    token, so a stale token is proactively discarded instead of
 *    firing a request we already know will 401.
 *  - On a 401/403, the cached token is invalidated and storage is
 *    re-scanned once for a fresher one before failing.
 *  - Storage scan now also checks cookies, and keeps scanning past
 *    the first hit to prefer the token with the longest remaining
 *    life.
 *  - Added a visible token status readout + "Force Re-scan Token"
 *    button for manual recovery.
 *  - Added defensive SPFCreateConfigUID / SPFQueryConfigUID request
 *    headers alongside spfconfiguid (a sibling script found the SDx
 *    server keys project scoping off these on some endpoints).
 *  - Route-change detection now also listens for hashchange/popstate
 *    (interval polling kept as a fallback safety net).
 *
 * v1.2 changelog:
 *  - Added an explicit "x" close button on the panel.
 *  - Panel now auto-closes when you click outside it (including a
 *    best-effort detection of focus moving into an iframe, since a
 *    click inside an iframe never bubbles to this document), and
 *    auto-closes after an idle timeout (default 20s, resets on any
 *    interaction with the panel, 0 = disabled).
 *  - Added a Settings section (persisted in localStorage) to change
 *    the auto-close idle timeout and how many results are shown.
 *    Max results is hard-capped at 20 regardless of what's entered.
 *  - Added a "Consolidated Renditions" check: searches
 *    bmcdConsolidatedDocRenditions (the project's consolidated,
 *    previously-reviewed PDF renditions with prior comments) for the
 *    same document and, if a likely match is found, surfaces it in a
 *    red callout at the top of results with a direct-open button.
 *
 * v1.3 changelog:
 *  - Fixed the Consolidated Renditions search 400ing on every query:
 *    it was filtering on Alt_Doc_Name/Title/Attached_File fields that
 *    this entity doesn't appear to have. Narrowed to filter on Name
 *    only (confirmed against a live SDx browse URL), and gave it its
 *    own query list built from the document number instead of reusing
 *    the title-heavy main-entity query list. Matching against the
 *    detected document now also accepts the short "PKG-SEQ" form
 *    (e.g. "CIT-0276") since the consolidated entity's Name field
 *    doesn't include the project number prefix.
 *  - Auto-close is now OFF by default (it was closing the panel too
 *    eagerly). It's fully inert - idle timer, outside-click, and
 *    iframe-focus close all skip their checks - until explicitly
 *    turned on via the new "Enable auto-close" checkbox in Settings.
 *  - Reopening the panel (button, Alt+P, or after an auto-close) no
 *    longer wipes out the last search's results. It used to force a
 *    full "clear and redetect" every time it opened; now it just
 *    refreshes the header fields and leaves whatever was already
 *    found on screen, noting that they're prior results.
 *  - Button layout: "Find Previous Versions" stays a full-width
 *    primary action; Refresh Detection / Force Re-scan Token /
 *    Settings are now a 2-column grid instead of stacked rows; Copy
 *    Debug moved inside the Settings section.
 *
 * v1.4 changelog:
 *  - Got a real raw record back from bmcdConsolidatedDocRenditions, so
 *    normalizeConsolidatedItem() now maps its actual fields (Name,
 *    Alt_Doc_Name, Title, Doc_Rev, Sys_Rev, Contract, Submittal,
 *    Classification, Rev_State, Return_Code, Actual_Returned,
 *    Actual_Received, Id, UID) instead of guessing. There is NO direct
 *    PDF/file-URL field on this entity at all - the old guessed
 *    directFileUrl field list is removed.
 *  - "Open Consolidated PDF" is replaced with the same OBID-based
 *    "Open History" mechanism already used for the main results list:
 *    the record's "Id" field (e.g. "SDFK000A") matches the same OBID
 *    shape used elsewhere and is fed through the existing
 *    collectObidCandidates/HistoryViewRoute machinery, with a
 *    guaranteed-working "Open Consolidated Renditions List" fallback
 *    (filtered on the confirmed Name field) alongside it.
 *  - The red callout now also shows Contract, Rev State, Return Code,
 *    and Classification from the real record, and matches are sorted
 *    by Doc_Rev (falling back to date) so the newest consolidated
 *    revision surfaces first.
 *
 * v1.5 changelog:
 *  - HistoryViewRoute is CONFIRMED invalid for this entity (live test
 *    returned "The URL you are navigating to is not valid... Method
 *    name: HistoryRoute"), so it's removed for consolidated items.
 *    A network capture of the real "open PDF" flow shows the actual
 *    record's Id field (e.g. "TJNJ000A") is NOT what RetrieveFileUris
 *    is called with - the app resolves it to a separate File
 *    Composition OBID first (e.g. "TJNJ003A") via an SPFFileComposition
 *    lookup, then POSTs Files('{compositionObid}')/Intergraph.SPF.
 *    Server.API.Model.RetrieveFileUris to get the actual file URL.
 *    Both of those steps still need to be confirmed (the lookup
 *    filter shape and the POST body/response) before a one-click
 *    "Open PDF" button can be wired up, so for now the primary action
 *    is the verified-working Consolidated Renditions list link only.
 *
 * v1.6 changelog:
 *  - Full "Open Consolidated PDF" flow, confirmed against a live
 *    network capture of the two calls the native SDx UI makes:
 *      1. GET Objects('{Id}')/SPFFileComposition_21
 *         ?$filter=SPFViewInd eq true&$top=1
 *         resolves the rendition's Id (e.g. "SDI7000A") to a File
 *         OBID (e.g. "SDI7003A").
 *      2. POST Files('{fileObid}')/Intergraph.SPF.Server.API.Model.
 *         RetrieveFileUris with body {"purposes":["Markup"],
 *         "downloadFile":false} returns a directly-openable Uri to
 *         the actual PDF.
 *    The consolidated callout's primary button now runs this chain
 *    on click and opens the resulting PDF directly. The Consolidated
 *    Renditions list link is kept as a secondary fallback in case the
 *    lookup ever comes back empty.
 *
 * v1.7 changelog:
 *  - Fixed "Invalid $filter parameter supplied" on the Consolidated
 *    Renditions list fallback link: buildDocumentsListUrl() was still
 *    filtering on Alt_Doc_Name/Title/Attached_File for that entity,
 *    which doesn't have them (same root cause as the earlier raw API
 *    fix). It now filters by the correct field list per entity.
 *  - Fixed sibling sheets in the same drawing set (e.g. "Stack, 3D
 *    View & Connection details (Sheet 1)" vs "(Sheet 2)") getting
 *    misidentified as revisions/matches of each other. The loose
 *    "3+ title words overlap" fallback match is gone from both the
 *    Consolidated Renditions matching and the "Previous Document
 *    Versions" grouping - both now require an exact document number
 *    match, since title-word overlap is meaningless when every sheet
 *    in a series shares near-identical boilerplate titles. (The
 *    broader "All likely API matches" list still uses word-overlap
 *    scoring, since that list is meant to be a broad net.)
 *  - Split the old single "auto-close" toggle into two independent
 *    settings: "close on outside click" (default ON, matches the
 *    original request) and "idle timeout auto-close" (default OFF,
 *    the part that was too aggressive).
 *  - "All likely API matches" now defaults to showing 5 instead of
 *    12 (still adjustable in Settings, still hard-capped at 20).
 *  - Removed the Updated/Created fields from the main results and
 *    Previous Document Versions displays - the AllDocuments entity
 *    doesn't appear to populate any of the date field names this
 *    script knows about, so they were always blank clutter. (The
 *    Consolidated Renditions callout's "Returned" date is unaffected
 *    - that one's real.)
 *  - Bigger, full-width "Find Previous Versions" button; the
 *    secondary button grid below it is slightly smaller.
 *  - Added a "back to top" button that appears once you've scrolled
 *    down a bit in a long results list.
 *
 * v2.0 changelog - first version intended for sharing with other
 * personnel (their own SDx login, likely different SDx projects):
 *  - CRITICAL multi-project fix: the project config UID/value
 *    (previously hardcoded to PR_186688 / 186688) is now detected
 *    from the current page's own URL on every load and route change,
 *    via the same `config=["PR_XXXXXX"]` segment this script already
 *    reads/writes when building its own links elsewhere. Without this
 *    fix, every other user's searches - regardless of which project
 *    they were actually reviewing - would have been silently scoped
 *    to project 186688, mixing document results across unrelated
 *    projects/clients. A "Project" row in the panel shows what was
 *    detected; if detection ever fails, it falls back to PR_186688
 *    and visibly flags that it's a fallback rather than failing
 *    silently. The entity/method identifiers (AllDocuments_68290,
 *    the HistoryViewRoute method OBID, the Consolidated Renditions
 *    entity name) appear to be tenant-wide constants rather than
 *    per-project, so they're left as-is but exposed as editable
 *    Advanced Settings in case a different project turns out to need
 *    different values.
 *  - Added a visible progress bar while a search is running - the
 *    query-by-query status text alone was easy to miss.
 *  - Fixed max-results defaulting to 12: the settings storage key was
 *    reused from earlier testing where 12 was the default and had
 *    already been saved, so the new default of 5 never took effect
 *    for that saved value. Storage key bumped to a new name for a
 *    clean slate.
 *  - Fixed the "back to top" button actually closing the popup: it's
 *    a separate floating element (not a child of the panel), so the
 *    outside-click-close handler was treating clicks on it as
 *    "outside" and closing the panel out from under it. It's now
 *    explicitly recognized as part of the popup UI.
 *  - Security/sharing audit: confirmed no credentials, tokens, or
 *    personal identifiers are hardcoded anywhere in this script - the
 *    only "identity" involved is whatever the browser's own SDx
 *    session already has, captured the same way the native UI itself
 *    authenticates. Every network call targets the SDx origin itself
 *    (same-origin fetches only, no third-party endpoints). Every
 *    place API/document data is inserted into the page goes through
 *    escapeHtml() first, so a document name/title containing HTML
 *    can't inject markup into the popup. Debug info only ever
 *    includes a truncated token preview, never the full token.
 */
(function () {
  'use strict';
  /********************************************************************
   * TOP WINDOW ONLY
   *
   * Prevent duplicate buttons inside SDx embedded review/markup frames.
   ********************************************************************/
  if (window.top !== window.self) {
    return;
  }
  /********************************************************************
   * SETTINGS
   ********************************************************************/
  // Used ONLY if the project can't be detected from the current page's
  // own URL (see detectProjectConfigUid/refreshProjectConfig below).
  // Every other user opens their own projects, so this must never be
  // relied on as the real value - it's a last-resort fallback, and the
  // UI visibly flags it as such when it's actually being used.
  const FALLBACK_PROJECT_CONFIG_UID = 'PR_186688';
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
  // Bumped to a new key name for v2.0 - the settings shape changed
  // (autoCloseEnabled split into two booleans) and the old key already
  // had a max-results value saved from earlier testing that would
  // otherwise silently override today's new default of 5.
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
    advancedHistoryMethodObid: '001A64A'
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
        advancedHistoryMethodObid: cleanIdentifier(parsed.advancedHistoryMethodObid, DEFAULT_USER_SETTINGS.advancedHistoryMethodObid)
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
      advancedHistoryMethodObid: cleanIdentifier(next.advancedHistoryMethodObid, DEFAULT_USER_SETTINGS.advancedHistoryMethodObid)
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
   * hardcoded value - see the v2.0 changelog at the top of this file
   * for why. This mirrors the same `config=["PR_XXXXXX"]` segment
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
  function shouldShowHelper() {
    if (!SETTINGS.requireViewAndMarkupRoute) return true;
    return isViewAndMarkupRoute();
  }
  function removeUi() {
    document.querySelector('#sdx-prevsub-btn')?.remove();
    document.querySelector('#sdx-prevsub-panel')?.remove();
    document.querySelector('#sdx-prevsub-scroll-top')?.remove();
  }
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  /********************************************************************
   * SDx AUTH CAPTURE
   *
   * See the v1.1 changelog at the top of this file for why this
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
  function installAuthSniffer() {
    if (window.fetch && !window.fetch.__sdxPrevSubWrapped) {
      const originalFetch = window.fetch;
      const wrappedFetch = function (input, init) {
        try {
          rememberAuthorization(extractAuthorizationFromHeaders(init && init.headers));
          if (input instanceof Request) {
            rememberAuthorization(input.headers.get('authorization'));
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
      XMLHttpRequest.prototype.open = function () {
        this.__sdxPrevSubHeaders = {};
        return originalOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        try {
          if (String(name).toLowerCase() === 'authorization') {
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
  installAuthSniffer();
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
  function getPageText() {
    return cleanText(document.body ? document.body.innerText : '');
  }
  function openTab(url) {
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
  function openPanel() {
    const panel = document.querySelector('#sdx-prevsub-panel');
    if (!panel) return;
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
        if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
          closePanel();
        }
      }, 0);
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
  function detectCurrentDocument() {
    const text = getPageText();
    const docs = extractDocumentNumbers(text);
    if (!docs.length) {
      return {
        docNo: '',
        title: '',
        currentRev: '',
        source: 'not detected'
      };
    }
    const docNo = docs[0];
    const title = extractTitleNearDoc(text, docNo);
    const currentRev = extractCurrentRevisionFromPage(text, docNo);
    return {
      docNo,
      title,
      currentRev,
      source: 'current tab viewAndMarkup page'
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
      pkg && seq ? `${pkg}-${seq}` : '',
      project && pkg ? `${project}-${pkg}` : '',
      seq,
      pkg
    ];
    return unique(candidates).slice(0, 5);
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
        spfconfiguid: SETTINGS.projectConfigUid,
        // Defensive extras: a sibling SDx script found the server keys
        // project scoping off these header names on some endpoints.
        // Harmless to include here even if this endpoint ignores them.
        spfcreateconfiguid: SETTINGS.projectConfigUid,
        spfqueryconfiguid: SETTINGS.projectConfigUid
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
        spfconfiguid: SETTINGS.projectConfigUid,
        spfcreateconfiguid: SETTINGS.projectConfigUid,
        spfqueryconfiguid: SETTINGS.projectConfigUid
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
    if (!docNo) return false;
    const haystack = [result.name, result.altName, result.attachedFile].join(' ').toLowerCase();
    return haystack.includes(docNo.toLowerCase());
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
          <button class="best" data-open-consolidated-obid="${escapeHtml(item.obid || '')}">
            Open Consolidated PDF (with prior review comments)
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
    if (projectEl) {
      projectEl.textContent = projectConfigDetected
        ? SETTINGS.projectConfigUid
        : `${SETTINGS.projectConfigUid} (fallback - could not detect from URL)`;
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
  async function runConsolidatedSearch(detected, onStep) {
    const consolidatedQueries = createConsolidatedQueries(detected);
    const all = [];
    const errors = [];
    for (let i = 0; i < consolidatedQueries.length; i++) {
      const q = consolidatedQueries[i];
      setStatus(`Checking Consolidated Renditions ${i + 1} of ${consolidatedQueries.length}: <code>${escapeHtml(q)}</code>`);
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
      authStatus,
      authPreview: getAuthorizationHeader()
        ? getAuthorizationHeader().slice(0, 18) + '...'
        : '',
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
    if (document.querySelector('#sdx-prevsub-btn')) {
      return;
    }
    addStyles();
    const btn = document.createElement('button');
    btn.id = 'sdx-prevsub-btn';
    btn.type = 'button';
    btn.textContent = '🧟 Prev Doc Ver';
    const panel = document.createElement('div');
    panel.id = 'sdx-prevsub-panel';
    panel.innerHTML = `
      <div class="sdx-prevsub-header">
        <h3>SDx Previous Document Version Finder v2.0</h3>
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
        <button id="sdx-prevsub-settings-save">Save Settings</button>
        <button id="sdx-prevsub-settings-cancel" class="secondary">Cancel</button>
        <button id="sdx-prevsub-copy-debug" class="secondary">Copy Debug</button>
      </div>
      <div id="sdx-prevsub-status">Ready.</div>
      <div id="sdx-prevsub-results"></div>
    `;
    document.body.appendChild(panel);
    document.body.appendChild(btn);
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
    btn.addEventListener('click', togglePanel);
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
        advancedHistoryMethodObid
      });
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
  }
  boot();
})();
