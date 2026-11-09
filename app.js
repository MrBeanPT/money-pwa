/* Money — phone capture PWA.
 * Entries are stored offline in IndexedDB and uploaded as `entry-<id>.json` to the Google Drive folder
 * MONEY_CONFIG.INBOX_FOLDER, where the PC app imports them. Lists (accounts, categories, payees) come
 * from `lookups.json`, published by the PC app into the same folder.
 */
"use strict";
const CFG = window.MONEY_CONFIG;
const $ = (s) => document.querySelector(s);
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const eur = (v) => (+v).toLocaleString("pt-PT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = (s) => parseFloat((s || "").replace(/\s/g, "").replace(",", "."));
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/* ---------------- IndexedDB ---------------- */
const idb = (() => {
  let dbp;
  const open = () => (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open("money", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("entries", { keyPath: "id" }); r.result.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode); const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out?.result ?? out); t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => tx("entries", "readonly", (s) => s.getAll()),
    put: (e) => tx("entries", "readwrite", (s) => s.put(e)),
    del: (id) => tx("entries", "readwrite", (s) => s.delete(id)),
    get: (k) => tx("kv", "readonly", (s) => s.get(k)),
    set: (k, v) => tx("kv", "readwrite", (s) => s.put(v, k)),
  };
})();

/* ---------------- state ---------------- */
let L = { accounts: [], categories: [], payees: [] };
let payeeCat = {};
let kind = "expense";
let editing = null;
let token = null; // {access_token, expires_at}
let tokenClient = null;
let syncing = false;

function msg(text, type = "ok") {
  const m = $("#msg"); m.textContent = text; m.className = "msg on " + type;
  if (type === "ok") setTimeout(() => (m.className = "msg"), 5000);
}

/* ---------------- lookups ---------------- */
async function applyLookups(l) {
  if (!l) return;
  L = l; payeeCat = {};
  L.payees.forEach((p) => (payeeCat[p.name] = p.category));
  $("#dlPayees").innerHTML = L.payees.map((p) => `<option value="${esc(p.name)}">`).join("");
  $("#dlCats").innerHTML = L.categories.map((c) => `<option value="${esc(c)}">`).join("");
  const keepA = $("#fAccount").value, keepT = $("#fTo").value;
  const opts = L.accounts.map((a) => `<option>${esc(a.name)}</option>`).join("");
  $("#fAccount").innerHTML = opts || "<option value=''>(sincroniza para obter as contas)</option>";
  $("#fTo").innerHTML = opts;
  const last = await idb.get("lastAccount");
  $("#fAccount").value = keepA || last || L.accounts[0]?.name || "";
  if (keepT) $("#fTo").value = keepT;
  $("#lookupInfo").textContent = L.generated
    ? `Listas de ${L.generated.replace("T", " ").slice(0, 16)} (${L.accounts.length} contas, ${L.payees.length} beneficiários)`
    : "Ainda sem listas — sincroniza.";
}

/* ---------------- form ---------------- */
document.querySelectorAll("#kind button").forEach((b) => (b.onclick = () => setKind(b.dataset.k)));
function setKind(k) {
  kind = k;
  document.querySelectorAll("#kind button").forEach((x) => x.classList.toggle("on", x.dataset.k === k));
  const t = k === "transfer", split = $("#isSplit").checked && !t;
  $("#lblTo").hidden = !t; $("#lblPayee").hidden = t; $("#lblSplit").hidden = t;
  $("#lblCat").hidden = t || split; $("#splitBox").hidden = !split;
}
$("#isSplit").onchange = () => { if ($("#isSplit").checked && !$("#splitLines").children.length) { addLine(); addLine(); } setKind(kind); };
function addLine(c = "", a = "") {
  const d = document.createElement("div"); d.className = "splitline";
  d.innerHTML = `<input list="dlCats" placeholder="Categoria" value="${esc(c)}"><input class="amt" inputmode="decimal" placeholder="0,00" value="${esc(a)}"><a>✕</a>`;
  d.querySelector("a").onclick = () => { d.remove(); sumLines(); };
  d.querySelector(".amt").oninput = sumLines;
  $("#splitLines").appendChild(d);
}
$("#addLine").onclick = () => addLine();
function sumLines() {
  const s = [...document.querySelectorAll(".splitline .amt")].reduce((t, i) => t + (num(i.value) || 0), 0);
  $("#splitSum").textContent = `soma ${eur(s)} de ${eur(num($("#fAmount").value) || 0)}`;
}
$("#fAmount").oninput = sumLines;
$("#fPayee").oninput = () => { const v = $("#fPayee").value.trim(); $("#newPayee").hidden = !v || v in payeeCat; };
$("#fPayee").onchange = () => {
  const c = payeeCat[$("#fPayee").value]; if (c && !$("#fCategory").value) $("#fCategory").value = c;
  $("#fPayee").oninput();
};

function resetForm() {
  editing = null;
  ["#fAmount", "#fPayee", "#fCategory", "#fMemo"].forEach((s) => ($(s).value = ""));
  $("#splitLines").innerHTML = ""; $("#isSplit").checked = false; $("#newPayee").hidden = true;
  $("#fDate").value = today(); $("#saveBtn").textContent = "Guardar"; setKind("expense");
}

