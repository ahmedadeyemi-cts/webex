(async function () {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();

    const container = document.getElementById("system-health");
    container.innerHTML = "";

    data.components.forEach(c => {
      const div = document.createElement("div");
      div.textContent = `${c.name}: ${c.status}`;
      container.appendChild(div);
    });
  } catch (err) {
    document.getElementById("status-loading").textContent =
      "Unable to load platform status";
  }
})();
