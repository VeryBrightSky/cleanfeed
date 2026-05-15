/* CleanFeed — onboarding/welcome.js
 *
 * Wires the two CTA buttons + the Options link + the v1.4.5 optional
 * channel-whitelist step. Whitelist writes use the SAME storage shape as
 * options.js (key: "whitelistedChannels", value: string[]) so anything
 * added during onboarding shows up in the Options page list and is honored
 * by content.js's isWhitelistedChannel() check.
 */
"use strict";

document.addEventListener("DOMContentLoaded", () => {
  const upgrade = document.getElementById("cf-upgrade");
  if (upgrade) {
    upgrade.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "cf:open-payment" }).catch(() => {});
    });
  }
  const free = document.getElementById("cf-start-free");
  if (free) {
    free.addEventListener("click", () => {
      // close this onboarding tab
      window.close();
    });
  }
  const alreadyPaid = document.getElementById("cf-already-paid");
  if (alreadyPaid) {
    alreadyPaid.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "cf:open-login" }).catch(() => {});
    });
  }
  const opts = document.getElementById("cf-open-options");
  if (opts) {
    opts.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }

  // ---- v1.4.5 whitelist step ----
  const wlInput = document.getElementById("cf-onb-whitelist-input");
  const wlAdd   = document.getElementById("cf-onb-whitelist-add");
  const wlList  = document.getElementById("cf-onb-whitelist-list");
  const wlSkip  = document.getElementById("cf-onb-whitelist-skip");
  if (wlInput && wlAdd && wlList && wlSkip) {
    let channels = [];

    function render() {
      while (wlList.firstChild) wlList.removeChild(wlList.firstChild);
      for (const name of channels) {
        const li = document.createElement("li");
        const span = document.createElement("span");
        span.textContent = name;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.setAttribute("aria-label", "Remove " + name);
        btn.textContent = "×";
        btn.addEventListener("click", () => remove(name));
        li.appendChild(span);
        li.appendChild(btn);
        wlList.appendChild(li);
      }
    }

    async function persist() {
      // Same key + shape as options.js:141-143 + options.js:150-152.
      try { await chrome.storage.local.set({ whitelistedChannels: channels }); } catch (_) {}
      // Mirror to sync for parity with options.js + background.js install seed.
      chrome.storage.sync.set({ whitelistedChannels: channels }).catch(() => {});
    }

    async function add() {
      const v = (wlInput.value || "").trim();
      if (!v) return;
      const lower = v.toLowerCase();
      if (channels.some((c) => c.toLowerCase() === lower)) {
        wlInput.value = "";
        return;
      }
      channels.push(v);
      wlInput.value = "";
      render();
      await persist();
    }

    async function remove(name) {
      channels = channels.filter((c) => c !== name);
      render();
      await persist();
    }

    wlAdd.addEventListener("click", () => { add(); });
    wlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); add(); }
    });
    wlSkip.addEventListener("click", () => { window.close(); });

    // Seed from existing storage in case the user re-opens onboarding.
    chrome.storage.local.get(["whitelistedChannels"]).then((data) => {
      if (Array.isArray(data.whitelistedChannels)) {
        channels = data.whitelistedChannels.slice();
        render();
      }
    }).catch(() => {});
  }
});