function buildEntry() {
  const amt = num($("#fAmount").value);
  if (!(amt > 0)) throw new Error("Valor inválido");
  const account = $("#fAccount").value;
  if (!account) throw new Error("Escolhe a conta (sincroniza para obter as listas)");
  const sign = kind === "income" ? 1 : -1;
  const e = {
    id: editing || crypto.randomUUID(), account, date: $("#fDate").value || today(),
    amount: (sign * amt).toFixed(2), memo: $("#fMemo").value.trim() || null, source: "phone",
    created: new Date().toISOString().slice(0, 19), _status: "pending",
  };
  if (kind === "transfer") {
    if ($("#fTo").value === account) throw new Error("Escolhe uma conta de destino diferente");
    Object.assign(e, { kind: "transfer", to_account: $("#fTo").value, payee: null });
  } else if ($("#isSplit").checked) {
    const lines = [...document.querySelectorAll(".splitline")].map((d) => ({
      category: d.children[0].value.trim(), amount: (sign * num(d.children[1].value)).toFixed(2) }));
    if (lines.length < 2 || lines.some((l) => !l.category || isNaN(+l.amount))) throw new Error("Preenche as linhas do split");
    const total = lines.reduce((t, l) => t + Math.round(+l.amount * 100), 0);
    if (total !== Math.round(sign * amt * 100)) throw new Error("As linhas não somam o total");
    Object.assign(e, { kind: "split", payee: $("#fPayee").value.trim() || null, lines });
  } else {
    const cat = $("#fCategory").value.trim();
    if (!cat) throw new Error("Falta a categoria");
    Object.assign(e, { kind: "simple", payee: $("#fPayee").value.trim() || null, category: cat });
  }
  return e;
}

$("#saveBtn").onclick = async () => {
  try {
    const e = buildEntry();
    await idb.put(e); await idb.set("lastAccount", e.account);
    const keepDate = $("#fDate").value;
    resetForm(); $("#fDate").value = keepDate;
    msg(editing ? "Alterado" : "Guardado no telemóvel");
    await render(); trySync(false);
  } catch (x) { msg(x.message, "warn"); }
};

function startEdit(e) {
  editing = e.id; window.scrollTo({ top: 0, behavior: "smooth" });
  $("#fAccount").value = e.account; $("#fDate").value = e.date; $("#fMemo").value = e.memo || "";
  $("#fAmount").value = eur(Math.abs(e.amount)); $("#fPayee").value = e.payee || ""; $("#fCategory").value = e.category || "";
  $("#splitLines").innerHTML = ""; $("#isSplit").checked = e.kind === "split";
  if (e.kind === "split") e.lines.forEach((l) => addLine(l.category, eur(Math.abs(l.amount))));
  if (e.kind === "transfer") $("#fTo").value = e.to_account;
  setKind(e.kind === "transfer" ? "transfer" : +e.amount < 0 ? "expense" : "income");
  $("#saveBtn").textContent = "Guardar alterações"; sumLines();
}

/* ---------------- list ---------------- */
function describe(e) {
  if (e.kind === "transfer") return `${esc(e.account)} → ${esc(e.to_account)}`;
  const what = e.kind === "split" ? e.lines.map((l) => esc(l.category.split(" : ").pop())).join(" | ") : esc((e.category || "").split(" : ").pop());
  return `${esc(e.account)} · ${what}`;
}
async function render() {
  const all = (await idb.all()).sort((a, b) => (b.date + b.created).localeCompare(a.date + a.created));
  const pend = all.filter((e) => e._status === "pending").length;
  $("#counts").textContent = `${pend} por enviar · ${all.length - pend} enviados`;
  $("#syncLabel").textContent = pend ? `Enviar (${pend})` : "Sincronizar";
  $("#list").innerHTML = all.slice(0, 100).map((e) => `<li>
    <span class="t">${esc(e.payee || (e.kind === "transfer" ? "Transferência" : "—"))}</span>
    <span class="a ${+e.amount < 0 ? "neg" : "pos"}">${eur(e.amount)}</span>
    <span class="s">${e.date} · ${describe(e)}${e.memo ? " · " + esc(e.memo) : ""}</span>
    <span class="st"><span class="pill ${e._status === "pending" ? "pend" : "ok"}">${e._status === "pending" ? "por enviar" : "enviado"}</span></span>
    ${e._status === "pending" ? `<span class="acts"><a data-ed="${e.id}">editar</a><a data-del="${e.id}">apagar</a></span>` : ""}
  </li>`).join("") || `<li><span class="s">Sem registos.</span></li>`;
  document.querySelectorAll("[data-ed]").forEach((a) => (a.onclick = () => startEdit(all.find((e) => e.id === a.dataset.ed))));
  document.querySelectorAll("[data-del]").forEach((a) => (a.onclick = async () => {
    if (confirm("Apagar este registo?")) { await idb.del(a.dataset.del); render(); }
  }));
}
$("#clearBtn").onclick = async () => {
  const sent = (await idb.all()).filter((e) => e._status !== "pending");
  if (!sent.length || !confirm(`Remover ${sent.length} registos já enviados deste telemóvel?`)) return;
  for (const e of sent) await idb.del(e.id);
  render();
};

