/**
 * The knowledge-base browse/search page, inlined as a string so it bundles cleanly with tsup
 * (single-entry build) and runs under tsx in dev — no asset copy, no build step. The client
 * script deliberately avoids template literals so this can live in a backtick string.
 */
export const KNOWLEDGE_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>locally · knowledge base</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; padding: 1.5rem; max-width: 900px; margin-inline: auto; }
  h1 { font-size: 1.2rem; margin: 0 0 .25rem; }
  .stats { color: #888; font-size: .85rem; margin-bottom: 1rem; }
  form { display: flex; gap: .5rem; margin-bottom: 1rem; }
  input[type=search] { flex: 1; padding: .55rem .7rem; font-size: 1rem; border: 1px solid #8884; border-radius: 6px; background: transparent; color: inherit; }
  button { padding: .55rem 1rem; font-size: 1rem; border: 1px solid #8884; border-radius: 6px; background: #8881; color: inherit; cursor: pointer; }
  .hit { border: 1px solid #8883; border-radius: 8px; padding: .7rem .9rem; margin-bottom: .8rem; }
  .loc { font-size: .8rem; color: #888; display: flex; justify-content: space-between; gap: 1rem; margin-bottom: .4rem; }
  .loc .path { font-family: ui-monospace, monospace; word-break: break-all; }
  .content { white-space: pre-wrap; }
  .empty { color: #888; padding: 1rem 0; }
  .tabs { display: flex; gap: .5rem; margin-bottom: 1rem; }
  .tabs a { font-size: .85rem; color: #888; cursor: pointer; text-decoration: none; }
</style>
</head>
<body>
  <h1>locally · knowledge base</h1>
  <div class="stats" id="stats">loading…</div>

  <form id="search-form">
    <input type="search" id="q" placeholder="Search your notes…" autofocus autocomplete="off" />
    <button type="submit">Search</button>
  </form>

  <div class="tabs">
    <a id="tab-browse">Browse all chunks</a>
  </div>

  <div id="results"></div>

<script>
var resultsEl = document.getElementById("results");

function esc(s) {
  return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; });
}

function renderHits(hits, withScore) {
  if (!hits.length) { resultsEl.innerHTML = '<div class="empty">No results.</div>'; return; }
  resultsEl.innerHTML = hits.map(function (h) {
    var right = withScore && h.score != null ? "score " + h.score.toFixed(3) : "";
    var loc = h.heading ? esc(h.relPath) + " › " + esc(h.heading) : esc(h.relPath);
    return '<div class="hit"><div class="loc"><span class="path">' + loc +
      '</span><span>' + right + '</span></div><div class="content">' + esc(h.content) + '</div></div>';
  }).join("");
}

function loadStats() {
  fetch("knowledge/stats").then(function (r) { return r.json(); }).then(function (s) {
    var when = s.lastIndexed ? new Date(s.lastIndexed).toLocaleString() : "never";
    document.getElementById("stats").textContent =
      s.files + " files · " + s.chunks + " chunks · dim " + (s.dimensions == null ? "?" : s.dimensions) +
      " · last indexed " + when;
  }).catch(function () { document.getElementById("stats").textContent = "(stats unavailable)"; });
}

function search(q) {
  resultsEl.innerHTML = '<div class="empty">Searching…</div>';
  fetch("knowledge/search?q=" + encodeURIComponent(q) + "&k=10").then(function (r) {
    if (!r.ok) { return r.text().then(function (t) { resultsEl.innerHTML = '<div class="empty">' + esc(t) + '</div>'; }); }
    return r.json().then(function (data) { renderHits(data.results || [], true); });
  }).catch(function (e) { resultsEl.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; });
}

function browse() {
  resultsEl.innerHTML = '<div class="empty">Loading…</div>';
  fetch("knowledge/chunks?limit=100&offset=0").then(function (r) { return r.json(); }).then(function (data) {
    renderHits(data.chunks || [], false);
  }).catch(function (e) { resultsEl.innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; });
}

document.getElementById("search-form").addEventListener("submit", function (e) {
  e.preventDefault();
  var q = document.getElementById("q").value.trim();
  if (q) search(q);
});
document.getElementById("tab-browse").addEventListener("click", browse);

loadStats();
</script>
</body>
</html>`;
