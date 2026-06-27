/* CleanFeed — shared feature logic (v1.4.24)
 *
 * Pure, dependency-free helpers for:
 *   • Focus Schedule matching (day-of-week, midnight crossover, next window)
 *   • Usage streak counting
 *   • Today's-stats summary from cf_stats
 *
 * UMD-ish wrapper so the SAME code runs in every context that needs it:
 *   • MV3 service worker  →  importScripts("lib/cf-features.js")  → self.CFFeatures
 *   • popup               →  <script src="../lib/cf-features.js">  → window.CFFeatures
 *   • Node unit tests      →  require("../lib/cf-features.js")
 *
 * No DOM, no chrome.* — everything here is a pure function so the tests
 * exercise the exact logic that ships. All dates use the LOCAL timezone to
 * match how background.js / content.js bucket cf_stats + timeTracking.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CFFeatures = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function pad2(n) { return String(n).padStart(2, "0"); }

  // ---- local-date helpers (match cf_stats "YYYY-MM-DD" bucketing) --------
  function localDateKey(date) {
    var d = date || new Date();
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
  }
  function prevDateKey(key) {
    var p = String(key).split("-");
    var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
    d.setDate(d.getDate() - 1);
    return localDateKey(d);
  }

  // ---- Focus Schedule matching ------------------------------------------
  // "HH:MM" -> minutes since midnight, or null when malformed.
  function parseHM(s) {
    if (typeof s !== "string") return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    var h = Number(m[1]), mm = Number(m[2]);
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
    return h * 60 + mm;
  }
  function prevDow(d) { return (d + 6) % 7; }   // 0=Sun..6=Sat, wraps

  // True iff `schedule` is active at day-of-week `dow` and `minutes` of day.
  // Handles midnight crossover: a 22:00→06:00 window scheduled on Monday is
  // active Monday 22:00–24:00 AND Tuesday 00:00–06:00 (the morning slice
  // belongs to Monday's window, so it checks the PREVIOUS day's membership).
  function scheduleActiveAt(schedule, dow, minutes) {
    if (!schedule || schedule.enabled === false) return false;
    var s = parseHM(schedule.startTime);
    var e = parseHM(schedule.endTime);
    if (s === null || e === null || s === e) return false; // degenerate → never
    var days = Array.isArray(schedule.days) ? schedule.days : [];
    if (s < e) {
      // same-day window
      return days.indexOf(dow) !== -1 && minutes >= s && minutes < e;
    }
    // crosses midnight
    if (days.indexOf(dow) !== -1 && minutes >= s) return true;        // evening slice
    if (days.indexOf(prevDow(dow)) !== -1 && minutes < e) return true; // morning slice
    return false;
  }

  // ms timestamp when the active window for `schedule` ends, or null if the
  // schedule is not active at `date`.
  function windowEndAt(schedule, date) {
    var d = date || new Date();
    var dow = d.getDay();
    var minutes = d.getHours() * 60 + d.getMinutes();
    if (!scheduleActiveAt(schedule, dow, minutes)) return null;
    var s = parseHM(schedule.startTime), e = parseHM(schedule.endTime);
    var end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
    if (s < e) {
      end.setMinutes(e);                    // today @ endTime
    } else if (minutes >= s) {
      end.setDate(end.getDate() + 1);       // evening slice → tomorrow @ endTime
      end.setMinutes(e);
    } else {
      end.setMinutes(e);                    // morning slice → today @ endTime
    }
    return end.getTime();
  }

  // First enabled schedule active right now → { schedule, endsAt } | null.
  function findActiveSchedule(focusSchedule, date) {
    if (!focusSchedule || !Array.isArray(focusSchedule.schedules)) return null;
    var d = date || new Date();
    var dow = d.getDay();
    var minutes = d.getHours() * 60 + d.getMinutes();
    for (var i = 0; i < focusSchedule.schedules.length; i++) {
      var sc = focusSchedule.schedules[i];
      if (sc && sc.enabled !== false && scheduleActiveAt(sc, dow, minutes)) {
        return { schedule: sc, endsAt: windowEndAt(sc, d) };
      }
    }
    return null;
  }

  // Earliest upcoming window start across all enabled schedules within
  // `lookaheadDays` (default 8) → { schedule, startsAt } | null.
  function findNextWindow(focusSchedule, date, lookaheadDays) {
    if (!focusSchedule || !Array.isArray(focusSchedule.schedules)) return null;
    var base = date || new Date();
    var days = lookaheadDays || 8;
    var best = null;
    for (var i = 0; i < focusSchedule.schedules.length; i++) {
      var sc = focusSchedule.schedules[i];
      if (!sc || sc.enabled === false) continue;
      var s = parseHM(sc.startTime), e = parseHM(sc.endTime);
      if (s === null || e === null || s === e) continue;
      var scDays = Array.isArray(sc.days) ? sc.days : [];
      for (var off = 0; off < days; off++) {
        var d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + off, 0, 0, 0, 0);
        if (scDays.indexOf(d.getDay()) === -1) continue;
        var start = new Date(d); start.setMinutes(s);
        if (start.getTime() > base.getTime()) {
          if (!best || start.getTime() < best.startsAt) best = { schedule: sc, startsAt: start.getTime() };
          break; // earliest start for THIS schedule found
        }
      }
    }
    return best;
  }

  // ---- usage streak ------------------------------------------------------
  // prev = { streakCount, lastActiveDate }; todayKey = "YYYY-MM-DD".
  // Returns a NEW object (never mutates prev). Pure.
  function updateStreak(prev, todayKey) {
    var p = (prev && typeof prev === "object") ? prev : {};
    var count = Number(p.streakCount) || 0;
    var last = p.lastActiveDate || null;
    if (last === todayKey) {
      return { streakCount: Math.max(1, count), lastActiveDate: todayKey }; // already counted today
    }
    if (last && prevDateKey(todayKey) === last) {
      return { streakCount: count + 1, lastActiveDate: todayKey };          // consecutive day
    }
    return { streakCount: 1, lastActiveDate: todayKey };                     // fresh / gap → reset
  }

  // ---- today's-stats summary --------------------------------------------
  // Short, screenshot-friendly labels for the popup one-liner.
  var SHORT_LABELS = {
    "home-feed": "feed", "shorts": "Shorts", "watch-sidebar": "recs",
    "end-screen": "end-screens", "comments": "comments", "explore": "trending",
    "live-chat": "live chat", "autoplay": "autoplay", "thumbnails": "thumbnails",
    "subs-algo": "subs algo", "playables": "Playables", "merch-shelf": "merch",
    "breaking-news": "news", "mixes-playlists": "mixes",
    "subs-most-relevant": "subs picks", "subs-members-only": "members-only",
    "subs-watched": "watched"
  };

  // blockedForDay = { blockerId: count }. Returns top-N [{id,count,label}]
  // sorted by count desc (ties broken by label) — zero counts excluded.
  function summarizeToday(blockedForDay, topN, labelMap) {
    var map = labelMap || SHORT_LABELS;
    var n = topN || 3;
    var arr = [];
    if (blockedForDay && typeof blockedForDay === "object") {
      for (var id in blockedForDay) {
        if (!Object.prototype.hasOwnProperty.call(blockedForDay, id)) continue;
        var c = Number(blockedForDay[id]) || 0;
        if (c > 0) arr.push({ id: id, count: c, label: map[id] || id });
      }
    }
    arr.sort(function (a, b) { return (b.count - a.count) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0); });
    return arr.slice(0, n);
  }

  // Sum of all block counts for a day (used for the "any activity today?" gate).
  function totalToday(blockedForDay) {
    var t = 0;
    if (blockedForDay && typeof blockedForDay === "object") {
      for (var id in blockedForDay) {
        if (Object.prototype.hasOwnProperty.call(blockedForDay, id)) t += Number(blockedForDay[id]) || 0;
      }
    }
    return t;
  }

  return {
    localDateKey: localDateKey,
    prevDateKey: prevDateKey,
    parseHM: parseHM,
    scheduleActiveAt: scheduleActiveAt,
    windowEndAt: windowEndAt,
    findActiveSchedule: findActiveSchedule,
    findNextWindow: findNextWindow,
    updateStreak: updateStreak,
    summarizeToday: summarizeToday,
    totalToday: totalToday,
    SHORT_LABELS: SHORT_LABELS
  };
});
