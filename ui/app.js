/* =========================================================
   US SIGNAL | WEBEX PARTNER PORTAL — app.js
   Shared fetch, caching, debounce, error handling, UI renderers
========================================================= */
"use strict";

const API_BASE = "/api";
const cache = new Map();
const inflight = new Map();

const CACHE_TTL = {
  customers: 60 * 1000,
  health: 30 * 1000,
  history: 5 * 60 * 1000,
  licenses: 2 * 60 * 1000,
  devices: 2 * 60 * 1000,
  alerts: 60 * 1000,
  exec: 60 * 1000,
  report: 2 * 60 * 1000
};

function now() { return Date.now(); }

function debounce(fn, delay = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), delay);
  };
}

function qs(sel, root = document) { return root.querySelector(sel); }
function qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); }

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isNotFoundError(err) {
  return /failed \(404\)/i.test(String(err?.message || err));
}

function clearCachePrefix(prefix) {
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

/* =========================================================
   Central API fetch + caching + in-flight de-dupe
========================================================= */
async function apiFetch(path, {
  cacheKey = path,
  ttl = 0,
  method = "GET",
  body = null,
  headers = {}
} = {}) {

  const cached = cache.get(cacheKey);
  if (cached && cached.expires > now()) return cached.value;

  if (inflight.has(cacheKey)) return inflight.get(cacheKey);

  const req = (async () => {
    try {
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        body: body ? JSON.stringify(body) : null
      });

      if (!res.ok) {
        const text = await res.text();
        const err = new Error(`API ${path} failed (${res.status})`);
        err.status = res.status;
        err.body = text.slice(0, 300);
        throw err;
      }

      const contentType = res.headers.get("content-type") || "";

      if (!contentType.includes("application/json")) {
        const text = await res.text();
        const err = new Error(`Non-JSON response from ${path}`);
        err.status = res.status;
        err.body = text.slice(0, 300);
        throw err;
      }

      const data = await res.json();

      if (ttl > 0) {
        cache.set(cacheKey, { value: data, expires: now() + ttl });
      }

      return data;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, req);
  return req;
}
function renderTrendBars(values, { compact = false } = {}) {
  if (!values || !values.length) return `<span class="muted">—</span>`;

  const max = Math.max(...values.map(v => v.value), 1);

  return `
    <div class="trend-mini ${compact ? "compact" : ""}">
      ${values.map(v => {
        const h = Math.round((v.value / max) * 100);
        return `
          <span
            class="trend-bar ${v.level || "green"}"
            style="height:${h}%"
            title="${escapeHtml(v.label)}: ${v.value}"
          ></span>
        `;
      }).join("")}
    </div>
  `;
}
/* =========================================================
   Health UI helpers
========================================================= */
function healthClass(h) {
  if (!h) return "health-unknown";
  return `health-${h}`;
}

function healthBadge(h) {
  return `<span class="badge ${healthClass(h)}">${escapeHtml(h)}</span>`;
}

function trendDots(history = []) {
  if (!history.length) return `<span class="muted">—</span>`;
  return `
    <div class="trend-row">
      ${history.map(h => `
        <span class="trend-dot ${healthClass(h.overall)}"
              title="${escapeHtml(h.date)}: ${escapeHtml(h.overall)}"></span>
      `).join("")}
    </div>
  `;
}

function healthOrder(h) {
  const o = { red: 3, yellow: 2, green: 1, unknown: 0 };
  return o[h] ?? 0;
}

/* =========================================================
   Loaders (existing + new)
========================================================= */
const loadCustomers = () => apiFetch("/customers", { cacheKey: "customers", ttl: CACHE_TTL.customers });

const loadCustomerHealth = (key) =>
  apiFetch(`/customer/${encodeURIComponent(key)}/health`, { cacheKey: `health:${key}`, ttl: CACHE_TTL.health });

const loadHealthHistory = (key) =>
  apiFetch(`/customer/${encodeURIComponent(key)}/health-history`, { cacheKey: `history:${key}`, ttl: CACHE_TTL.history });

const loadLicenses = (key) =>
  apiFetch(`/customer/${encodeURIComponent(key)}/licenses`, { cacheKey: `licenses:${key}`, ttl: CACHE_TTL.licenses });

/**
 * NEW: devices endpoint (add to worker later)
 * Expected shape:
 * { ok:true, devices:[ {name, model, connectionStatus, lastSeen, location, mac, ip, ...} ] }
 */
const loadDevices = (key) =>
  apiFetch(`/customer/${encodeURIComponent(key)}/devices`, { cacheKey: `devices:${key}`, ttl: CACHE_TTL.devices });

/**
 * NEW: health alerts endpoint (add to worker later)
 * Expected shape:
 * { ok:true, alerts:[ {occurredAt, from, to, reason, emailedTo:[...]} ] }
 */
const loadAlerts = (key) =>
  apiFetch(`/customer/${encodeURIComponent(key)}/alerts`, { cacheKey: `alerts:${key}`, ttl: CACHE_TTL.alerts });

/**
 * Manual re-eval
 * Preferred: POST /api/customer/:key/health/reeval
 * Fallback: GET /api/customer/:key/health?force=1 (worker can ignore caches)
 */
async function triggerReeval(key) {
  try {
    return await apiFetch(`/customer/${encodeURIComponent(key)}/health/reeval`, {
      method: "POST",
      ttl: 0,
      cacheKey: `reeval:${key}:${now()}`
    });
  } catch (err) {
    // fallback to GET with cache-buster
    return apiFetch(`/customer/${encodeURIComponent(key)}/health?force=1&t=${now()}`, {
      ttl: 0,
      cacheKey: `health_force:${key}:${now()}`
    });
  }
}
/**
 * NEW: customer analytics (calling, meetings, devices)
 */
const loadAnalytics = (key) =>
  apiFetch(`/customer/${encodeURIComponent(key)}/analytics`, {
    cacheKey: `analytics:${key}`,
    ttl: 2 * 60 * 1000
  });

/**
 * NEW: PSTN health / trunks / sites
 */
const loadPstn = (key) =>
  apiFetch(`/customer/${encodeURIComponent(key)}/pstn`, {
    cacheKey: `pstn:${key}`,
    ttl: 2 * 60 * 1000
  });

/**
 * NEW: Call Detail Records
 */
const loadCdr = (key) =>
  apiFetch(`/customer/${encodeURIComponent(key)}/cdr`, {
    cacheKey: `cdr:${key}`,
    ttl: 2 * 60 * 1000
  });

/* =========================================================
   Routing helpers for UI pages
========================================================= */
function getCustomerKeyFromPath() {
  // supports /customer/<key> routes (worker maps to customer.html)
  const parts = location.pathname.split("/").filter(Boolean);
  const idx = parts.indexOf("customer");
  return idx >= 0 ? (parts[idx + 1] || "") : "";
}

function setTabs() {
  const tabs = qsa(".tab");
  const panels = {
    licenses: qs("#tab-licenses"),
    devices: qs("#tab-devices"),
    alerts: qs("#tab-alerts"),
    report: qs("#tab-report"),
    analytics: qs("#tab-analytics"),
    pstn: qs("#tab-pstn"),
    cdr: qs("#tab-cdr")
  };

  const key = getCustomerKeyFromPath();

  function activate(name) {
    tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));

    Object.entries(panels).forEach(([k, el]) => {
      if (!el) return;
      el.classList.toggle("hidden", k !== name);
    });

    // Lazy load when tab is opened
    switch (name) {
      case "devices":
        hydrateDevices(key);
        break;
      case "alerts":
        hydrateAlerts(key);
        break;
      case "analytics":
        hydrateAnalytics(key);
        break;
      case "pstn":
        hydratePstn(key);
        break;
      case "cdr":
        hydrateCdr(key);
        break;
    }
  }

  tabs.forEach(btn =>
    btn.addEventListener("click", () => activate(btn.dataset.tab))
  );

  activate("licenses");
}

