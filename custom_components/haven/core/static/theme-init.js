// Apply saved theme before first paint to avoid a flash
  (() => { try { const s = localStorage, d = document.documentElement;
    const pref = s.getItem("mode") || "auto";
    d.dataset.seed = s.getItem("seed") || "ocean";
    d.dataset.mode = pref === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref; } catch {} })();
