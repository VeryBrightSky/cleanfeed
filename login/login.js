/* CleanFeed — login/login.js
 *
 * Branded sign-in page. Visually owns the magic-link flow:
 *   1. Validate the email client-side (inline error if bad)
 *   2. Show a loading state on the submit button
 *   3. Ask the background service worker to open ExtPay's actual magic-link
 *      page (where ExtPay sends the email). We don't proxy the email send
 *      ourselves — that keeps the auth surface entirely in ExtPay's hands.
 *   4. Show the success state with the email back to the user
 *   5. When the user returns to the popup, paid status is force-refreshed
 *      so Pro features unlock immediately
 *
 * We never store the typed email anywhere — it's a UI hint only.
 */
"use strict";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const FAKE_DELAY_MS = 900; // visible spinner so the user perceives action

const els = {
  form:    document.getElementById("cf-login-form"),
  email:   document.getElementById("cf-email"),
  submit:  document.getElementById("cf-submit"),
  error:   document.getElementById("cf-error"),
  success: document.getElementById("cf-success"),
  failure: document.getElementById("cf-failure"),
  sentEmail: document.getElementById("cf-sent-email"),
  resend:  document.getElementById("cf-resend"),
  retry:   document.getElementById("cf-retry"),
  upgrade: document.getElementById("cf-upgrade"),
  back:    document.getElementById("cf-back"),
};

function setError(msg) {
  els.error.textContent = msg || "";
  if (msg) {
    els.email.setAttribute("aria-invalid", "true");
  } else {
    els.email.removeAttribute("aria-invalid");
  }
}

function setLoading(loading) {
  if (loading) {
    els.submit.classList.add("is-loading");
    els.submit.disabled = true;
  } else {
    els.submit.classList.remove("is-loading");
    els.submit.disabled = false;
  }
}

function showState(name) {
  els.form.hidden = name !== "form";
  els.success.hidden = name !== "success";
  els.failure.hidden = name !== "failure";
}

function validateEmail(value) {
  const v = (value || "").trim();
  if (!v) return "Please enter your email address.";
  if (v.length > 320) return "That email is too long.";
  if (!EMAIL_RE.test(v)) return "That doesn't look like a valid email.";
  return null;
}

async function onSubmit(e) {
  e.preventDefault();
  setError(null);
  const value = els.email.value.trim();
  const err = validateEmail(value);
  if (err) {
    setError(err);
    els.email.focus();
    return;
  }
  setLoading(true);
  // Open ExtPay's magic-link page in another tab. This is where the user
  // actually submits their email to ExtPay's service.
  try {
    await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "cf:open-extpay-login" }, (resp) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        resolve(resp);
      });
    });
    // Visible spinner so the click feels "real"
    setTimeout(() => {
      setLoading(false);
      els.sentEmail.textContent = value;
      showState("success");
    }, FAKE_DELAY_MS);
  } catch (e) {
    setLoading(false);
    showState("failure");
  }
}

function onResend() {
  showState("form");
  els.email.focus();
  // small UX touch: select the existing value so it's easy to retype
  els.email.select();
}

function onRetry() {
  showState("form");
  setError(null);
  els.email.focus();
}

function onUpgrade() {
  chrome.runtime.sendMessage({ type: "cf:open-payment" }).catch(() => {});
}

function onBack(e) {
  e.preventDefault();
  // No "previous extension tab" concept — closing this tab is the right action.
  window.close();
}

document.addEventListener("DOMContentLoaded", () => {
  els.form.addEventListener("submit", onSubmit);
  els.resend.addEventListener("click", onResend);
  els.retry.addEventListener("click", onRetry);
  els.upgrade.addEventListener("click", onUpgrade);
  els.back.addEventListener("click", onBack);
  // Clear inline error as user types
  els.email.addEventListener("input", () => setError(null));
  // Focus the email field on load
  els.email.focus();

  // While this page is open, periodically force-refresh paid status —
  // catches the moment the user comes back from clicking the magic link.
  setInterval(() => {
    chrome.runtime.sendMessage({ type: "cf:force-refresh-paid" }, (resp) => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.paid) {
        // Successful login — replace the whole card with a "you're in" state
        showState("success");
        els.success.querySelector("h2").textContent = "You're signed in!";
        els.success.querySelector("p").innerHTML = "";
        els.success.querySelector("p").textContent = "CleanFeed Pro is now unlocked. You can close this tab.";
        const hint = els.success.querySelector(".cf-success-hint");
        if (hint) hint.textContent = "";
        if (els.resend) els.resend.textContent = "Close tab";
        if (els.resend) els.resend.onclick = () => window.close();
      }
    });
  }, 4000);
});