/* =========================================================
   Page init
========================================================= */
document.addEventListener("DOMContentLoaded", () => {
  if (document.body.dataset.page === "dashboard") initDashboardPage();

  if (qs("#customers-table")) initCustomersPage();
  if (qs("#customer-detail") || qs("#tab-licenses")) initCustomerPage();
  if (qs("#exec-table")) initExecutivePage();
  if (qs("#customer-report")) initReportPage();
});

/* =========================================================
   Customers page (simple)
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
        <td><a href="/customer/${encodeURIComponent(c.key)}">${escapeHtml(c.name)}</a></td>
        <td class="mono">${escapeHtml(c.orgId || "—")}</td>
        <td>${healthBadge(health.overall || health.health?.overall)}</td>
        <td>${trendDots(history.history)}</td>
        <td class="muted">${health.evaluatedAt ? new Date(health.evaluatedAt).toLocaleString() : "—"}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = `
      <tr><td colspan="5" class="health-red">Failed to load customers: ${escapeHtml(err.message)}</td></tr>
    `;
  }
}
/* =========================================================
   Dashboard page (KPIs)
========================================================= */
async function initDashboardPage() {
  const elCustomers = qs("#kpi-customers");
  const elHealth = qs("#kpi-health");
  const elLicenses = qs("#kpi-licenses");
  const elPlatform = qs("#kpi-platform");

  if (!elCustomers && !elHealth && !elLicenses && !elPlatform) return;

  try {
    const data = await loadCustomers();
    const customers = Array.isArray(data.customers)
      ? data.customers
      : [];

    /* ============================
       Customers KPI
    ============================ */
    if (elCustomers) {
      elCustomers.textContent = customers.length.toLocaleString();
    }

    /* ============================
       Overall Health KPI
    ============================ */
    if (elHealth) {
      elHealth.textContent = "Evaluating…";
      let worstHealth = "green";

      for (const c of customers) {
        const health = await loadCustomerHealth(c.key);
        const h = health.health || health;
        const overall = health.overall || h.overall || "unknown";

        if (healthOrder(overall) > healthOrder(worstHealth)) {
          worstHealth = overall;
        }
        if (worstHealth === "red") break;
      }

      elHealth.innerHTML = healthBadge(worstHealth);
    }

    /* ============================
       License Risk KPI
    ============================ */
    if (elLicenses) {
      elLicenses.textContent = "Checking…";
      let atRisk = false;

      for (const c of customers) {
        const health = await loadCustomerHealth(c.key);
        const deficient = Array.isArray(health.deficientSkus)
          ? health.deficientSkus.length
          : 0;

        if (deficient > 0) {
          atRisk = true;
          break;
        }
      }

      elLicenses.innerHTML = atRisk
        ? healthBadge("red")
        : healthBadge("green");
    }

    /* ============================
       Platform Status KPI
    ============================ */
    if (elPlatform) {
      elPlatform.textContent = "Checking…";

      try {
        const status = await apiFetch("/status", {
          cacheKey: "platform-status",
          ttl: 60 * 1000
        });

        const components = status.components || [];
        const degraded = components.some(c =>
          c.status && c.status !== "operational"
        );

        elPlatform.innerHTML = degraded
          ? healthBadge("red")
          : healthBadge("green");

      } catch {
        elPlatform.innerHTML = `<span class="health-unknown">unknown</span>`;
      }
    }

  } catch (err) {
    console.error("Failed to load Dashboard KPIs:", err);

    if (elCustomers) elCustomers.innerHTML = `<span class="health-red">Error</span>`;
    if (elHealth) elHealth.innerHTML = `<span class="health-red">Error</span>`;
    if (elLicenses) elLicenses.innerHTML = `<span class="health-red">Error</span>`;
    if (elPlatform) elPlatform.innerHTML = `<span class="health-red">Error</span>`;
  }
}

