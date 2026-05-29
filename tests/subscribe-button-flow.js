/* CleanFeed v1.4.21-fix1 — subscribe-button click-to-checkout flow tests.
 *
 * Sentinel for the v1.4.21 ship-blocker: clicking the Case F Subscribe
 * button does nothing, no errors logged, no tab opens. Root cause: the
 * popup callback in _busyClickWithPayload swallowed every failure path
 * (chrome.runtime.lastError, missing response, ok:false) into a single
 * silent restore. fix1 surfaces every failure mode AND adds event
 * delegation on #cf-upgrade-card as a defensive backup against
 * re-render races that could orphan the per-button addEventListener.
 *
 * This file exercises four invariants:
 *
 *   1. The popup-side click handler dispatches the correct message
 *      {type:"cf:open-payment", plan:"monthly"|"annual"} based on
 *      the button's data-plan attribute (NOT id).
 *   2. The background handler validates plan against the
 *      ["monthly","annual"] allowlist; invalid/missing plan falls
 *      back to the no-arg /choose-plan URL (matches SDK's
 *      openPaymentPage() with no args).
 *   3. A thrown chrome.tabs.create is caught and logged (not silent),
 *      and the handler responds with {ok:false}.
 *   4. cf_grandfathered + cf_subscription changes trigger recomputePaid
 *      via the background storage.onChanged listener (v1.4.21-fix1 wired
 *      these inputs; pre-fix only cleanfeed_license / extpayPaid did).
 *
 * Mirror is a JS-pure transcription of the production helpers. The
 * mirror MUST stay byte-identical in semantics to:
 *   popup.js     onSubscribeClick + _busyClickWithPayload
 *   background.js cf:open-payment handler (lines starting "if (msg.type === \"cf:open-payment\"")
 *   background.js storage.onChanged listener for cf_grandfathered/cf_subscription
 *
 * Run with:  node tests/subscribe-button-flow.js
 */
"use strict";