/* ---------------- Google auth ---------------- */
function tokenValid() { return token && token.expires_at > Date.now() + 60000; }
function initAuth() {
  if (!CFG.GOOGLE_CLIENT_ID) { $("#authInfo").textContent = "Falta configurar o Google Client ID (config.js)."; return; }
  if (!window.google?.accounts?.oauth2) { setTimeout(initAuth, 300); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CFG.GOOGLE_CLIENT_ID, scope: CFG.SCOPE,
    callback: async (r) => {
      if (r.error) { msg("Login Google falhou: " + r.error, "err"); return; }
      token = { access_token: r.access_token, expires_at: Date.now() + (r.expires_in - 30) * 1000 };
      try { sessionStorage.setItem("tok", JSON.stringify(token)); } catch {}
      await idb.set("consented", true); showAuth(); sync();
    },
  });
  showAuth();
}
async function showAuth() {
  const consented = await idb.get("consented");
  $("#authInfo").textContent = tokenValid() ? "Ligado ao Google Drive." : consented ? "Google Drive: toca em Sincronizar para ligar." : "Ainda não ligado ao Google Drive.";
  $("#signBtn").textContent = consented ? "Voltar a ligar" : "Ligar ao Google Drive";
}
async function requestToken() {
  if (!tokenClient) { msg("Google ainda a carregar ou Client ID em falta", "warn"); return; }
  tokenClient.requestAccessToken({ prompt: (await idb.get("consented")) ? "" : "consent" });
}
$("#signBtn").onclick = () => tokenClient?.requestAccessToken({ prompt: "consent" });

/* ---------------- Drive ---------------- */
async function gapi(url, opt = {}) {
  const r = await fetch(url, { ...opt, headers: { Authorization: "Bearer " + token.access_token, ...(opt.headers || {}) } });
  if (r.status === 401) { token = null; throw new Error("Sessão Google expirou — toca em Sincronizar"); }
  if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r;
}
const q = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
async function folderId() {
  const cached = await idb.get("folderId");
  if (cached) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${cached}?fields=id,trashed`, { headers: { Authorization: "Bearer " + token.access_token } });
    if (r.ok && !(await r.json()).trashed) return cached;
  }
  const query = `name='${q(CFG.INBOX_FOLDER)}' and mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false`;
  const r = await (await gapi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`)).json();
  let id = r.files[0]?.id;
  if (!id) {
    id = (await (await gapi("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: CFG.INBOX_FOLDER, mimeType: "application/vnd.google-apps.folder", parents: ["root"] }),
    })).json()).id;
  }
  await idb.set("folderId", id);
  return id;
}
async function upload(folder, e) {
  const { _status, _synced_at, ...payload } = e;
  const boundary = "mny" + Math.random().toString(36).slice(2);
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
    JSON.stringify({ name: `entry-${e.id}.json`, parents: [folder], mimeType: "application/json" }) +
    `\r\n--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` + JSON.stringify(payload) + `\r\n--${boundary}--`;
  await gapi("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body });
}
async function fetchLookups(folder) {
  const query = `name='lookups.json' and '${folder}' in parents and trashed=false`;
  const r = await (await gapi(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,modifiedTime)&orderBy=modifiedTime desc`)).json();
  if (!r.files.length) return false;
  const l = await (await gapi(`https://www.googleapis.com/drive/v3/files/${r.files[0].id}?alt=media`)).json();
  await idb.set("lookups", l); await applyLookups(l);
  return true;
}

async function sync() {
  if (syncing) return;
  if (!navigator.onLine) { msg("Sem rede — os registos ficam guardados no telemóvel", "warn"); return; }
  if (!tokenValid()) { await requestToken(); return; } // callback calls sync() again
  syncing = true; $("#syncBtn").disabled = true;
  try {
    const folder = await folderId();
    const pending = (await idb.all()).filter((e) => e._status === "pending");
    for (const e of pending) {
      await upload(folder, e);
      await idb.put({ ...e, _status: "synced", _synced_at: new Date().toISOString() });
    }
    const gotLookups = await fetchLookups(folder);
    msg(`Sincronizado: ${pending.length} enviado(s)` + (gotLookups ? ", listas atualizadas" : " · sem lookups.json — publica-as no PC"), gotLookups ? "ok" : "warn");
  } catch (x) { msg(x.message, "err"); }
  finally { syncing = false; $("#syncBtn").disabled = false; render(); showAuth(); }
}
function trySync() { if (navigator.onLine && tokenValid()) sync(); }
$("#syncBtn").onclick = () => sync();
window.addEventListener("online", () => trySync());

/* ---------------- boot ---------------- */
(async () => {
  try { const t = JSON.parse(sessionStorage.getItem("tok") || "null"); if (t) token = t; } catch {}
  resetForm();
  await applyLookups(await idb.get("lookups"));
  await render();
  initAuth();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
