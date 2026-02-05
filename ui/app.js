/* =========================================================
   US SIGNAL | WEBEX PARTNER PORTAL
   Shared UI Runtime (app.js)
   ========================================================= */

"use strict";

/* =========================================================
   CONFIG
========================================================= */
const API_BASE = "/api";

const CACHE_TTL = {
  customers: 60 * 1000,
  health: 60 * 1000,
  history: 5 * 60 * 1000,
  licenses: 2 * 60 * 1000
};

/* =========================================================
   SIMPLE IN-MEMORY CACHE
========================================================= */
const cache = new Map();
const inflight = new Map();

/* =========================================================
   UTILITIES
========================================================= */
function now() {
  return Date.now();
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function debounce(fn, delay = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function qs(sel, root = document) {
  return root.querySelector(sel);
}

function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================================================
   CENTRAL FETCH WRAPPER
========================================================= */
async function apiFetch(path, {
  cacheKey = path,
  ttl = 0,
  method = "GET",
  body = null,
  headers = {}
} = {}) {

  // Cache hit
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > now()) {
    return cached.value;
  }

  // Deduplicate in-flight requests
  if (inflight.has(cacheKey)) {
    return inflight.get(cacheKey);
  }

  const req = (async () => {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers
        },
        body: body ? JSON.stringify(body) : null
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`API ${path} failed (${res.status}): ${text}`);
      }

      const data = await res.json();

      if (ttl > 0) {
        cache.set(cacheKey, {
          value: data,
          expires: now() + ttl
        });
      }

      return data;

    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, req);
  return req;
}

/* =========================================================
   HEALTH HELPERS
========================================================= */
function healthClass(h) {
  if (!h) return "health-unknown";
  return `health-${h}`;
}

function healthBadge(h) {
  return `<span class="badge ${healthClass(h)}">${h}</span>`;
}

function trendDots(history = []) {
  if (!history.length) return `<span class="muted">—</span>`;

  return `
    <div class="trend-row">
      ${history.map(h => `
        <span class="trend-dot ${healthClass(h.overall)}"
              title="${h.date}: ${h.overall}">
        </span>
      `).join("")}
    </div>
  `;
}

/* =========================================================
   DATA LOADERS
========================================================= */
async function loadCustomers() {
  return apiFetch("/customers", {
    cacheKey: "customers",
    ttl: CACHE_TTL.customers
  });
}

async function loadCustomerHealth(key) {
  return apiFetch(`/customer/${key}/health`, {
    cacheKey: `health:${key}`,
    ttl: CACHE_TTL.health
  });
}

async function loadHealthHistory(key) {
  return apiFetch(`/customer/${key}/health-history`, {
    cacheKey: `history:${key}`,
    ttl: CACHE_TTL.history
  });
}

async function loadLicenses(key) {
  return apiFetch(`/customer/${key}/licenses`, {
    cacheKey: `licenses:${key}`,
    ttl: CACHE_TTL.licenses
  });
}

/* =========================================================
   PAGE INITIALIZERS
========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  if (qs("#customers-table")) initCustomersPage();
  if (qs("#customer-detail")) initCustomerPage();
});

/* =========================================================
   CUSTOMERS PAGE
========================================================= */
async function initCustomersPage() {
  const tbody = qs("#customers-table tbody");
  tbody.innerHTML = `<tr><td colspan="5" class="muted">Loading…</td></tr>`;

  try {
    const data = await loadCustomers();
    tbody.innerHTML = "";

    for (const c of data.customers || []) {
      const health = await loadCustomerHealth(c.key);
      const history = await loadHealthHistory(c.key);

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>
          <a href="/customer/${c.key}">
            ${escapeHtml(c.name)}
          </a>
        </td>
        <td class="mono">${escapeHtml(c.orgId || "—")}</td>
        <td>${healthBadge(health.overall)}</td>
        <td>${trendDots(history.history)}</td>
        <td class="muted">${new Date(health.evaluatedAt).toLocaleString()}</td>
      `;
      tbody.appendChild(tr);
    }

  } catch (err) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" class="health-red">
          Failed to load customers: ${escapeHtml(err.message)}
        </td>
      </tr>
    `;
  }
}

/* =========================================================
   CUSTOMER DETAIL PAGE
========================================================= */
async function initCustomerPage() {
  const root = qs("#customer-detail");
  const key = root.dataset.key;

  try {
    const [health, history, licenses] = await Promise.all([
      loadCustomerHealth(key),
      loadHealthHistory(key),
      loadLicenses(key)
    ]);

    renderHealthSummary(health);
    renderHealthTrends(history.history);
    renderLicenses(licenses.licenses);

  } catch (err) {
    root.innerHTML = `
      <div class="card health-red">
        Failed to load customer data: ${escapeHtml(err.message)}
      </div>
    `;
  }
}

/* =========================================================
   RENDERERS
========================================================= */
function renderHealthSummary(h) {
  qs("#health-overall").innerHTML = healthBadge(h.health.overall);
  qs("#health-calling").innerHTML = healthBadge(h.health.calling);
  qs("#health-messaging").innerHTML = healthBadge(h.health.messaging);
  qs("#health-meetings").innerHTML = healthBadge(h.health.meetings);
  qs("#health-devices").innerHTML = healthBadge(h.health.devices);
}

function renderHealthTrends(history) {
  qs("#health-trends").innerHTML = trendDots(history);
}

function renderLicenses(licenses = []) {
  const tbody = qs("#licenses-table tbody");
  tbody.innerHTML = "";

  if (!licenses.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No licenses found</td></tr>`;
    return;
  }

  for (const l of licenses) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(l.sku)}</td>
      <td>${l.total}</td>
      <td>${l.used}</td>
      <td>${l.available}</td>
      <td>${l.deficient ? healthBadge("red") : healthBadge("green")}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* =========================================================
   GLOBAL ERROR SAFETY
========================================================= */
window.addEventListener("unhandledrejection", e => {
  console.error("Unhandled promise rejection:", e.reason);
});