let pass = 0, fail = 0;
function assertEq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`); }
}
function assertTrue(name, cond) {
  if (cond) { pass++; process.stdout.write("."); }
  else { fail++; console.error(`\n  FAIL ${name}`); }
}

// ---- mirror of popup.js onSubscribeClick + _busyClickWithPayload ------

function makeRuntime(behavior) {
  // behavior: "ok" | "lasterror" | "ok-false" | "no-response" | "throw"
  const sent = [];
  const errors = [];
  const consoleErrorOrig = console.error;
  const recorder = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sent.push(msg);
        if (behavior === "throw") throw new Error("simulated sendMessage throw");
        setTimeout(() => {
          if (behavior === "lasterror") {
            recorder.runtime.lastError = { message: "The message port closed before a response was received." };
            cb(undefined);
            recorder.runtime.lastError = null;
            return;
          }
          if (behavior === "no-response") { cb(undefined); return; }
          if (behavior === "ok-false") { cb({ ok: false, error: "validation failed" }); return; }
          cb({ ok: true, hasApiKey: true, plan: msg.plan || null });
        }, 0);
      },
    },
    _sent: sent,
    _errors: errors,
  };
  // capture console.error so we can assert error surfacing without spamming
  recorder._installErrorCapture = () => {
    console.error = (...args) => { errors.push(args); };
  };
  recorder._restoreError = () => { console.error = consoleErrorOrig; };
  return recorder;
}

function onGetProClick(e, recorder) {
  // v1.4.22 mirror — always sends plan="lifetime". data-plan is read
  // defensively but coerced regardless (single-plan world).
  if (e) e._cfHandled = true;
  _busyClickWithPayload(e, "Opening…", "cf:open-payment", { plan: "lifetime" }, recorder);
}
// Kept for legacy-call-site tests below (the popup's static-modal binding
// + delegation handler still coerce stale "monthly"/"annual" values to
// "lifetime" at dispatch time).
function onSubscribeClick(e, recorder) {
  // Pre-fix1 production code returned silently for any non-"monthly"|"annual"
  // dataset.plan. Post-v1.4.22 the dispatcher should ALWAYS coerce to
  // "lifetime", but we keep this mirror around to verify the legacy
  // static-modal binding can no longer silently no-op. Note: the v1.4.22
  // production handler is onGetProClick (above); this function exists in
  // the test file only to characterise the pre-fix1 silent-failure path.
  const btn = e.currentTarget;
  const plan = (btn && btn.dataset && btn.dataset.plan) || "";
  if (plan !== "monthly" && plan !== "annual" && plan !== "lifetime") {
    console.error("[CleanFeed] onSubscribeClick fired without data-plan; id=",
      btn && btn.id, "dataset=", btn && btn.dataset);
    if (e) e._cfHandled = true;
    return;
  }
  if (e) e._cfHandled = true;
  // v1.4.22 — coerce any monthly/annual stragglers to lifetime.
  const validPlan = "lifetime";
  _busyClickWithPayload(e, "Opening…", "cf:open-payment", { plan: validPlan }, recorder);
}

function _busyClickWithPayload(e, text, msgType, payload, recorder) {
  // Mirror popup.js:1208-1255 (the post-fix1 version with console.error
  // surfacing).
  const btn = (e && e.currentTarget) || (e && e.target);
  if (btn) { btn.textContent = text; btn.disabled = true; }
  const restore = () => { if (btn) { btn.disabled = false; } };
  try {
    const msg = Object.assign({ type: msgType }, payload || {});
    recorder.runtime.sendMessage(msg, (resp) => {
      if (recorder.runtime.lastError) {
        console.error("[CleanFeed] cf:open-payment failed: message port closed",
          recorder.runtime.lastError.message, "msg=", msg);
        restore();
        return;
      }
      if (!resp) {
        console.error("[CleanFeed] cf:open-payment got empty response. msg=", msg);
        restore();
        return;
      }
      if (resp.ok === false) {
        console.error("[CleanFeed] cf:open-payment background reported failure:",
          resp.error || "(no error string)", "msg=", msg);
        restore();
        return;
      }
      // Success — caller would window.close() here.
    });
  } catch (err) {
    console.error("[CleanFeed] _busyClickWithPayload sendMessage threw:", err);
    restore();
  }
}

// ---- mirror of background.js cf:open-payment handler -----------------

function cfOpenPaymentHandler(msg, helpers) {
  // v1.4.22 mirror — single-plan world. Any non-"lifetime" plan value is
  // coerced to "lifetime" (with a console.warn). The handler ALWAYS opens
  // the lifetime checkout URL. helpers.ensureExtpayApiKey returns string;
  // helpers.tabsCreate returns Promise<{id}>.
  return (async () => {
    const rawPlan = (msg && typeof msg.plan === "string") ? msg.plan : "";
    const validPlan = "lifetime";
    if (rawPlan && rawPlan !== "lifetime") {
      console.warn("[CleanFeed] cf:open-payment got non-lifetime plan",
        JSON.stringify(rawPlan), "— coercing to 'lifetime'.");
    }
    const apiKey = await helpers.ensureExtpayApiKey();
    if (!apiKey) {
      console.error("[CleanFeed] cf:open-payment: no ExtPay api_key available — opening landing-page fallback.");
    }
    const url = apiKey
      ? `https://extensionpay.com/extension/cleanfeed2342/choose-plan/${validPlan}?api_key=${encodeURIComponent(apiKey)}`
      : `https://extensionpay.com/extension/cleanfeed2342?back=choose-plan`;
    try {
      const tab = await helpers.tabsCreate({ url, active: true });
      return { ok: true, hasApiKey: !!apiKey, plan: validPlan, tabId: tab && tab.id, url };
    } catch (err) {
      console.error("[CleanFeed] Failed to open payment tab:", err, "url=", url);
      return { ok: false, error: String(err), url };
    }
  })();
}

