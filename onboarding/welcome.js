/* CleanFeed — onboarding/welcome.js
 *
 * Wires the two CTA buttons + the Options link. Nothing else.
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
});
