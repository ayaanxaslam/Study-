/* ============================================================
   Study Piolet — UI behaviour only (no backend, no AI calls)
   ============================================================ */
(function () {
  "use strict";

  var $  = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* ---------- Theme ---------- */
  var THEME_KEY = "sp-theme";

  function readTheme() {
    try { return localStorage.getItem(THEME_KEY) || "system"; } catch (e) { return "system"; }
  }

  function applyTheme(mode) {
    var dark = mode === "dark" ||
      (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    try { localStorage.setItem(THEME_KEY, mode); } catch (e) { /* storage unavailable */ }
  }

  function initTheme() {
    applyTheme(readTheme());

    $$("[data-theme-toggle]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var isDark = document.documentElement.getAttribute("data-theme") === "dark";
        applyTheme(isDark ? "light" : "dark");
        syncThemePicker();
      });
    });

    $$("[data-theme-set]").forEach(function (input) {
      input.addEventListener("change", function () {
        if (input.checked) applyTheme(input.value);
      });
    });
    syncThemePicker();

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () {
      if (readTheme() === "system") applyTheme("system");
    });
  }

  function syncThemePicker() {
    var mode = readTheme();
    $$("[data-theme-set]").forEach(function (input) { input.checked = input.value === mode; });
  }

  /* ---------- Marketing header (mobile menu) ---------- */
  function initSiteNav() {
    var toggle = $("[data-nav-toggle]");
    var nav = $("[data-site-nav]");
    if (!toggle || !nav) return;

    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
  }

  /* ---------- App sidebar (mobile drawer) ---------- */
  function initSidebar() {
    var sidebar = $("[data-sidebar]");
    var scrim = $("[data-scrim]");
    if (!sidebar) return;

    function close() {
      sidebar.classList.remove("open");
      if (scrim) scrim.classList.remove("show");
    }

    $$("[data-menu-btn]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        sidebar.classList.toggle("open");
        if (scrim) scrim.classList.toggle("show");
      });
    });

    if (scrim) scrim.addEventListener("click", close);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    window.addEventListener("resize", function () { if (window.innerWidth > 1000) close(); });
  }

  /* ---------- Generic tab groups (auth, settings) ----------
     Trigger: <button data-tab="name" data-tab-group="group">
     Panel:   <section data-panel="name" data-panel-group="group"> */
  function initTabs() {
    var groups = {};

    $$("[data-tab-group]").forEach(function (btn) {
      var group = btn.getAttribute("data-tab-group");
      groups[group] = true;
      btn.addEventListener("click", function () {
        selectTab(group, btn.getAttribute("data-tab"));
      });
    });

    Object.keys(groups).forEach(function (group) {
      var hashed = $('[data-panel-group="' + group + '"][data-tab-hash]');
      var wanted = location.hash.replace("#", "");
      if (hashed && wanted && $('[data-panel-group="' + group + '"][data-panel="' + wanted + '"]')) {
        selectTab(group, wanted);
      }
    });
  }

  function selectTab(group, name) {
    $$('[data-tab-group="' + group + '"]').forEach(function (btn) {
      if (btn.hasAttribute("aria-selected")) {
        btn.setAttribute("aria-selected", String(btn.getAttribute("data-tab") === name));
      }
    });
    $$('[data-panel-group="' + group + '"]').forEach(function (panel) {
      panel.classList.toggle("active", panel.getAttribute("data-panel") === name);
      if (panel.hasAttribute("data-tab-hash") && panel.getAttribute("data-panel") === name) {
        history.replaceState(null, "", "#" + name);
      }
    });
  }

  /* ---------- Pricing: monthly / yearly ---------- */
  function initBilling() {
    var toggle = $("[data-billing-toggle]");
    if (!toggle) return;

    function render() {
      var yearly = toggle.checked;
      $$("[data-monthly]").forEach(function (el) {
        el.textContent = yearly ? el.getAttribute("data-yearly") : el.getAttribute("data-monthly");
      });
      $$("[data-price-note]").forEach(function (el) {
        el.textContent = yearly ? el.getAttribute("data-note-yearly") : el.getAttribute("data-note-monthly");
      });
      $$("[data-billing-label]").forEach(function (el) {
        el.classList.toggle("active", el.getAttribute("data-billing-label") === (yearly ? "yearly" : "monthly"));
      });
    }

    toggle.addEventListener("change", render);
    render();
  }

  /* ---------- Auto-growing textareas ---------- */
  function initAutogrow() {
    $$("[data-autogrow]").forEach(function (ta) {
      function grow() {
        ta.style.height = "auto";
        ta.style.height = Math.min(ta.scrollHeight, 180) + "px";
      }
      ta.addEventListener("input", grow);
      grow();
    });
  }

  /* ---------- Ask box -> chat page (navigation only) ----------
     Carries the typed text to the chat page so the composer is
     pre-filled. Nothing is sent anywhere and no answer is faked. */
  function initAsk() {
    var form = $("[data-ask]");
    if (form) {
      var input = $("[data-ask-input]", form);

      function go() {
        var q = (input && input.value.trim()) || "";
        location.href = "chat.html" + (q ? "?q=" + encodeURIComponent(q) : "");
      }

      form.addEventListener("submit", function (e) { e.preventDefault(); go(); });

      if (input) {
        input.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); }
        });
      }

      $$("[data-suggest]").forEach(function (chip) {
        chip.addEventListener("click", function () {
          if (input) { input.value = chip.getAttribute("data-suggest"); input.focus(); }
        });
      });
    }

    // Chat page: pre-fill the composer from ?q= and from prompt cards.
    var composer = $("[data-composer-input]");
    if (composer) {
      var q = new URLSearchParams(location.search).get("q");
      if (q) {
        composer.value = q;
        composer.dispatchEvent(new Event("input"));
      }
      $$("[data-prompt]").forEach(function (card) {
        card.addEventListener("click", function () {
          composer.value = card.getAttribute("data-prompt");
          composer.dispatchEvent(new Event("input"));
          composer.focus();
        });
      });
    }
  }

  /* ---------- Footer year ---------- */
  function initYear() {
    $$("[data-year]").forEach(function (el) { el.textContent = new Date().getFullYear(); });
  }

  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    initSiteNav();
    initSidebar();
    initTabs();
    initBilling();
    initAutogrow();
    initAsk();
    initYear();
  });
})();