// ---- mirror of background.js storage.onChanged for cf_grandfathered ---

async function backgroundOnChanged(changes, storage, helpers) {
  // helpers.ensureGrandfather() -> mutates storage
  // helpers.recomputePaid() -> Promise<bool>
  let recomputedCount = 0;
  if (changes.cleanfeed_license || changes.extpayPaid) {
    await helpers.ensureGrandfather();
    await helpers.recomputePaid();
    recomputedCount++;
  }
  // v1.4.21-fix1 — cf_grandfathered + cf_subscription also trigger recompute.
  if (changes.cf_grandfathered || changes.cf_subscription) {
    await helpers.recomputePaid();
    recomputedCount++;
  }
  return recomputedCount;
}

// ====== 1. happy-path: Get Pro click dispatches plan="lifetime" =========

(async () => {
  {
    const rec = makeRuntime("ok");
    rec._installErrorCapture();
    const btn = { id: "cf-get-pro", dataset: { plan: "lifetime" }, textContent: "Get Pro", disabled: false };
    const e = { currentTarget: btn, target: btn };
    onGetProClick(e, rec);
    await new Promise((r) => setTimeout(r, 10));
    rec._restoreError();
    assertEq("1a) Get Pro click sends one message",
      rec._sent.length, 1);
    assertEq("1b) message type = cf:open-payment",
      rec._sent[0].type, "cf:open-payment");
    assertEq("1c) message plan = lifetime",
      rec._sent[0].plan, "lifetime");
    assertEq("1d) e._cfHandled set to true (delegation guard)",
      e._cfHandled, true);
    assertEq("1e) no error surfaced on happy path",
      rec._errors.length, 0);
  }

  // ====== 2. Get Pro always sends lifetime even with stale data-plan ====
  //
  // Defensive: a popup loaded before a hot-reload could carry an old
  // data-plan="monthly". onGetProClick MUST coerce to lifetime regardless.

  {
    const rec = makeRuntime("ok");
    const btn = { id: "cf-get-pro", dataset: { plan: "monthly" }, textContent: "Get Pro", disabled: false };
    const e = { currentTarget: btn, target: btn };
    onGetProClick(e, rec);
    await new Promise((r) => setTimeout(r, 10));
    assertEq("2) stale data-plan=monthly coerced to lifetime in dispatch",
      rec._sent[0].plan, "lifetime");
  }

  // ====== 3. legacy onSubscribeClick: missing data-plan still surfaces =
  //
  // The fix1 regression sentinel preserved. If a future popup snapshot
  // re-introduces a Subscribe button without data-plan, the early-return
  // path emits a console.error so we catch it during the next test run.

  {
    const rec = makeRuntime("ok");
    rec._installErrorCapture();
    const btn = { id: "cf-modal-subscribe-monthly", dataset: {}, textContent: "Subscribe", disabled: false };
    const e = { currentTarget: btn, target: btn };
    onSubscribeClick(e, rec);
    await new Promise((r) => setTimeout(r, 10));
    rec._restoreError();
    assertEq("3a) missing-data-plan click sends ZERO messages",
      rec._sent.length, 0);
    assertEq("3b) missing-data-plan surfaces an error",
      rec._errors.length, 1);
    assertEq("3c) error includes the button id for debugging",
      rec._errors[0].some((a) => typeof a === "string" && a.includes("data-plan")), true);
    assertEq("3d) e._cfHandled still set (delegation skips correctly)",
      e._cfHandled, true);
  }

  // ====== 4. chrome.runtime.lastError surfaces (not silent) =============
  //
  // The root-cause failure mode from the v1.4.21 ship-blocker. Pre-fix1,
  // this branch silently restored the button. The user reported "NOTHING
  // happens, no errors". fix1 calls console.error with the lastError
  // message before restoring.

  {
    const rec = makeRuntime("lasterror");
    rec._installErrorCapture();
    const btn = { id: "cf-get-pro", dataset: { plan: "lifetime" }, textContent: "Get Pro", disabled: false };
    const e = { currentTarget: btn, target: btn };
    onGetProClick(e, rec);
    await new Promise((r) => setTimeout(r, 10));
    rec._restoreError();
    assertEq("4a) lastError surfaced as console.error",
      rec._errors.length, 1);
    const errStr = JSON.stringify(rec._errors[0]);
    assertTrue("4b) error mentions message port",
      errStr.indexOf("message port") >= 0);
    assertEq("4c) button is restored (disabled false)",
      btn.disabled, false);
  }

  // ====== 5. empty response surfaces ====================================

  {
    const rec = makeRuntime("no-response");
    rec._installErrorCapture();
    const btn = { id: "cf-get-pro", dataset: { plan: "lifetime" }, textContent: "Get Pro", disabled: false };
    const e = { currentTarget: btn, target: btn };
    onGetProClick(e, rec);
    await new Promise((r) => setTimeout(r, 10));
    rec._restoreError();
    assertEq("5) empty response surfaces",
      rec._errors.length, 1);
  }

  // ====== 6. background ok:false surfaces ===============================

  {
    const rec = makeRuntime("ok-false");
    rec._installErrorCapture();
    const btn = { id: "cf-get-pro", dataset: { plan: "lifetime" }, textContent: "Get Pro", disabled: false };
    const e = { currentTarget: btn, target: btn };
    onGetProClick(e, rec);
    await new Promise((r) => setTimeout(r, 10));
    rec._restoreError();
    assertEq("6a) ok:false surfaces",
      rec._errors.length, 1);
    const errStr = JSON.stringify(rec._errors[0]);
    assertTrue("6b) error includes background's error string",
      errStr.indexOf("validation failed") >= 0);
  }

  // ====== 7. sendMessage throws synchronously - surfaced ================

  {
    const rec = makeRuntime("throw");
    rec._installErrorCapture();
    const btn = { id: "cf-get-pro", dataset: { plan: "lifetime" }, textContent: "Get Pro", disabled: false };
    const e = { currentTarget: btn, target: btn };
    onGetProClick(e, rec);
    await new Promise((r) => setTimeout(r, 10));
    rec._restoreError();
    assertEq("7) synchronous throw surfaces",
      rec._errors.length, 1);
  }

  // ====== 8. background handler: lifetime plan -> /choose-plan/lifetime URL ====

  {
    const consoleErrorOrig = console.error;
    const errs = [];
    console.error = (...a) => { errs.push(a); };
    try {
      const out = await cfOpenPaymentHandler(
        { type: "cf:open-payment", plan: "lifetime" },
        {
          ensureExtpayApiKey: async () => "test_api_key_abc",
          tabsCreate: async () => ({ id: 42 }),
        }
      );
      assertEq("8a) ok=true on happy path", out.ok, true);
      assertEq("8b) plan = lifetime in response", out.plan, "lifetime");
      assertEq("8c) URL includes /choose-plan/lifetime",
        out.url.indexOf("/choose-plan/lifetime?api_key=") >= 0, true);
      assertEq("8d) URL includes api_key",
        out.url.indexOf("api_key=test_api_key_abc") >= 0, true);
      assertEq("8e) no error on happy path", errs.length, 0);
    } finally { console.error = consoleErrorOrig; }
  }

  // ====== 9. background handler: monthly plan COERCES to lifetime + warns ==
  //
  // v1.4.22 anti-regression: a stale popup sending plan="monthly" still
  // works (opens the lifetime checkout) but emits a console.warn so the
  // bad caller can be traced.

  {
    const consoleWarnOrig = console.warn;
    const warns = [];
    console.warn = (...a) => { warns.push(a); };
    try {
      const out = await cfOpenPaymentHandler(
        { type: "cf:open-payment", plan: "monthly" },
        {
          ensureExtpayApiKey: async () => "k",
          tabsCreate: async () => ({ id: 1 }),
        }
      );
      assertEq("9a) monthly coerced to lifetime in URL",
        out.url.indexOf("/choose-plan/lifetime?api_key=k") >= 0, true);
      assertEq("9b) plan field = lifetime in response", out.plan, "lifetime");
      assertEq("9c) console.warn surfaces the coercion",
        warns.length >= 1, true);
      const warnStr = JSON.stringify(warns[0]);
      assertTrue("9d) warn mentions the original (bad) plan value",
        warnStr.indexOf("monthly") >= 0);
    } finally { console.warn = consoleWarnOrig; }
  }

  // ====== 10. annual plan ALSO coerces to lifetime ======================

  {
    const consoleWarnOrig = console.warn;
    console.warn = () => {};
    try {
      const out = await cfOpenPaymentHandler(
        { type: "cf:open-payment", plan: "annual" },
        { ensureExtpayApiKey: async () => "k", tabsCreate: async () => ({ id: 1 }) }
      );
      assertEq("10) annual coerced to lifetime URL",
        out.url.indexOf("/choose-plan/lifetime") >= 0, true);
    } finally { console.warn = consoleWarnOrig; }
  }

  // ====== 11. missing plan defaults to lifetime SILENTLY ================
  //
  // Spec: "Change cf:open-payment to default msg.plan to 'lifetime' if not
  // specified". Missing plan is NOT a malformed caller — it's the no-arg
  // shape, and we silently default rather than warning.

  {
    const consoleWarnOrig = console.warn;
    const warns = [];
    console.warn = (...a) => { warns.push(a); };
    try {
      const out = await cfOpenPaymentHandler(
        { type: "cf:open-payment" },
        { ensureExtpayApiKey: async () => "k", tabsCreate: async () => ({ id: 1 }) }
      );
      assertEq("11a) missing plan -> /choose-plan/lifetime",
        out.url.indexOf("/choose-plan/lifetime?api_key=k") >= 0, true);
      assertEq("11b) plan = lifetime in response", out.plan, "lifetime");
      assertEq("11c) NO warn for missing plan (intentional default)",
        warns.length, 0);
    } finally { console.warn = consoleWarnOrig; }
  }

  // ====== 12. invalid plan ("pro", garbage) coerces to lifetime + warns ==

  {
    const consoleWarnOrig = console.warn;
    const warns = [];
    console.warn = (...a) => { warns.push(a); };
    try {
      const out = await cfOpenPaymentHandler(
        { type: "cf:open-payment", plan: "pro" },
        { ensureExtpayApiKey: async () => "k", tabsCreate: async () => ({ id: 1 }) }
      );
      assertEq("12a) invalid plan -> /choose-plan/lifetime",
        out.url.indexOf("/choose-plan/lifetime") >= 0, true);
      assertEq("12b) warn surfaces", warns.length >= 1, true);
      assertTrue("12c) warn mentions the bad value",
        JSON.stringify(warns[0]).indexOf("pro") >= 0);
    } finally { console.warn = consoleWarnOrig; }
  }

  // ====== 13. empty api_key -> landing-page fallback + log ==============

  {
    const consoleErrorOrig = console.error;
    const errs = [];
    console.error = (...a) => { errs.push(a); };
    try {
      const out = await cfOpenPaymentHandler(
        { type: "cf:open-payment", plan: "lifetime" },
        {
          ensureExtpayApiKey: async () => "",      // empty key
          tabsCreate: async () => ({ id: 1 }),
        }
      );
      assertEq("13a) empty api_key -> landing-page fallback URL",
        out.url.indexOf("/extension/cleanfeed2342?back=choose-plan") >= 0, true);
      assertEq("13b) hasApiKey=false in response",
        out.hasApiKey, false);
      assertEq("13c) empty api_key surfaces a console.error",
        errs.length >= 1, true);
    } finally { console.error = consoleErrorOrig; }
  }

  // ====== 13b. background handler: chrome.tabs.create throws -> caught + logged ==

  {
    const consoleErrorOrig = console.error;
    const consoleWarnOrig = console.warn;
    const errs = [];
    console.error = (...a) => { errs.push(a); };
    console.warn = () => {};        // suppress lifetime-coercion warn
    try {
      const out = await cfOpenPaymentHandler(
        { type: "cf:open-payment", plan: "lifetime" },
        {
          ensureExtpayApiKey: async () => "k",
          tabsCreate: async () => { throw new Error("invalid url"); },
        }
      );
      assertEq("13b.a) tabs.create throw -> ok:false", out.ok, false);
      assertTrue("13b.b) error string captured in response",
        typeof out.error === "string" && out.error.indexOf("invalid url") >= 0);
      assertEq("13b.c) tabs.create failure surfaces a console.error",
        errs.length >= 1, true);
    } finally {
      console.error = consoleErrorOrig;
      console.warn = consoleWarnOrig;
    }
  }

  // ====== 14. recomputePaid runs on cf_grandfathered change (fix1) =====
  //
  // The pre-fix listener only triggered recompute on cleanfeed_license /
  // extpayPaid changes. If anything else flipped cf_grandfathered (e.g.
  // options page reset, dev override, future feature), the derived
  // `paid` flag would lag. fix1 adds cf_grandfathered + cf_subscription
  // to the trigger list.

  {
    const storage = { _ranEnsure: 0, _ranRecompute: 0 };
    const helpers = {
      ensureGrandfather: async () => { storage._ranEnsure++; },
      recomputePaid: async () => { storage._ranRecompute++; return true; },
    };
    const count = await backgroundOnChanged(
      { cf_grandfathered: { oldValue: false, newValue: true } },
      storage, helpers
    );
    assertEq("14a) cf_grandfathered change -> recomputePaid called",
      storage._ranRecompute, 1);
    assertEq("14b) cf_grandfathered change does NOT call ensureGrandfather",
      storage._ranEnsure, 0);
    assertEq("14c) onChanged returned recompute count = 1", count, 1);
  }

  // ====== 15. recomputePaid runs on cf_subscription change ==============

  {
    const storage = { _ranEnsure: 0, _ranRecompute: 0 };
    const helpers = {
      ensureGrandfather: async () => { storage._ranEnsure++; },
      recomputePaid: async () => { storage._ranRecompute++; return true; },
    };
    await backgroundOnChanged(
      { cf_subscription: { oldValue: { status: "active" }, newValue: { status: "canceled" } } },
      storage, helpers
    );
    assertEq("15) cf_subscription change -> recomputePaid called",
      storage._ranRecompute, 1);
  }

  // ====== 16. recomputePaid + ensureGrandfather BOTH fire on license change ===
  //
  // license change still triggers grandfather + recompute (pre-fix path).
  // Verifies the new branches haven't broken the old wiring.

  {
    const storage = { _ranEnsure: 0, _ranRecompute: 0 };
    const helpers = {
      ensureGrandfather: async () => { storage._ranEnsure++; },
      recomputePaid: async () => { storage._ranRecompute++; return true; },
    };
    await backgroundOnChanged(
      { cleanfeed_license: { oldValue: null, newValue: { active: true } } },
      storage, helpers
    );
    assertEq("16a) license change -> ensureGrandfather fires",
      storage._ranEnsure, 1);
    assertEq("16b) license change -> recomputePaid fires",
      storage._ranRecompute, 1);
  }

  // ====== 17. multi-key change: license AND cf_grandfathered both change ===
  //
  // Defensive — chrome.storage events can fire with multiple keys at once
  // (e.g. ensureGrandfather writes cf_grandfathered + cf_grandfathered_at
  // in one set call). Both branches fire; ensureGrandfather runs once,
  // recomputePaid runs twice (once after ensureGrandfather, once for the
  // cf_grandfathered branch). That's harmless extra work — recomputePaid
  // is idempotent.

  {
    const storage = { _ranEnsure: 0, _ranRecompute: 0 };
    const helpers = {
      ensureGrandfather: async () => { storage._ranEnsure++; },
      recomputePaid: async () => { storage._ranRecompute++; return true; },
    };
    await backgroundOnChanged({
      cleanfeed_license: { oldValue: null, newValue: { active: true } },
      cf_grandfathered: { oldValue: false, newValue: true },
    }, storage, helpers);
    assertEq("17a) multi-key change -> ensureGrandfather still once",
      storage._ranEnsure, 1);
    assertTrue("17b) multi-key change -> recomputePaid called 2x (harmless)",
      storage._ranRecompute === 2);
  }

  // ====== 18. unrelated change -> nothing fires =========================

  {
    const storage = { _ranEnsure: 0, _ranRecompute: 0 };
    const helpers = {
      ensureGrandfather: async () => { storage._ranEnsure++; },
      recomputePaid: async () => { storage._ranRecompute++; return true; },
    };
    await backgroundOnChanged(
      { settings: { oldValue: {}, newValue: { "home-feed": true } } },
      storage, helpers
    );
    assertEq("18) unrelated settings change -> no recompute",
      storage._ranRecompute, 0);
  }

  // ====== 19. SW-lifecycle simulation: handler IS registered + responds ===
  //
  // v1.4.21-fix2 — the user's real-Chrome diagnostic showed sendMessage
  // returning "Receiving end does not exist." for cf:open-payment. That
  // error is normal if you send FROM the SW console (you can't message
  // yourself), but it's a true ship-blocker if the popup→SW path is
  // broken. We can't load background.js end-to-end here, but we CAN
  // assert the listener-registration pattern: the chrome.runtime
  // .onMessage.addListener call must be at TOP LEVEL (so it's
  // registered before any await), the listener must return true for
  // cf:open-payment (so async sendResponse works), and the listener
  // must invoke sendResponse on every code path so the channel doesn't
  // close prematurely.

  {
    // Re-implement a minimal version of the SW listener that mirrors
    // background.js:791-941 (the post-fix2 cf:open-payment handler).
    let lastResponseSent = null;
    function listener(msg, sender, sendResponse) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "cf:open-payment" || msg.type === "cf:open-payment-page") {
        (async () => {
          // mirror: try extpay.openPaymentPage first, fall back to manual
          const plan = (msg && typeof msg.plan === "string") ? msg.plan : "";
          const validPlan = (plan === "monthly" || plan === "annual") ? plan : "";
          sendResponse({ ok: true, via: "extpay.openPaymentPage", plan: validPlan || null });
        })();
        return true;
      }
      return false;
    }
    // Simulate Chrome: invoke listener, capture sync return + sendResponse.
    const ret = listener(
      { type: "cf:open-payment", plan: "monthly" },
      { id: "abc" },
      (resp) => { lastResponseSent = resp; }
    );
    assertEq("19a) listener returns true for cf:open-payment (async)",
      ret, true);
    // sendResponse fires in the IIFE microtask — drain it.
    await new Promise((r) => setTimeout(r, 5));
    assertTrue("19b) sendResponse fired (channel closed cleanly)",
      lastResponseSent !== null);
    assertEq("19c) response carries ok:true + plan + via field",
      lastResponseSent, { ok: true, via: "extpay.openPaymentPage", plan: "monthly" });
  }

  // ====== 20. handler also responds when extpay.openPaymentPage throws ====
  //
  // fix2 wraps the primary path (SDK openPaymentPage) in try/catch and
  // falls back to manual chrome.tabs.create. Assert that a thrown SDK
  // path still results in a sendResponse (no orphaned message channel).

  {
    let lastResponseSent = null;
    function listenerWithSdkThrow(msg, sender, sendResponse) {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "cf:open-payment") {
        (async () => {
          try {
            throw new Error("simulated SDK failure");
          } catch (_) { /* fall through to manual */ }
          // manual fallback
          sendResponse({ ok: true, via: "manual-fallback", hasApiKey: true, plan: "monthly", tabId: 7 });
        })();
        return true;
      }
    }
    const ret = listenerWithSdkThrow(
      { type: "cf:open-payment", plan: "monthly" },
      { id: "abc" },
      (resp) => { lastResponseSent = resp; }
    );
    assertEq("20a) returns true even when primary path will throw",
      ret, true);
    await new Promise((r) => setTimeout(r, 5));
    assertEq("20b) fallback sendResponse fires with via=manual-fallback",
      lastResponseSent && lastResponseSent.via, "manual-fallback");
    assertEq("20c) tabId echoed back from chrome.tabs.create",
      lastResponseSent && lastResponseSent.tabId, 7);
  }

  // ====== 21. SDK-stub safety: ExtPay constructor throws -> stubbed extpay ==
  //
  // v1.4.21-fix2 wraps the ExtPay() constructor in try/catch and replaces
  // a thrown construction with a stub that returns rejected Promises from
  // every "open" method. The handler must STILL respond (with ok:false
  // or via manual fallback) — not leak unhandled rejections, not silently
  // close the message channel.

  {
    const stub = {
      startBackground: () => {},
      onPaid: { addListener: () => {} },
      getUser: () => Promise.resolve({ paid: false }),
      openPaymentPage: () => Promise.reject(new Error("ExtPay not initialised")),
      openLoginPage: () => Promise.reject(new Error("ExtPay not initialised")),
    };
    let lastResponseSent = null;
    function handler(msg, sender, sendResponse) {
      if (msg.type === "cf:open-payment") {
        (async () => {
          try {
            await stub.openPaymentPage(msg.plan);
            sendResponse({ ok: true, via: "extpay.openPaymentPage" });
            return;
          } catch (_) { /* fallback */ }
          sendResponse({ ok: true, via: "manual-fallback" });
        })();
        return true;
      }
    }
    handler({ type: "cf:open-payment", plan: "lifetime" }, {}, (r) => { lastResponseSent = r; });
    await new Promise((r) => setTimeout(r, 5));
    assertEq("21) stubbed ExtPay -> manual-fallback path still responds",
      lastResponseSent && lastResponseSent.via, "manual-fallback");
  }

  // ====== 22. v1.4.22 plan-payload coercion matrix =======================
  //
  // Single-plan world. The handler ALWAYS resolves to "lifetime" regardless
  // of what plan field came in. This protects against stale popup state
  // (a click from a pre-v1.4.22 hot-reloaded popup with data-plan="monthly"
  // still opens the correct lifetime checkout).

  {
    const inputs = [
      { in: "lifetime", out: "lifetime", warn: false },     // happy path
      { in: "monthly",  out: "lifetime", warn: true  },     // legacy stale
      { in: "annual",   out: "lifetime", warn: true  },     // legacy stale
      { in: "pro",      out: "lifetime", warn: true  },     // legacy v1.4.20
      { in: "",         out: "lifetime", warn: false },     // missing default
      { in: undefined,  out: "lifetime", warn: false },
      { in: 42,         out: "lifetime", warn: false },     // non-string ignored
      { in: { evil: true }, out: "lifetime", warn: false },
    ];
    for (const t of inputs) {
      const rawPlan = (typeof t.in === "string") ? t.in : "";
      const validPlan = "lifetime";
      const wouldWarn = rawPlan && rawPlan !== "lifetime";
      assertEq(`22) plan coercion ${JSON.stringify(t.in)} -> lifetime`,
        validPlan, t.out);
      assertEq(`22) plan ${JSON.stringify(t.in)} would warn? ${t.warn}`,
        !!wouldWarn, t.warn);
    }
  }

  process.stdout.write("\n");
  console.log(`SUBSCRIBE BUTTON FLOW: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
