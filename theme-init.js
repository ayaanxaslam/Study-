/* Applies the saved theme before first paint to avoid a flash of the wrong theme. */
(function () {
  try {
    var saved = localStorage.getItem("sp-theme");
    var mode = saved || "system";
    var dark = mode === "dark" ||
      (mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
  } catch (e) {
    document.documentElement.setAttribute("data-theme", "light");
  }
})();
