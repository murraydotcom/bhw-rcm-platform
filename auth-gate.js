// auth-gate.js — client-side page gate for the internal BHW staff tools.
//
// Include as the FIRST script in <head> of a protected page:
//   <script src="/auth-gate.js"></script>
//
// It hides the page until /auth-me confirms a session, then either reveals the
// page or bounces to /login.html. This is a UX gate only — the real security
// boundary is requireAuth() inside the Netlify functions, which refuses to
// return PHI/billing data without a valid session cookie. So on any infra
// error (functions unreachable) we fail OPEN here and let the page render; the
// data calls behind it stay protected server-side.

(function () {
  var root = document.documentElement;
  // Hide synchronously to avoid flashing protected content before the check.
  root.style.visibility = "hidden";

  function reveal() { root.style.visibility = ""; }

  function redirectToLogin() {
    var next = location.pathname + location.search;
    location.replace("/login.html?next=" + encodeURIComponent(next));
  }

  var settled = false;
  function settle(fn) { if (!settled) { settled = true; fn(); } }

  // Safety net: never trap the user behind a hung request.
  var timer = setTimeout(function () { settle(reveal); }, 4000);

  fetch("/.netlify/functions/auth-me", { credentials: "same-origin" })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        return { status: r.status, data: d };
      });
    })
    .then(function (res) {
      clearTimeout(timer);
      if (res.status === 401) { settle(redirectToLogin); return; }
      settle(reveal);
      if (res.data && res.data.ok && res.data.user) addSignOut(res.data.user);
    })
    .catch(function () {
      clearTimeout(timer);
      settle(reveal); // infra error → render; server-side gate still protects data
    });

  // ---- sign-out affordance --------------------------------------------------
  function addSignOut(user) {
    function inject() {
      if (document.getElementById("bhw-signout")) return;
      var btn = document.createElement("button");
      btn.id = "bhw-signout";
      btn.type = "button";
      btn.title = "Signed in as " + (user.name || user.email);
      btn.textContent = "Sign out";
      btn.onclick = function () {
        fetch("/.netlify/functions/auth-logout", { method: "POST", credentials: "same-origin" })
          .finally(function () { location.replace("/login.html"); });
      };
      var tools = document.querySelector(".topbar .tools");
      if (tools) {
        // Match the app's ghost-button look inside the existing top bar.
        btn.style.cssText = "font:inherit;font-size:11.5px;font-weight:600;padding:6px 11px;" +
          "border:1px solid var(--line,#e7e1d9);border-radius:9px;background:transparent;" +
          "color:var(--ink,#2f3a3f);cursor:pointer";
        tools.appendChild(btn);
      } else {
        btn.style.cssText = "position:fixed;bottom:14px;left:14px;z-index:9999;font:inherit;" +
          "font-size:11.5px;font-weight:600;padding:7px 12px;border:none;border-radius:9px;" +
          "background:#243239;color:#fff;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.25);opacity:.9";
        document.body.appendChild(btn);
      }
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", inject);
    else inject();
  }
})();
