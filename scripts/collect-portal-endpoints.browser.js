// Run in the site's DevTools Console after opening the profile or pricing page.
// Passive: no requests, storage access, headers, response bodies or account values.
(() => {
  const known = new Set((
    "api user users self profile account wallet balance quota credits pricing " +
    "models model status groups group checkin check-in check_in daily signin " +
    "sign-in sign_in rewards reward history summary stats statistics performance " +
    "metrics perf-metrics health billing ranking rankings usage me info config settings public " +
    "dashboard subscription subscriptions overview rates ratio ratios calendar " +
    "list available eligibility current today month total check sign_in_status"
  ).split(" "));
  const paths = performance.getEntriesByType("resource").flatMap((entry) => {
    if (!["fetch", "xmlhttprequest"].includes(entry.initiatorType)) return [];
    try {
      const url = new URL(entry.name);
      if (url.origin !== location.origin || !/^\/(api|v\d{1,2})(\/|$)/.test(url.pathname)) return [];
      return [url.pathname.split("/").map((part) =>
        part === "" || known.has(part) || /^v\d{1,2}$/.test(part) ? part : ":value"
      ).join("/")];
    } catch {
      return [];
    }
  });
  console.log(JSON.stringify({
    paths: [...new Set(paths)].sort(),
    note: "Only observed paths; query strings and unrecognized path segments removed.",
  }, null, 2));
})();
