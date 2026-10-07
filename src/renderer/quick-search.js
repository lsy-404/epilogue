'use strict';
(() => {
  const api = window.epilogueQuickSearch;
  const query = document.getElementById('query');
  const results = document.getElementById('results');
  const status = document.getElementById('status');
  const shortcut = document.getElementById('shortcut');
  const close = document.getElementById('close');
  let hits = [];
  let selected = 0;
  let sequence = 0;
  let timer = null;
  let copy = { empty: '没有匹配文件', loading: '搜索中…', error: '搜索失败，请重试', shortcut: 'Ctrl / Cmd + Shift + Space' };

  function render() {
    results.textContent = '';
    hits.forEach((hit, index) => {
      const row = document.createElement('li');
      row.setAttribute('role', 'option');
      row.className = index === selected ? 'selected' : '';
      row.setAttribute('aria-selected', index === selected ? 'true' : 'false');
      row.innerHTML = `<div class="name"></div><div class="path"></div>`;
      row.querySelector('.name').textContent = hit.fileName || hit.filePath;
      row.querySelector('.path').textContent = hit.filePath;
      row.addEventListener('click', (event) => choose(index, event.shiftKey));
      results.appendChild(row);
    });
    results.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function choose(index, reveal) {
    const hit = hits[index];
    if (!hit) return;
    sequence++;
    api.open(hit.filePath, reveal).then(() => api.hide()).catch((error) => { status.textContent = error.message || copy.error; });
  }

  async function runSearch(value, current) {
    if (!value.trim()) { status.textContent = ''; return; }
    status.textContent = copy.loading;
    try {
      const response = await api.query(value);
      if (current !== sequence) return;
      hits = response.hits || [];
      status.textContent = hits.length ? '' : copy.empty;
      render();
    } catch (error) {
      if (current !== sequence) return;
      status.textContent = error.message || copy.error;
    }
  }

  query.addEventListener('input', () => {
    sequence++;
    hits = [];
    selected = 0;
    render();
    clearTimeout(timer);
    const current = sequence;
    timer = setTimeout(() => runSearch(query.value, current), 120);
  });
  query.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') { sequence++; api.hide(); return; }
    if (event.key === 'ArrowDown' && hits.length) { event.preventDefault(); selected = (selected + 1) % hits.length; render(); }
    if (event.key === 'ArrowUp' && hits.length) { event.preventDefault(); selected = (selected + hits.length - 1) % hits.length; render(); }
    if (event.key === 'Enter' && hits.length) { event.preventDefault(); choose(selected, event.shiftKey); }
  });
  close.addEventListener('click', () => { sequence++; api.hide(); });

  api.state().then((state) => {
    document.documentElement.lang = state.language || 'zh';
    if (state.language === 'en') copy = { empty: 'No matching files', loading: 'Searching…', error: 'Search failed. Try again.', shortcut: 'Ctrl / Cmd + Shift + Space' };
    shortcut.textContent = state.shortcutRegistered ? copy.shortcut : `${copy.shortcut} · unavailable`;
    query.placeholder = state.language === 'en' ? 'Search indexed files…' : '搜索已索引文件…';
    query.focus();
  }).catch(() => query.focus());
  api.onFocus(() => { query.focus(); query.select(); });
})();
