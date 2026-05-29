/* CleanFeed v1.4.21-phase1 — grandfather lock-in + subscription-aware
 * recomputePaid tests.
 *
 * Phase 1 introduces two new storage layers in front of the existing
 * extpayPaid + cleanfeed_license merge:
 *
 *   cf_grandfathered       — permanent lifetime-Pro lock. Once true, NEVER
 *                            overwritten. Granted exactly once for users
 *                            holding either an active license key OR the
 *                            legacy one-time-paid ExtPay flag at the
 *                            moment ensureGrandfather() first observes them.
 *   cf_subscription.status — "active" | "cancellation_pending" | "past_due"
 *                            | "canceled" | "none". past_due is treated as
 *                            paid (ExtPay's automatic-retry grace window).
 *
 * recomputePaid() becomes: gf || subActive || extpayPaid || license.active,
 * where subActive = status ∈ {active, cancellation_pending, past_due}.
 *
 * This file is a pure-logic mirror — production helpers live in
 * background.js. The mirror MUST stay byte-identical in semantics to:
 *   background.js  ensureGrandfather  (lines after "v1.4.21-phase1 — grandfather lock-in")
 *   background.js  recomputePaid      (lines after the new ensureGrandfather)
 *
 * Run with:  node tests/grandfather-migration.js
 * Exits non-zero on first failed assertion.
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

// ---- minimal chrome.storage.local simulator (matches first-install-race.js) ----
function makeStorage(seed) {
  const data = Object.assign({}, seed || {});
  let writeCount = 0;
  return {
    async get(keys) {
      const out = {};
      const list = Array.isArray(keys) ? keys : (keys ? [keys] : Object.keys(data));
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(patch) {
      writeCount++;
      for (const k of Object.keys(patch)) data[k] = patch[k];
    },
    _peek() { return Object.assign({}, data); },
    _writes() { return writeCount; },
  };
}

// ---- production helpers, transcribed from background.js -----------------

async function ensureGrandfather(storage) {
  // v1.4.22 — adds legacy_subscriber qualifier (cf_subscription.status
  // in {active, cancellation_pending}). Precedence:
  //   legacy_extpay > legacy_subscriber > license_key
  const d1 = await storage.get(
    ["cf_grandfathered", "extpayPaid", "cleanfeed_license", "cf_subscription"]
  );
  if (d1.cf_grandfathered === true) return;
  const hasLicense = !!(d1.cleanfeed_license && d1.cleanfeed_license.active);
  const hasLegacyExtpay = d1.extpayPaid === true;
  const subStatus = d1.cf_subscription && d1.cf_subscription.status;
  const hasLegacySubscriber = (subStatus === "active" || subStatus === "cancellation_pending");
  if (!hasLicense && !hasLegacyExtpay && !hasLegacySubscriber) return;
  const d2 = await storage.get(["cf_grandfathered"]);
  if (d2.cf_grandfathered === true) return;
  let reason;
  if (hasLegacyExtpay) reason = "legacy_extpay";
  else if (hasLegacySubscriber) reason = "legacy_subscriber";
  else reason = "license_key";
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

// ===== 1. ensureGrandfather — empty storage =============================

(async () => {
  {
    const s = makeStorage({});
    await ensureGrandfather(s);
    assertEq("1a) empty storage: cf_grandfathered stays undefined",
      s._peek().cf_grandfathered, undefined);
    assertEq("1a) empty storage: no write performed", s._writes(), 0);
  }
  {
    // false-default already seeded by migrator — same behavior: no-op.
    const s = makeStorage({ cf_grandfathered: false });
    await ensureGrandfather(s);
    assertEq("1b) cf_grandfathered=false stays false (no qualifier)",
      s._peek().cf_grandfathered, false);
    assertEq("1b) no write performed", s._writes(), 0);
  }

  // ===== 2. ensureGrandfather — license-key qualifier ===================

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cleanfeed_license: { active: true, key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2" },
    });
    await ensureGrandfather(s);
    const peek = s._peek();
    assertEq("2a) license active -> grandfathered",
      peek.cf_grandfathered, true);
    assertEq("2a) reason recorded as license_key",
      peek.cf_grandfathered_reason, "license_key");
    assertTrue("2a) cf_grandfathered_at is an ISO string",
      typeof peek.cf_grandfathered_at === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(peek.cf_grandfathered_at));
  }
  {
    // license object present but active=false should NOT trigger.
    const s = makeStorage({
      cleanfeed_license: { active: false, key: "X", deactivated_reason: "revoked" },
    });
    await ensureGrandfather(s);
    assertEq("2b) license inactive -> no grandfather",
      s._peek().cf_grandfathered, undefined);
  }

  // ===== 3. ensureGrandfather — legacy extpayPaid qualifier =============

  {
    const s = makeStorage({ extpayPaid: true });
    await ensureGrandfather(s);
    const peek = s._peek();
    assertEq("3a) extpayPaid=true -> grandfathered",
      peek.cf_grandfathered, true);
    assertEq("3a) reason recorded as legacy_extpay",
      peek.cf_grandfathered_reason, "legacy_extpay");
  }
  {
    // extpayPaid=false must NOT trigger — only the explicit true value qualifies.
    const s = makeStorage({ extpayPaid: false });
    await ensureGrandfather(s);
    assertEq("3b) extpayPaid=false -> no grandfather",
      s._peek().cf_grandfathered, undefined);
  }

  // ===== 4. ensureGrandfather — both qualifiers, extpay wins ============

  {
    const s = makeStorage({
      extpayPaid: true,
      cleanfeed_license: { active: true, key: "Z2JQ-EFGH-JKMN-PQRS-TUVW-Y9N2" },
    });
    await ensureGrandfather(s);
    const peek = s._peek();
    assertEq("4) both qualifiers -> grandfathered",
      peek.cf_grandfathered, true);
    assertEq("4) legacy_extpay wins precedence over license_key",
      peek.cf_grandfathered_reason, "legacy_extpay");
  }

  // ===== 5. Idempotency: ensureGrandfather called 3x ====================

  {
    const s = makeStorage({ extpayPaid: true });
    await ensureGrandfather(s);
    const firstAt = s._peek().cf_grandfathered_at;
    const writesAfterFirst = s._writes();
    // sleep a tick so any subsequent Date.toISOString() would differ
    await new Promise((r) => setTimeout(r, 5));
    await ensureGrandfather(s);
    await ensureGrandfather(s);
    const peek = s._peek();
    assertEq("5a) cf_grandfathered_at unchanged after 3 calls",
      peek.cf_grandfathered_at, firstAt);
    assertEq("5b) reason unchanged after 3 calls",
      peek.cf_grandfathered_reason, "legacy_extpay");
    assertEq("5c) only one write performed across 3 calls",
      s._writes(), writesAfterFirst);
  }

  // ===== 6. Race-safety: two concurrent calls ===========================
  //
  // The double-read pattern is race-tolerant, not race-EXCLUSIVE — if both
  // callers pass the second cf_grandfathered check before either commits,
  // both will set(). chrome.storage.local's last-write-wins makes this safe
  // because both writes carry the SAME logical value: cf_grandfathered=true
  // with the same `reason` (both callers read identical d1). The only field
  // that can jitter is cf_grandfathered_at by a few microseconds. We assert
  // the final state is consistent, mirroring cf-stats-migration-real-chrome's
  // invariant 4 convergence check.
  {
    const s = makeStorage({ extpayPaid: true });
    const [r1, r2] = await Promise.all([ensureGrandfather(s), ensureGrandfather(s)]);
    const peek = s._peek();
    assertEq("6a) concurrent calls -> grandfathered true",
      peek.cf_grandfathered, true);
    assertEq("6b) concurrent calls -> reason legacy_extpay (both saw same d1)",
      peek.cf_grandfathered_reason, "legacy_extpay");
    assertTrue("6c) both callers returned without throwing",
      r1 === undefined && r2 === undefined);
    assertTrue("6d) at most one write per caller, no runaway loop",
      s._writes() <= 2);
  }

  // ===== 7. recomputePaid — grandfather alone ===========================
  //
  // Grandfather is the LIFETIME layer. Once true, paid=true regardless of
  // every other input. Critical invariant: a legacy buyer whose ExtPay
  // record was lost or whose license was somehow cleared MUST still see Pro.

  {
    const s = makeStorage({
      cf_grandfathered: true,
      // explicitly all other inputs FALSE / absent
      extpayPaid: false,
      cleanfeed_license: null,
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
    });
    const next = await recomputePaid(s);
    assertEq("7) grandfathered alone -> paid", next, true);
    assertEq("7) paid storage key set to true", s._peek().paid, true);
  }

  // ===== 8. recomputePaid — subscription active alone ===================

  {
    const s = makeStorage({
      cf_grandfathered: false,
      extpayPaid: false,
      cleanfeed_license: null,
      cf_subscription: { status: "active", plan: "monthly", cancelAt: null, lastSyncAt: 1700000000000 },
    });
    const next = await recomputePaid(s);
    assertEq("8) subscription active alone -> paid", next, true);
  }

  // ===== 9. recomputePaid — cancellation_pending (still paid) ===========
  //
  // Per ExtPay state machine: user.paid is still true with subscriptionCancelAt
  // set. They're inside the period they paid for; access continues until the
  // period ends.

  {
    const s = makeStorage({
      cf_subscription: { status: "cancellation_pending", plan: "annual", cancelAt: 1740000000000, lastSyncAt: 0 },
    });
    const next = await recomputePaid(s);
    assertEq("9) cancellation_pending -> paid (grace period)", next, true);
  }

  // ===== 10. recomputePaid — past_due (grace) ===========================
  //
  // ExtPay's 7-day automatic-retry window. Treating past_due as paid avoids
  // booting a card-expiry user out of Pro mid-session while Stripe retries.

  {
    const s = makeStorage({
      cf_subscription: { status: "past_due", plan: "monthly", cancelAt: null, lastSyncAt: 0 },
    });
    const next = await recomputePaid(s);
    assertEq("10) past_due -> paid (Stripe retry grace)", next, true);
  }

  // ===== 11. recomputePaid — canceled + grandfathered (lifetime wins) ===

  {
    const s = makeStorage({
      cf_grandfathered: true,
      cf_grandfathered_reason: "license_key",
      cf_subscription: { status: "canceled", plan: "monthly", cancelAt: 1700000000000, lastSyncAt: 0 },
      extpayPaid: false,
      cleanfeed_license: null,        // license could have been revoked yet grandfather sticks
    });
    const next = await recomputePaid(s);
    assertEq("11) canceled + grandfathered -> paid (grandfather wins)", next, true);
  }

  // ===== 12. recomputePaid — canceled + NOT grandfathered (correct drop) ===
  //
  // The whole point of the new pricing model: a non-grandfathered subscriber
  // whose subscription ends MUST drop to free. No silent lifetime grant.

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "canceled", plan: "monthly", cancelAt: 1700000000000, lastSyncAt: 0 },
      extpayPaid: false,
      cleanfeed_license: null,
    });
    const next = await recomputePaid(s);
    assertEq("12) canceled + NOT grandfathered -> FREE", next, false);
    assertEq("12) paid storage key = false", s._peek().paid, false);
  }

  // ===== 13. recomputePaid — canceled + license active ==================
  //
  // License keys are permanent regardless of subscription state. A user
  // who once subscribed then canceled, then later redeemed a license, must
  // still be Pro. (And ensureGrandfather will lock them in next pass.)

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "canceled", plan: "monthly", cancelAt: 1700000000000, lastSyncAt: 0 },
      extpayPaid: false,
      cleanfeed_license: { active: true, key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2" },
    });
    const next = await recomputePaid(s);
    assertEq("13) canceled + license active -> paid (license is permanent)",
      next, true);
  }

  // ===== 14. recomputePaid — none/no signals -> free =====================

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
      extpayPaid: false,
      cleanfeed_license: null,
    });
    const next = await recomputePaid(s);
    assertEq("14) all signals off -> FREE", next, false);
  }

  // ===== 15. recomputePaid — v1.4.16 legacy migration preserved =========
  //
  // The pre-v1.4.17 user has `paid: true` but no extpayPaid key yet. The
  // existing migration must still copy paid -> extpayPaid on first call,
  // and the new layers must not break that.

  {
    const s = makeStorage({
      paid: true,
      // no extpayPaid, no cleanfeed_license, no cf_grandfathered, no cf_subscription
    });
    const next = await recomputePaid(s);
    const peek = s._peek();
    assertEq("15a) legacy v1.4.16 user stays paid", next, true);
    assertEq("15b) extpayPaid back-filled from legacy paid",
      peek.extpayPaid, true);
  }

  // ===== 16. recomputePaid — cf_subscription missing entirely ===========
  //
  // Phase 1 install seed writes the cf_subscription default, but a user
  // upgrading from a v1.4.20-beta corrupt profile may have lost it.
  // recomputePaid must NOT crash when cf_subscription is undefined.

  {
    const s = makeStorage({
      cf_grandfathered: true,        // grandfathered should keep them paid
    });
    const next = await recomputePaid(s);
    assertEq("16) missing cf_subscription doesn't crash, grandfather wins",
      next, true);
  }

  // ===== 17. Compose: redemption flow end-to-end ========================
  //
  // 1. User starts as free, no license, no extpay.
  // 2. Redeems a license key — options.js writes cleanfeed_license.active=true.
  // 3. background storage.onChanged fires ensureGrandfather -> recomputePaid.
  // 4. cf_grandfathered=true, paid=true.
  // 5. Some time later license is revoked by the worker (active flips to false).
  // 6. cf_grandfathered is STILL true (never overwritten); paid stays true.
  //    (This is the "kindness" promised in the spec — once a redeemer,
  //    always a lifetime user, even if the license is later revoked.)

  {
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "none", plan: null, cancelAt: null, lastSyncAt: 0 },
      extpayPaid: false,
      cleanfeed_license: null,
    });
    // step 1
    assertEq("17.1) starts free", await recomputePaid(s), false);
    // step 2 + 3 — license appears, then grandfather + recompute fire
    await s.set({ cleanfeed_license: { active: true, key: "A2BC-DEFG-HJKM-NPQR-STUV-WXYZ" } });
    await ensureGrandfather(s);
    assertEq("17.2) grandfather locked in on redemption",
      s._peek().cf_grandfathered, true);
    assertEq("17.3) paid after redemption", await recomputePaid(s), true);
    // step 5 — worker revokes
    await s.set({ cleanfeed_license: Object.assign({}, s._peek().cleanfeed_license, {
      active: false, deactivated_reason: "revoked", deactivated_at: Date.now(),
    }) });
    await ensureGrandfather(s);    // idempotent no-op — already true
    assertEq("17.4) grandfather still true after revocation",
      s._peek().cf_grandfathered, true);
    assertEq("17.5) paid stays true after revocation (grandfather kindness)",
      await recomputePaid(s), true);
  }

  // ===== 18. Compose: subscriber lapses, drops to free ==================
  //
  // 1. New user (post-v1.4.21) subscribes monthly. cf_subscription.status=active.
  // 2. paid=true.
  // 3. Subscription expires/canceled at end of period. cf_subscription.status=canceled.
  // 4. cf_grandfathered was never set true. Drops correctly to free.

  {
    const s = makeStorage({
      cf_grandfathered: false,
      extpayPaid: false,
      cleanfeed_license: null,
      cf_subscription: { status: "active", plan: "monthly", cancelAt: null, lastSyncAt: 0 },
    });
    assertEq("18.1) active subscriber -> paid", await recomputePaid(s), true);
    // worker-driven sync (Phase 2) flips status -> canceled
    await s.set({ cf_subscription: { status: "canceled", plan: "monthly",
      cancelAt: 1700000000000, lastSyncAt: 1700000000000 } });
    await ensureGrandfather(s);    // does NOT grandfather a sub-only user
    assertEq("18.2) ensureGrandfather did NOT lock in subscriber",
      s._peek().cf_grandfathered, false);
    assertEq("18.3) canceled subscriber drops to free",
      await recomputePaid(s), false);
  }

  // ===== 19. v1.4.22 legacy_subscriber auto-grandfather ==================
  //
  // The pricing-revert kindness invariant. Anyone who managed to subscribe
  // to the v1.4.21 monthly/annual plans between ship and revert gets
  // automatically grandfathered on first v1.4.22 SW boot. They paid real
  // money; we changed the model under them. They get lifetime free.

  {
    // Active subscriber, no other qualifier -> grandfathered with
    // reason="legacy_subscriber".
    const s = makeStorage({
      cf_grandfathered: false,
      extpayPaid: false,
      cleanfeed_license: null,
      cf_subscription: { status: "active", plan: "monthly", cancelAt: null, lastSyncAt: 0 },
    });
    await ensureGrandfather(s);
    const peek = s._peek();
    assertEq("19a) active subscriber -> grandfathered",
      peek.cf_grandfathered, true);
    assertEq("19a) reason = legacy_subscriber",
      peek.cf_grandfathered_reason, "legacy_subscriber");
  }
  {
    // cancellation_pending subscriber also auto-grandfathers — they paid
    // for the current period and would lose Pro at period-end without
    // the grant.
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "cancellation_pending", plan: "annual",
        cancelAt: 1740000000000, lastSyncAt: 0 },
    });
    await ensureGrandfather(s);
    assertEq("19b) cancellation_pending -> grandfathered",
      s._peek().cf_grandfathered, true);
    assertEq("19b) reason = legacy_subscriber",
      s._peek().cf_grandfathered_reason, "legacy_subscriber");
  }
  {
    // past_due subscriber does NOT auto-grandfather (their card failed —
    // they haven't recently paid). They can still redeem a license key
    // or fix their card to get back to active.
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "past_due", plan: "monthly", lastSyncAt: 0 },
    });
    await ensureGrandfather(s);
    assertEq("19c) past_due alone does NOT grandfather",
      s._peek().cf_grandfathered, false);
  }
  {
    // canceled subscriber (whose period ended) does NOT auto-grandfather.
    // They had Pro, they lost Pro when their billing ended (pre-v1.4.22
    // behaviour). Re-granting them lifetime would be over-correction.
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "canceled", plan: "monthly",
        cancelAt: 1700000000000, lastSyncAt: 0 },
    });
    await ensureGrandfather(s);
    assertEq("19d) canceled subscriber does NOT grandfather",
      s._peek().cf_grandfathered, false);
  }
  {
    // Idempotent: clicking "Switch to lifetime ($0)" twice doesn't churn.
    const s = makeStorage({
      cf_grandfathered: false,
      cf_subscription: { status: "active", plan: "monthly", lastSyncAt: 0 },
    });
    await ensureGrandfather(s);
    const firstAt = s._peek().cf_grandfathered_at;
    await new Promise((r) => setTimeout(r, 5));
    await ensureGrandfather(s);
    assertEq("19e) repeat click does NOT churn cf_grandfathered_at",
      s._peek().cf_grandfathered_at, firstAt);
  }

  // ===== 20. Precedence matrix ==========================================
  //
  // legacy_extpay > legacy_subscriber > license_key. Reasoning: legacy_extpay
  // users predate every other path. legacy_subscriber is the user we owe
  // restitution to; that's the most specific historical signal. license_key
  // holders also get lifetime but they got it by redemption, not by paying
  // recurring fees we deprecated.

  {
    // All three qualifiers present -> legacy_extpay wins.
    const s = makeStorage({
      extpayPaid: true,
      cleanfeed_license: { active: true, key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2" },
      cf_subscription: { status: "active", plan: "monthly", lastSyncAt: 0 },
    });
    await ensureGrandfather(s);
    assertEq("20a) extpay + subscriber + license -> reason=legacy_extpay",
      s._peek().cf_grandfathered_reason, "legacy_extpay");
  }
  {
    // legacy_subscriber + license_key (no extpay) -> legacy_subscriber wins.
    // The user paid real money via the subscription before we reverted; they
    // get the more-specific historical reason recorded.
    const s = makeStorage({
      extpayPaid: false,
      cleanfeed_license: { active: true, key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2" },
      cf_subscription: { status: "active", plan: "annual", lastSyncAt: 0 },
    });
    await ensureGrandfather(s);
    assertEq("20b) subscriber + license -> reason=legacy_subscriber",
      s._peek().cf_grandfathered_reason, "legacy_subscriber");
  }
  {
    // license alone -> reason=license_key (unchanged from v1.4.21).
    const s = makeStorage({
      cleanfeed_license: { active: true, key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2" },
    });
    await ensureGrandfather(s);
    assertEq("20c) license-only -> reason=license_key (unchanged)",
      s._peek().cf_grandfathered_reason, "license_key");
  }
  {
    // legacy_extpay + license (no subscriber) -> legacy_extpay still wins.
    const s = makeStorage({
      extpayPaid: true,
      cleanfeed_license: { active: true, key: "ABCD-EFGH-JKMN-PQRS-TUVW-XYZ2" },
    });
    await ensureGrandfather(s);
    assertEq("20d) extpay + license -> reason=legacy_extpay (unchanged from v1.4.21)",
      s._peek().cf_grandfathered_reason, "legacy_extpay");
  }

  process.stdout.write("\n");
  console.log(`GRANDFATHER MIGRATION: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
})();
