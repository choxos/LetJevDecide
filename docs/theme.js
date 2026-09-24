// Runs before the page paints, so a chosen night or day edition never flashes the other one.
try {
  const t = localStorage.getItem("ljd-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