/* =========================================================
   Customer page (deep dive)
========================================================= */
async function initCustomerPage() {
  const key = getCustomerKeyFromPath();
  const marker = qs("#customer-detail");
  if (marker) marker.dataset.key = key;

  // Tabs + actions
  if (qs(".tab")) setTabs();

  const btnRefresh = qs("#btn-refresh");
  const btnReeval = qs("#btn-reeval");
  const btnPrint = qs("#btn-print");
  const btnEmail = qs("#btn-email-alert");
  const btnOpenReport = qs("#btn-open-report");
  const btnPrintInline = qs("#btn-print-inline");
  const btnRefreshAlerts = qs("#btn-refresh-alerts");

  if (btnRefresh) btnRefresh.addEventListener("click", async () => {
    clearCachePrefix(`health:${key}`);
    clearCachePrefix(`history:${key}`);
    clearCachePrefix(`licenses:${key}`);
    clearCachePrefix(`devices:${key}`);
    clearCachePrefix(`alerts:${key}`);
    await hydrateCustomerPage(key, { force: true });
  });

  if (btnReeval) btnReeval.addEventListener("click", async () => {
    btnReeval.disabled = true;
    btnReeval.textContent = "Re-evaluating…";
    try {
      // clear cached view first so UI uses fresh data
      clearCachePrefix(`health:${key}`);
      await triggerReeval(key);
      await hydrateCustomerPage(key, { force: true });
    } finally {
      btnReeval.disabled = false;
      btnReeval.textContent = "Manual Re-eval";
    }
  });

  if (btnPrint) btnPrint.addEventListener("click", () => {
    window.open(`/report?customer=${encodeURIComponent(key)}`, "_blank");
  });

  if (btnOpenReport) btnOpenReport.addEventListener("click", () => {
    window.open(`/report?customer=${encodeURIComponent(key)}`, "_blank");
  });

  if (btnPrintInline) btnPrintInline.addEventListener("click", () => window.print());

  if (btnEmail) btnEmail.addEventListener("click", async () => {
    btnEmail.disabled = true;
    btnEmail.textContent = "Sending…";
    try {
      await apiFetch(`/customer/${encodeURIComponent(key)}/license-alert`, {
        method: "POST",
        body: {},
        ttl: 0,
        cacheKey: `license_alert:${key}:${now()}`
      });
      btnEmail.textContent = "Email Sent";
      setTimeout(() => (btnEmail.textContent = "Send License Alert Email"), 1500);
    } catch (err) {
      alert(`Failed to send: ${err.message}`);
      btnEmail.textContent = "Send License Alert Email";
    } finally {
      btnEmail.disabled = false;
    }
  });

  if (btnRefreshAlerts) btnRefreshAlerts.addEventListener("click", async () => {
    clearCachePrefix(`alerts:${key}`);
    await hydrateAlerts(key);
  });

  // Devices filters
  const deviceFilter = qs("#device-filter");
  const deviceSearch = qs("#device-search");
  if (deviceFilter) deviceFilter.addEventListener("change", () => applyDeviceFilters());
  if (deviceSearch) deviceSearch.addEventListener("input", debounce(() => applyDeviceFilters(), 200));

  await hydrateCustomerPage(key, { force: false });
}

