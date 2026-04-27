/* ═══════════════════════════════════════════
   ScreenManager — screen transitions
   ═══════════════════════════════════════════ */

const ScreenManager = (() => {

  const SCREENS = ['login', 'lobby', 'standings', 'mercato', 'formation', 'training', 'match', 'rewards', 'cup', 'season-end'];

  function show(name) {
    SCREENS.forEach(s => {
      const el = document.getElementById(`screen-${s}`);
      if (!el) return;
      const active = s === name;
      el.classList.toggle('active', active);
      // Force via style to override any conflicting CSS rules
      el.style.display = active ? 'flex' : 'none';
    });
    // Sync body class for CSS targeting (e.g. hide header on login/lobby)
    document.body.className = document.body.className
      .replace(/\bscreen-\S+\b/g, '').trim();
    document.body.classList.add('screen-' + name);
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function current() {
    for (const s of SCREENS) {
      const el = document.getElementById(`screen-${s}`);
      if (el && el.classList.contains('active')) return s;
    }
    return null;
  }

  return { show, current };

})();
