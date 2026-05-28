/* CleanFeed v1.4.21-phase2 — ExtPay subscription sync tests.
 *
 * Phase 2 introduces syncSubscriptionFromExtPay() — the single entry point
 * that translates an ExtPay user payload into cf_subscription. Called from:
 *   - chrome.runtime.onInstalled
 *   - chrome.runtime.onStartup
 *   - extpay.onPaid (replaces the v1.4.17 paid-mirror listener)
 *   - 6-hourly chrome.alarms periodic sync ("cf-extpay-sync")
 *   - cf:get-user message handler (via popup/options refresh)
 *
 * State derivation per the documented ExtPay state machine:
 *   user.paid && !user.subscriptionCancelAt          -> "active"
 *   user.paid && user.subscriptionCancelAt           -> "cancellation_pending"
 *   user.subscriptionStatus === "past_due"           -> "past_due"
 *   user.subscriptionStatus === "canceled"           -> "canceled"
 *   else                                             -> "none"
 *
 * Legacy detection (defensive — zero expected at v1.4.21 launch):
 *   user.paid === true && !subscriptionStatus && !subscriptionCancelAt
 *   -> extpayPaid = true; ensureGrandfather() fires.
 *
 * Network errors NEVER strip Pro — function exits without touching
 * cf_subscription on getUser() failure. Last-known state is preserved.
 *
 * Dev-mode escape: cf_devmode_force_sub_status (string) overrides the
 * derived status AFTER the real sync. Production code never writes this.
 *
 * The mirror MUST stay byte-identical in semantics to
 *   background.js syncSubscriptionFromExtPay
 *
 * Run with:  node tests/subscription-sync.js
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

// ---- minimal chrome.storage.local simulator ----------------------------
function makeStorage(seed) {
  const data = Object.assign({}, seed || {});
  return {
    async get(keys) {
      const out = {};
      const list = Array.isArray(keys) ? keys : (keys ? [keys] : Object.keys(data));
      for (const k of list) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async set(patch) {
      for (const k of Object.keys(patch)) data[k] = JSON.parse(JSON.stringify(patch[k]));
    },
    _peek() { return JSON.parse(JSON.stringify(data)); },
  };
}

// ---- production helpers transcribed from background.js -----------------

async function ensureGrandfather(storage) {
  const d1 = await storage.get(["cf_grandfathered", "extpayPaid", "cleanfeed_license"]);
  if (d1.cf_grandfathered === true) return;
  const hasLicense = !!(d1.cleanfeed_license && d1.cleanfeed_license.active);
  const hasLegacyExtpay = d1.extpayPaid === true;
  if (!hasLicense && !hasLegacyExtpay) return;
  const d2 = await storage.get(["cf_grandfathered"]);
  if (d2.cf_grandfathered === true) return;
  const reason = hasLegacyExtpay ? "legacy_extpay" : "license_key";
  await storage.set({
    cf_grandfathered: true,
    cf_grandfathered_at: new Date().toISOString(),
    cf_grandfathered_reason: reason,
  });
}

async function recomputePaid(storage) {
  const data = await storage.get(
    ["paid", "extpayPaid", "cleanfeed_license", "cf_grandfathered", "cf_subscription"]
  );
  const gf = data.cf_grandfathered === true;
  const sub = data.cf_subscription && data.cf_subscription.status;
  const subActive = (sub === "active" || sub === "cancellation_pending" || sub === "past_due");
  let ext = data.extpayPaid;
  const needMigration = (typeof ext !== "boolean");
  if (needMigration) ext = !!data.paid;
  const lic = !!(data.cleanfeed_license && data.cleanfeed_license.active);
  const next = gf || subActive || ext || lic;
  const patch = {};
  if (needMigration) patch.extpayPaid = ext;
  if (data.paid !== next) patch.paid = next;
  if (Object.keys(patch).length) await storage.set(patch);
  return next;
}

// Mirror of background.js syncSubscriptionFromExtPay. The storage +
// extpay-getUser hooks are abstracted so the test can inject behavior.
function makeSync(storage, getUserFn, nowFn) {
  return async function syncSubscriptionFromExtPay(prefetchedUser) {
    let user = prefetchedUser;
    if (!user) {
      try { user = await getUserFn(); }
      catch (_) { return; }       // last-known cf_subscription preserved
    }
    const next = {
      lastSyncAt: nowFn(),
      plan: user.planNickname || user.plan || null,
      cancelAt: user.subscriptionCancelAt || null,
      status: "none",
    };
    if (user.paid && !user.subscriptionCancelAt) {
      next.status = "active";
    } else if (user.paid && user.subscriptionCancelAt) {
      next.status = "cancellation_pending";
    } else if (user.subscriptionStatus === "past_due") {
      next.status = "past_due";
    } else if (user.subscriptionStatus === "canceled") {
      next.status = "canceled";
    } else {
      next.status = "none";
    }
    if (user.paid && !user.subscriptionStatus && !user.subscriptionCancelAt) {
      await storage.set({ extpayPaid: true });
      await ensureGrandfather(storage);
    }
    await storage.set({ cf_subscription: next });
    const ov = await storage.get(["cf_devmode_force_sub_status"]);
    if (ov.cf_devmode_force_sub_status && typeof ov.cf_devmode_force_sub_status === "string") {
      const forced = Object.assign({}, next, { status: ov.cf_devmode_force_sub_status });
      await storage.set({ cf_subscription: forced });
    }
    await recomputePaid(storage);
  };
}

const NOW = 1700000000000;

(async () => {
  // ===== 1. Legacy one-time-paid user — sets extpayPaid + grandfathers ===
  //
  // The defensive branch: paid=true with NEITHER subscriptionStatus NOR
  // subscriptionCancelAt populated means a legacy ExtPay buyer. Zero are
  // expected at launch but the path must work.

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
    });
    const sync = makeSync(s, async () => ({ paid: true }), () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("1a) legacy paid -> extpayPaid=true",
      peek.extpayPaid, true);
    assertEq("1b) legacy paid -> grandfathered",
      peek.cf_grandfathered, true);
    assertEq("1c) legacy paid -> reason legacy_extpay",
      peek.cf_grandfathered_reason, "legacy_extpay");
    // Per the spec state machine, paid=true && !cancelAt -> "active",
    // regardless of whether subscriptionStatus was sent. A legacy buyer
    // ends up with both cf_subscription.status="active" AND extpayPaid=true
    // AND cf_grandfathered=true. The grandfather flag is what marks them
    // as lifetime in the UI; the "active" status is harmless because Case A
    // (grandfathered) wins precedence over Case B (active subscriber).
    assertEq("1d) cf_subscription.status='active' for legacy paid buyer (spec literal)",
      peek.cf_subscription.status, "active");
    assertEq("1e) lastSyncAt updated to now",
      peek.cf_subscription.lastSyncAt, NOW);
    assertEq("1f) recomputePaid -> paid=true", peek.paid, true);
  }

  // ===== 2. Active monthly subscription ==================================

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
    });
    const sync = makeSync(s, async () => ({
      paid: true,
      subscriptionStatus: "active",
      planNickname: "monthly",
      subscriptionCancelAt: null,
    }), () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("2a) status=active",       peek.cf_subscription.status, "active");
    assertEq("2b) plan=monthly",        peek.cf_subscription.plan, "monthly");
    assertEq("2c) cancelAt=null",       peek.cf_subscription.cancelAt, null);
    assertEq("2d) recomputePaid=true",  peek.paid, true);
    // Critical: an ACTIVE subscriber must NOT be silently grandfathered.
    // Only legacy one-time buyers and license-key holders qualify.
    assertEq("2e) NOT grandfathered (subscriber)",
      peek.cf_grandfathered, false);
    // recomputePaid's v1.4.16 migration back-fills extpayPaid=false when
    // the key is absent (so legacy v1.4.16 callers can read it). What
    // matters for the canceled-subscriber-drops-to-free invariant is that
    // sync did NOT set it to TRUE — only the legacy-buyer branch does that.
    assertEq("2f) extpayPaid is false (NOT true) for active subscriber",
      peek.extpayPaid, false);
  }

  // ===== 3. Active annual + cancelAt set => cancellation_pending =========
  //
  // ExtPay state machine: paid is still true while cancelAt > now (user
  // is inside the period they paid for). plan reads from planNickname.

  {
    const s = makeStorage({
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
    });
    const sync = makeSync(s, async () => ({
      paid: true,
      subscriptionStatus: "active",
      planNickname: "annual",
      subscriptionCancelAt: 1740000000000,
    }), () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("3a) status=cancellation_pending (paid + cancelAt)",
      peek.cf_subscription.status, "cancellation_pending");
    assertEq("3b) plan=annual", peek.cf_subscription.plan, "annual");
    assertEq("3c) cancelAt=1740000000000",
      peek.cf_subscription.cancelAt, 1740000000000);
    assertEq("3d) recomputePaid=true (still inside paid period)",
      peek.paid, true);
  }

  // ===== 4. Past-due (Stripe retry grace) ================================

  {
    const s = makeStorage({});
    const sync = makeSync(s, async () => ({
      paid: false,
      subscriptionStatus: "past_due",
      planNickname: "monthly",
    }), () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("4a) past_due derived",   peek.cf_subscription.status, "past_due");
    assertEq("4b) recomputePaid=true (7-day grace)", peek.paid, true);
  }

  // ===== 5. Canceled subscription ========================================
  //
  // Drops to free unless grandfathered or licensed. Verified both ways.

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cleanfeed_license: null,
    });
    const sync = makeSync(s, async () => ({
      paid: false,
      subscriptionStatus: "canceled",
      planNickname: "monthly",
    }), () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("5a) canceled status",   peek.cf_subscription.status, "canceled");
    assertEq("5b) recomputePaid=false (canceled + no grandfather + no license)",
      peek.paid, false);
  }
  {
    // Same response, but user has a license too — license keeps them paid.
    const s = makeStorage({
      cf_grandfathered: false,
      cleanfeed_license: { active: true, key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2" },
    });
    const sync = makeSync(s, async () => ({
      paid: false,
      subscriptionStatus: "canceled",
    }), () => NOW);
    await sync();
    assertEq("5c) canceled + license active -> paid",
      s._peek().paid, true);
  }

  // ===== 6. Network error preserves last-known cf_subscription ===========
  //
  // LOAD-BEARING: a paid user must NEVER lose Pro because the network
  // blipped during a sync. This is the central defensive invariant.

  {
    const lastKnown = { status: "active", plan: "annual", cancelAt: null, lastSyncAt: 1699999999000 };
    const s = makeStorage({
      cf_subscription: Object.assign({}, lastKnown),
      paid: true,
    });
    const sync = makeSync(s, async () => { throw new Error("network down"); }, () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("6a) cf_subscription unchanged after network error",
      peek.cf_subscription, lastKnown);
    assertEq("6b) paid still true after network error",
      peek.paid, true);
  }
  {
    // Even with a NON-paid last state, the sync must not flip anything.
    const lastKnown = { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 };
    const s = makeStorage({
      cf_subscription: Object.assign({}, lastKnown),
      paid: false,
    });
    const sync = makeSync(s, async () => { throw new Error("offline"); }, () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("6c) free user stays free after offline sync",
      peek.cf_subscription, lastKnown);
    assertEq("6d) paid still false", peek.paid, false);
  }

  // ===== 7. cf_devmode_force_sub_status override =========================
  //
  // The dev escape hatch: lets QA simulate canceled/past_due states without
  // touching a real card. Applied AFTER the real sync — so production
  // logic always runs first.

  {
    const s = makeStorage({
      cf_devmode_force_sub_status: "past_due",
    });
    const sync = makeSync(s, async () => ({
      paid: true,
      subscriptionStatus: "active",
      planNickname: "monthly",
    }), () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("7a) override flips active -> past_due",
      peek.cf_subscription.status, "past_due");
    assertEq("7b) plan field preserved through override",
      peek.cf_subscription.plan, "monthly");
    assertEq("7c) recomputePaid still =true (past_due is grace state)",
      peek.paid, true);
  }
  {
    // Override -> canceled. Confirms drop-to-free path works under dev mode.
    const s = makeStorage({
      cf_grandfathered: false,
      cleanfeed_license: null,
      cf_devmode_force_sub_status: "canceled",
    });
    const sync = makeSync(s, async () => ({
      paid: true,
      subscriptionStatus: "active",
      planNickname: "monthly",
    }), () => NOW);
    await sync();
    assertEq("7d) forced canceled drops to free",
      s._peek().paid, false);
  }
  {
    // Empty override is a no-op (defensive).
    const s = makeStorage({ cf_devmode_force_sub_status: "" });
    const sync = makeSync(s, async () => ({
      paid: true, subscriptionStatus: "active", planNickname: "monthly",
    }), () => NOW);
    await sync();
    assertEq("7e) empty override -> ignored",
      s._peek().cf_subscription.status, "active");
  }

  // ===== 8. pre-fetched user param (avoid double network round-trip) =====
  //
  // The cf:get-user message handler and extpay.onPaid both already have
  // the parsed user in hand. Passing it via the arg must skip getUser().

  {
    const s = makeStorage({});
    let getUserCalled = 0;
    const sync = makeSync(s, async () => { getUserCalled++; return { paid: true, subscriptionStatus: "active", planNickname: "monthly" }; }, () => NOW);
    await sync({ paid: true, subscriptionStatus: "active", planNickname: "annual" });
    assertEq("8a) prefetched user -> getUser NOT called",
      getUserCalled, 0);
    assertEq("8b) prefetched user's plan was used",
      s._peek().cf_subscription.plan, "annual");
  }
  {
    // No prefetch arg -> getUser fired exactly once.
    const s = makeStorage({});
    let getUserCalled = 0;
    const sync = makeSync(s, async () => { getUserCalled++; return { paid: true, subscriptionStatus: "active", planNickname: "monthly" }; }, () => NOW);
    await sync();
    assertEq("8c) no prefetch -> getUser called exactly once",
      getUserCalled, 1);
  }

  // ===== 9. plan field falls back from planNickname to plan ==============
  //
  // ExtPay servers occasionally send `plan` instead of `planNickname`
  // depending on the API version. Sync prefers planNickname but accepts
  // either.

  {
    const s = makeStorage({});
    const sync = makeSync(s, async () => ({
      paid: true,
      subscriptionStatus: "active",
      plan: "monthly",         // legacy field name
      // planNickname absent
    }), () => NOW);
    await sync();
    assertEq("9a) plan fallback when planNickname absent",
      s._peek().cf_subscription.plan, "monthly");
  }
  {
    // Both present -> planNickname wins.
    const s = makeStorage({});
    const sync = makeSync(s, async () => ({
      paid: true,
      subscriptionStatus: "active",
      planNickname: "annual",
      plan: "monthly",
    }), () => NOW);
    await sync();
    assertEq("9b) planNickname wins over plan",
      s._peek().cf_subscription.plan, "annual");
  }

  // ===== 10. fully-fresh free user (no signals) =========================

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
      extpayPaid: false,
      cleanfeed_license: null,
    });
    const sync = makeSync(s, async () => ({
      paid: false,
      // subscriptionStatus absent
    }), () => NOW);
    await sync();
    const peek = s._peek();
    assertEq("10a) free user stays status=none",
      peek.cf_subscription.status, "none");
    assertEq("10b) free user stays plan=null",
      peek.cf_subscription.plan, null);
    assertEq("10c) free user paid=false",
      peek.paid, false);
  }

  // ===== 11. End-to-end: subscriber lapses, drops to free ===============
  //
  // 1. New subscriber -> active.
  // 2. User clicks Cancel -> cancellation_pending (still in paid period).
  // 3. Period ends, ExtPay reports canceled -> drops to free.

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cleanfeed_license: null,
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
    });
    // step 1
    let userPayload = { paid: true, subscriptionStatus: "active", planNickname: "monthly" };
    const sync = makeSync(s, async () => userPayload, () => NOW);
    await sync();
    assertEq("11.1) active", s._peek().cf_subscription.status, "active");
    assertEq("11.1) paid=true", s._peek().paid, true);
    // step 2 — user clicks Cancel in Stripe portal
    userPayload = { paid: true, subscriptionStatus: "active",
      planNickname: "monthly", subscriptionCancelAt: NOW + 5 * 24 * 3600 * 1000 };
    await sync();
    assertEq("11.2) cancellation_pending", s._peek().cf_subscription.status, "cancellation_pending");
    assertEq("11.2) still paid (inside paid period)", s._peek().paid, true);
    // step 3 — period ends
    userPayload = { paid: false, subscriptionStatus: "canceled", planNickname: "monthly" };
    await sync();
    assertEq("11.3) canceled", s._peek().cf_subscription.status, "canceled");
    assertEq("11.3) dropped to free",  s._peek().paid, false);
    assertEq("11.3) NOT silently grandfathered (subscribers never are)",
      s._peek().cf_grandfathered, false);
  }

  process.stdout.write("\n");
  console.log(`SUBSCRIPTION SYNC: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