async function hydrateCustomerPage(key, { force }) {
  // Header/basic identity
  qs("#cust-key") && (qs("#cust-key").textContent = key);

  // Pull health + history + licenses in parallel
  const [health, history, licenses] = await Promise.all([
    loadCustomerHealth(key),
    loadHealthHistory(key),
    loadLicenses(key)
  ]);

  // Customer info
  const cust = health.customer || licenses.customer || {};
  if (qs("#cust-name")) qs("#cust-name").textContent = cust.name || `Customer: ${key}`;
  if (qs("#cust-org")) qs("#cust-org").textContent = `OrgID: ${cust.orgId || "—"}`;

  // Normalize health shape
  const h = health.health || health;
  const overall = health.overall || h.overall;

  // Summary badges
  qs("#health-overall") && (qs("#health-overall").innerHTML = healthBadge(overall));
  qs("#health-calling") && (qs("#health-calling").innerHTML = healthBadge(h.calling));
  qs("#health-messaging") && (qs("#health-messaging").innerHTML = healthBadge(h.messaging));
  qs("#health-meetings") && (qs("#health-meetings").innerHTML = healthBadge(h.meetings));
  qs("#health-devices") && (qs("#health-devices").innerHTML = healthBadge(h.devices || "unknown"));

  qs("#health-evaluated") && (qs("#health-evaluated").textContent =
    health.evaluatedAt ? new Date(health.evaluatedAt).toLocaleString() : "—"
  );

  // Trend
  qs("#health-trends") && (qs("#health-trends").innerHTML = trendDots(history.history || []));
  qs("#trend-hint") && (qs("#trend-hint").textContent = `${(history.history || []).length} days`);

  // Transition banner (if worker includes transition)
  const banner = qs("#transition-banner");
  if (banner) {
    const t = health.transition;
    if (t?.from && t?.to) {
      banner.classList.remove("hidden");
      banner.innerHTML = `
        <b>Health Transition:</b> ${healthBadge(t.from)} → ${healthBadge(t.to)}
        <span class="muted small">(${new Date(t.occurredAt).toLocaleString()})</span>
      `;
    } else {
      banner.classList.add("hidden");
      banner.innerHTML = "";
    }
  }

  // Deficient SKUs (from health endpoint)
  renderDeficientSkus(health.deficientSkus || []);

  // Licenses table
  renderLicenses(licenses.licenses || []);

  // Devices + Alerts + Report preview are “best effort”
  hydrateDevices(key);
  hydrateAlerts(key);
  hydrateReportPreview(key, { health, history, licenses });
}

function renderDeficientSkus(rows) {
  const tbody = qs("#deficient-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="muted">No deficiencies</td></tr>`;
    return;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.sku)}</td>
      <td class="mono">${Number(r.available ?? 0)}</td>
      <td class="mono">${Number(r.threshold ?? 0)}</td>
    `;
    tbody.appendChild(tr);
  }
}

function renderLicenses(licenses) {
  const tbody = qs("#licenses-table tbody");
  if (!tbody) return;

  tbody.innerHTML = "";
  if (!licenses.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No licenses found</td></tr>`;
    return;
  }

  for (const l of licenses) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(l.sku)}</td>
      <td class="mono">${Number(l.total ?? 0)}</td>
      <td class="mono">${Number(l.used ?? 0)}</td>
      <td class="mono">${Number(l.available ?? 0)}</td>
      <td>${l.deficient ? healthBadge("red") : healthBadge("green")}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* =========================================================
   Devices UI (drill-down)
========================================================= */
let _deviceRows = [];

