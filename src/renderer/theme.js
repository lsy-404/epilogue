(() => {
  const query = matchMedia('(prefers-color-scheme: dark)');
  const apply = () => { document.documentElement.dataset.fluentTheme = query.matches ? 'dark' : 'light'; };
  apply();
  query.addEventListener('change', apply);
})();
