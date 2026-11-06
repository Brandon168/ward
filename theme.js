// Runs before first paint (classic script in <head>) so the popup never flashes the wrong theme.
// Follows the system unless Settings > Appearance chose light or dark.
try {
  const t = localStorage.theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  if (t === 'light') document.documentElement.dataset.theme = 'light';
} catch {}