async function hydrateDevices(key) {
  const tbody = qs("#devices-table tbody");
  const summary = qs("#devices-summary");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="6" class="muted">Loading…</td></tr>`;
  summary && (summary.textContent = "Loading device inventory…");

  try {
    const data = await loadDevices(key);
    const devices = data.devices || data.items || [];

    _deviceRows = devices.map(d => normalizeDeviceRow(d));
    applyDeviceFilters();

    const offlineCount = _deviceRows.filter(r => r.statusClass === "health-red").length;
    summary && (summary.textContent =
      `${_deviceRows.length} devices • ${offlineCount} offline/disconnected`
    );
  } catch (err) {
    if (isNotFoundError(err)) {
      tbody.innerHTML = `
        <tr><td colspan="6" class="muted">
          Devices endpoint not available yet. Add <span class="mono">/api/customer/:key/devices</span> to worker.
        </td></tr>`;
      summary && (summary.textContent = "Devices API not enabled yet.");
      return;
    }

    tbody.innerHTML = `
  <tr>
    <td colspan="6">
      <div class="empty-state">
        <div class="empty-title">Device data unavailable</div>
        <div class="empty-text">
          Device inventory is not currently accessible from Webex Control Hub
          or the API endpoint is not yet enabled.
        </div>
      </div>
    </td>
  </tr>
`;
summary && (summary.textContent = "Device data not available.");

  }
}

function normalizeDeviceRow(d) {
  const name = d.displayName || d.name || d.deviceName || "—";
  const model = d.product || d.model || d.deviceModel || "—";
  const statusRaw = String(d.connectionStatus || d.status || "").toLowerCase();
  const status =
    statusRaw.includes("offline") || statusRaw.includes("disconnected") ? "offline" :
    statusRaw.includes("online") || statusRaw.includes("connected") ? "online" :
    statusRaw || "unknown";

  const lastSeen = d.lastSeen || d.lastActivityTime || d.lastUpdated || null;
  const location = d.locationName || d.placeName || d.location || "—";

  // Root cause heuristic (best effort)
  // - if no lastSeen: registration/inventory drift
  // - offline + lastSeen old: power/network likely
  // - disconnected: network/LAN
  const rootCause = guessDeviceRootCause({ status, lastSeen });

  const statusClass =
    status === "offline" ? "health-red" :
    status === "online" ? "health-green" :
    "health-unknown";

  const searchable = `${name} ${model} ${status} ${location} ${d.mac || ""} ${d.ipAddress || ""}`.toLowerCase();

  return {
    name,
    model,
    status,
    statusClass,
    lastSeen,
    location,
    rootCause,
    searchable
  };
}

function guessDeviceRootCause({ status, lastSeen }) {
  if (!lastSeen) return "Cloud inventory / registration drift";
  const ageMs = Date.now() - new Date(lastSeen).getTime();
  const hours = isFinite(ageMs) ? ageMs / 36e5 : null;

  if (status === "offline") {
    if (hours != null && hours > 48) return "Power / site outage likely";
    return "Network / power intermittent";
  }
  if (status === "disconnected") return "LAN / network drop likely";
  return "—";
}

function applyDeviceFilters() {
  const tbody = qs("#devices-table tbody");
  if (!tbody) return;

  const f = qs("#device-filter")?.value || "all";
  const q = (qs("#device-search")?.value || "").trim().toLowerCase();

  let rows = _deviceRows.slice();

  if (f === "offline") rows = rows.filter(r => r.status === "offline" || r.status === "disconnected");
  if (f === "online") rows = rows.filter(r => r.status === "online" || r.status === "connected");
  if (q) rows = rows.filter(r => r.searchable.includes(q));

  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No matching devices</td></tr>`;
    return;
  }

  for (const r of rows) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(r.model)}</td>
      <td><span class="badge ${r.statusClass}">${escapeHtml(r.status)}</span></td>
      <td class="mono">${r.lastSeen ? new Date(r.lastSeen).toLocaleString() : "—"}</td>
      <td>${escapeHtml(r.location)}</td>
      <td class="muted">${escapeHtml(r.rootCause)}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* =========================================================
   Alerts UI (audit)
