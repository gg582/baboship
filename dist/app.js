const statusEl = document.getElementById("status");
const buildInfoEl = document.getElementById("build-info");

const now = new Date();
const fmt = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZoneName: "shortGeneric",
});

if (statusEl) {
  statusEl.textContent = "Nothing to see here yet — replace this placeholder with your build output.";
}

if (buildInfoEl) {
  buildInfoEl.textContent = `last updated ${fmt.format(now)}`;
}