========================================================= */
async function hydrateAlerts(key) {
  const tbody = qs("#alerts-table tbody");
  if (!tbody) return;

  tbody.innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;

  try {
    const data = await loadAlerts(key);
    const alerts = data.alerts || data.items || [];

    tbody.innerHTML = "";

    if (!alerts.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="muted">No alerts recorded</td></tr>`;
      return;
    }

    for (const a of alerts) {
      const when = a.occurredAt || a.when || a.timestamp || null;
      const from = a.from || a.prev || "—";
      const to = a.to || a.current || "—";
      const why = a.reason || a.why || a.message || "Health degradation";
      const emailed = Array.isArray(a.emailedTo) ? a.emailedTo.join(", ") : (a.emailedTo || "—");

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${when ? new Date(when).toLocaleString() : "—"}</td>
        <td>${healthBadge(from)} → ${healthBadge(to)}</td>
        <td>${escapeHtml(why)}</td>
        <td class="muted">${escapeHtml(emailed)}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    if (isNotFoundError(err)) {
      tbody.innerHTML = `
        <tr><td colspan="4" class="muted">
          Alerts endpoint not available yet. Add <span class="mono">/api/customer/:key/alerts</span> to worker.
        </td></tr>`;
      return;
    }
    tbody.innerHTML = `
  <tr>
    <td colspan="4">
      <div class="empty-state">
        <div class="empty-title">No health alerts</div>
        <div class="empty-text">
          This customer has not triggered any health transitions
          that required notification.
        </div>
      </div>
    </td>
  </tr>
`;
  }
}
/* =========================================================
   Analytics UI
========================================================= */
/* =========================================================
   Analytics UI (Calling + Meetings + Insights)
========================================================= */
async function hydrateAnalytics(key) {
  const el = qs("#tab-analytics");
  if (!el) return;

  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-title">Loading analytics</div>
      <div class="empty-text">Fetching calling and meeting KPIs…</div>
    </div>
  `;

  try {
    const data = await loadAnalytics(key);

    const calling = data.kpis?.calling || {};
    const meetings = data.kpis?.meetings || {};
    const insights = Array.isArray(data.insights) ? data.insights : [];

  el.innerHTML = `
  <div class="kpi-row">
    <div class="kpi">
      <div class="muted">Total Calls</div>
      <b>${calling.totalCalls ?? "—"}</b>
    </div>
    <div class="kpi">
      <div class="muted">Call Fail %</div>
      <b>${calling.failedPct ?? 0}%</b>
    </div>
    <div class="kpi">
      <div class="muted">PSTN Usage</div>
      <b>${calling.pstnPct ?? 0}%</b>
    </div>
    <div class="kpi">
      <div class="muted">Peak Hour</div>
      <b>${calling.peakHour ?? "—"}</b>
    </div>
  </div>

  <div class="card" style="margin-top:16px;">
    <div class="row between">
      <div class="card-title">Calling Volume Trend (24h)</div>
      <span class="muted small">Hourly distribution</span>
    </div>

    ${renderTrendBars(
      (calling.hourly || []).map(h => ({
        value: h.calls,
        label: h.hour,
        level:
  h.calls < calling.critThreshold ? "red" :
  h.calls < calling.warnThreshold ? "yellow" :
  "green"

      }))
    )}
  </div>

  <div class="kpi-row" style="margin-top:16px;">
    <div class="kpi">
      <div class="muted">Meetings</div>
      <b>${meetings.totalMeetings ?? "—"}</b>
    </div>
    <div class="kpi">
      <div class="muted">Join Failure %</div>
      <b>${meetings.joinFailurePct ?? 0}%</b>
    </div>
    <div class="kpi">
      <div class="muted">Avg Participants</div>
      <b>${meetings.avgParticipants ?? "—"}</b>
    </div>
  </div>

  ${
    insights.length
      ? `
        <div class="card" style="margin-top:16px;">
          <div class="card-title">Insights</div>
          ${insights.map(i => `
            <div class="banner banner-${i.level}">
              <b>${escapeHtml(i.title)}</b><br/>
              <span class="muted">${escapeHtml(i.message)}</span>
            </div>
          `).join("")}
        </div>
      `
      : `
        <div class="muted" style="margin-top:12px;">
          No risk insights detected for this period.
        </div>
      `
  }
`;

  } catch (err) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">Analytics unavailable</div>
        <div class="empty-text">${escapeHtml(err.message)}</div>
      </div>
    `;
  }
}

/* =========================================================
   PSTN UI (Trunks + Sites)
========================================================= */
async function hydratePstn(key) {
  const el = qs("#tab-pstn");
  if (!el) return;

  el.innerHTML = `
    <div class="empty-state">
      <div class="empty-title">Loading PSTN data</div>
      <div class="empty-text">Fetching trunks and site configuration…</div>
    </div>
  `;

  try {
    const data = await loadPstn(key);
    const trunks = data.trunks || [];
    const sites = data.sites || [];

    el.innerHTML = `
      <div class="card">
        <div class="card-title">PSTN Trunks</div>
        ${trunks.length ? `
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Active</th>
                  <th>Max</th>
                  <th>Utilization</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                ${trunks.map(t => `
                  <tr>
                    <td>${escapeHtml(t.name)}</td>
                    <td class="mono">${t.activeCalls}</td>
                    <td class="mono">${t.maxCalls}</td>
                    <td>
  ${renderTrendBars(
    [{
      value: t.utilizationPct,
      label: "Utilization",
      level:
        t.utilizationPct > 85 ? "red" :
        t.utilizationPct > 65 ? "yellow" :
        "green"
    }],
    { compact: true }
  )}
</td>

                    <td>${healthBadge(t.health)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        ` : `<div class="muted">No PSTN trunks configured</div>`}
      </div>

      <div class="card" style="margin-top:16px;">
        <div class="card-title">PSTN Sites</div>
        ${sites.length ? `
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Site</th>
                  <th>PSTN Type</th>
                  <th>Redundant</th>
                </tr>
              </thead>
              <tbody>
                ${sites.map(s => `
                  <tr>
                    <td>${escapeHtml(s.name)}</td>
                    <td class="mono">${escapeHtml(s.pstnType)}</td>
                    <td>${s.redundancy ? "Yes" : "No"}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        ` : `<div class="muted">No PSTN-enabled sites found</div>`}
      </div>
    `;
  } catch (err) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">PSTN unavailable</div>
        <div class="empty-text">${escapeHtml(err.message)}</div>
      </div>
    `;
  }
}
/* =========================================================
   CDR UI (Call Detail Summary)
========================================================= */
async function hydrateCdr(key) {
  const el = qs("#tab-cdr");
  if (!el) return;
el.innerHTML = `
    <div class="empty-state">
      <div class="empty-title">Loading CDR</div>
      <div class="empty-text">Fetching call detail records…</div>
    </div>
  `;

  try {
    const data = await loadCdr(key);
    const m = data.metrics || data.kpis || {};

  el.innerHTML = `
  <div class="kpi-row">
    <div class="kpi">
      <div class="muted">Total Calls</div>
      <b>${m.totalCalls ?? "—"}</b>
    </div>
    <div class="kpi">
      <div class="muted">Dropped Call %</div>
      <b>${m.droppedCallPct ?? 0}%</b>
    </div>
    <div class="kpi">
      <div class="muted">Avg Duration</div>
      <b>${m.avgDurationSeconds ?? 0}s</b>
    </div>
    <div class="kpi">
      <div class="muted">Peak Hour</div>
      <b>${m.peakHour ?? "—"}</b>
    </div>
  </div>

  <div class="card" style="margin-top:16px;">
    <div class="card-title">Call Volume Trend (7 Days)</div>

    ${renderTrendBars(
      (data.trend || []).map(d => ({
        value: d.totalCalls,
        label: d.date,
        level:
          d.failedPct > 5 ? "red" :
          d.failedPct > 2 ? "yellow" :
          "green"
      }))
    )}
  </div>

  <div class="muted small" style="margin-top:12px;">
    Source: Webex Call Detail Records (last 7 days)
  </div>
`;

  } catch (err) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-title">CDR unavailable</div>
        <div class="empty-text">
          ${escapeHtml(err.message)}<br/>
          Ensure CDR access is enabled for this org.
        </div>
      </div>
    `;
  }
}


/* =========================================================
   Executive page
========================================================= */
async function initExecutivePage() {
  const tbody = qs("#exec-table tbody");
  const counts = qs("#exec-counts");
  const worst = qs("#exec-worst");
  const transitions = qs("#exec-transitions");
  const search = qs("#exec-search");
  const btn = qs("#btn-exec-refresh");

  async function hydrate() {
    tbody.innerHTML = `<tr><td colspan="8" class="muted">Loading…</td></tr>`;
    counts.textContent = "Loading…";
    worst.textContent = "Loading…";
    transitions.textContent = "Loading…";

    const data = await loadCustomers();
    const rows = [];

    for (const c of data.customers || []) {
      const [health, history] = await Promise.all([
        loadCustomerHealth(c.key),
        loadHealthHistory(c.key)
      ]);

      const h = health.health || health;
      rows.push({
        key: c.key,
        name: c.name,
        orgId: c.orgId || "",
        overall: health.overall || h.overall,
        calling: h.calling,
        messaging: h.messaging,
        meetings: h.meetings,
        devices: h.devices || "unknown",
        evaluatedAt: health.evaluatedAt || null,
        history: history.history || []
      });
    }

    // sort by risk (overall, then devices, then calling)
    rows.sort((a, b) => {
      const d = healthOrder(b.overall) - healthOrder(a.overall);
      if (d) return d;
      const dd = healthOrder(b.devices) - healthOrder(a.devices);
      if (dd) return dd;
      return healthOrder(b.calling) - healthOrder(a.calling);
    });

    // counts
    const cGreen = rows.filter(r => r.overall === "green").length;
    const cYellow = rows.filter(r => r.overall === "yellow").length;
    const cRed = rows.filter(r => r.overall === "red").length;

    counts.innerHTML = `
      <div class="kpi-row">
        <div class="kpi">${healthBadge("green")} <b>${cGreen}</b></div>
        <div class="kpi">${healthBadge("yellow")} <b>${cYellow}</b></div>
        <div class="kpi">${healthBadge("red")} <b>${cRed}</b></div>
        <div class="kpi muted">Total: <b>${rows.length}</b></div>
      </div>
    `;

    // worst top 5
    worst.innerHTML = rows.slice(0, 5).map(r => `
      <div class="row between">
        <a href="/customer/${encodeURIComponent(r.key)}">${escapeHtml(r.name)}</a>
        <span>${healthBadge(r.overall)}</span>
      </div>
    `).join("");

    // transitions (best effort: worker may include transition in health)
    const tRows = rows
      .map(r => ({ r, t: (r.transition || null) }))
      .filter(x => x.t?.from && x.t?.to);

    transitions.innerHTML = tRows.length
      ? tRows.slice(0, 5).map(x => `
          <div class="row between">
            <a href="/customer/${encodeURIComponent(x.r.key)}">${escapeHtml(x.r.name)}</a>
            <span>${healthBadge(x.t.from)} → ${healthBadge(x.t.to)}</span>
          </div>
        `).join("")
      : `<div class="muted">No recent transitions available</div>`;

    // table
    function renderTable(filterText = "") {
      const ft = filterText.trim().toLowerCase();
      const list = ft ? rows.filter(r => r.name.toLowerCase().includes(ft)) : rows;

      tbody.innerHTML = "";
      for (const r of list) {
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td><a href="/customer/${encodeURIComponent(r.key)}">${escapeHtml(r.name)}</a></td>
          <td>${healthBadge(r.overall)}</td>
          <td>${healthBadge(r.calling)}</td>
          <td>${healthBadge(r.messaging)}</td>
          <td>${healthBadge(r.meetings)}</td>
          <td>${healthBadge(r.devices)}</td>
          <td>
  ${renderTrendBars(
    (r.history || []).map(h => ({
      value: healthOrder(h.overall),
      label: h.date,
      level: h.overall
    })),
    { compact: true }
  )}
</td>

          <td class="muted">${r.evaluatedAt ? new Date(r.evaluatedAt).toLocaleString() : "—"}</td>
        `;
        tbody.appendChild(tr);
      }

      if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="8" class="muted">No matching customers</td></tr>`;
      }
    }

    renderTable(search?.value || "");
    if (search) search.oninput = debounce(() => renderTable(search.value), 200);
  }

  if (btn) btn.addEventListener("click", async () => {
    cache.delete("customers");
    clearCachePrefix("health:");
    clearCachePrefix("history:");
    await hydrate();
  });

  await hydrate();
}

/* =========================================================
   Report page
========================================================= */
async function initReportPage() {
  const marker = qs("#customer-report");
  if (!marker) return;

  const url = new URL(location.href);
  const key = url.searchParams.get("customer") || "";
  marker.dataset.key = key;

  if (!key) {
    document.body.innerHTML = `<div class="container"><div class="card health-red">Missing customer parameter.</div></div>`;
    return;
  }

  const [health, history, licenses] = await Promise.all([
    loadCustomerHealth(key),
    loadHealthHistory(key),
    loadLicenses(key)
  ]);

  // best effort devices & alerts
  const devices = await safeOptional(() => loadDevices(key));
  const alerts = await safeOptional(() => loadAlerts(key));

  const cust = health.customer || licenses.customer || {};
  qs("#report-customer").textContent = cust.name || `Customer: ${key}`;
  qs("#report-meta").textContent = `${new Date().toLocaleString()} • Key: ${key} • OrgID: ${cust.orgId || "—"}`;

  const h = health.health || health;
  const overall = health.overall || h.overall;

  qs("#report-kpis").innerHTML = `
    <div class="kpi-row">
      <div class="kpi"><div class="muted">Overall</div>${healthBadge(overall)}</div>
      <div class="kpi"><div class="muted">Calling</div>${healthBadge(h.calling)}</div>
      <div class="kpi"><div class="muted">Messaging</div>${healthBadge(h.messaging)}</div>
      <div class="kpi"><div class="muted">Meetings</div>${healthBadge(h.meetings)}</div>
      <div class="kpi"><div class="muted">Devices</div>${healthBadge(h.devices || "unknown")}</div>
    </div>
  `;

  qs("#report-trend").innerHTML = trendDots(history.history || []);

  qs("#report-deficient").innerHTML = (health.deficientSkus || []).length
    ? `<ul>${health.deficientSkus.map(x => `<li><b>${escapeHtml(x.sku)}</b> — available ${x.available} (threshold ${x.threshold})</li>`).join("")}</ul>`
    : `<div class="muted">No deficiencies detected</div>`;

  // devices summary
  if (devices?.ok && Array.isArray(devices.devices)) {
    const total = devices.devices.length;
    const offline = devices.devices.filter(d => String(d.connectionStatus || "").toLowerCase().includes("offline")).length;
    qs("#report-devices").innerHTML = `<div>${total} devices • ${offline} offline/disconnected</div>`;
  } else {
    qs("#report-devices").innerHTML = `<div class="muted">Devices API not available yet</div>`;
  }

  // alerts summary
  if (alerts?.ok && Array.isArray(alerts.alerts)) {
    const items = alerts.alerts.slice(0, 10);
    qs("#report-alerts").innerHTML = items.length
      ? `<ul>${items.map(a => `<li>${escapeHtml(a.occurredAt || a.when || "—")}: ${escapeHtml(a.from || "—")} → ${escapeHtml(a.to || "—")} (${escapeHtml(a.reason || "Health degradation")})</li>`).join("")}</ul>`
      : `<div class="muted">No alerts recorded</div>`;
  } else {
    qs("#report-alerts").innerHTML = `<div class="muted">Alerts API not available yet</div>`;
  }

  // auto-open print dialog if you want later (leave off for now)
  // window.print();
}

async function hydrateReportPreview(key, { health, history, licenses }) {
  const el = qs("#report-preview");
  if (!el) return;

  const cust = health.customer || licenses.customer || {};
  const h = health.health || health;
  const overall = health.overall || h.overall;

  el.innerHTML = `
    <div class="report-card">
      <div class="row between">
        <div><b>${escapeHtml(cust.name || key)}</b> <span class="muted mono">(${escapeHtml(cust.orgId || "—")})</span></div>
        <div>${healthBadge(overall)}</div>
      </div>
      <div class="muted small">Calling ${healthBadge(h.calling)} • Messaging ${healthBadge(h.messaging)} • Meetings ${healthBadge(h.meetings)} • Devices ${healthBadge(h.devices || "unknown")}</div>
      <div class="muted small" style="margin-top:8px;">Trend</div>
      ${trendDots(history.history || [])}
      <div class="muted small" style="margin-top:8px;">Tip: Open the report page for a print-ready version.</div>
    </div>
  `;
}

async function safeOptional(fn) {
  try { return await fn(); } catch { return null; }
}
/* =========================================================
   THEME TOGGLE (LIGHT / DARK)
========================================================= */
(function () {
  const root = document.documentElement;
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;

  const saved = localStorage.getItem("theme");
  if (saved) root.setAttribute("data-theme", saved);

  btn.textContent = root.getAttribute("data-theme") === "dark" ? "☀️" : "🌙";

  btn.onclick = () => {
    const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    btn.textContent = next === "dark" ? "☀️" : "🌙";
  };
})();
