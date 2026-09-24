
const API_URL = "./hackaton/output.json";
const CHAT_URL = "https://n8n.desenrolaai.tech/webhook/e5214df5-78fc-4f1d-ad8e-60543b0605e1";
const REF_DATE = new Date("2026-09-24T12:00:00Z");
const REF_DAY = new Date("2026-09-24T00:00:00Z");
const URGENCIAS = ["baixa", "moderada", "alta", "crítica"];
const URG_ORDER = { "crítica": 0, "alta": 1, "moderada": 2, "baixa": 3 };
const FETCH_TIMEOUT_MS = 30000;
const CHAT_TIMEOUT_MS = 60000;

let DOCS = [];
let inflight = null;
let lastUpdated = null;
let state = { q: "", orgao: "Todos", urgencia: "Todas", onlyRenov: false, sort: "prazo", selectedId: null };

function str(v){ return v == null ? "" : String(v); }
function esc(v){ return str(v).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function debounce(fn, ms){ let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function urgencyClass(u){ return str(u).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase(); }
function canonUrg(u){
  const n = urgencyClass(u);
  if(n.startsWith("critic")) return "crítica";
  if(n.startsWith("moderad")) return "moderada";
  if(n.startsWith("alt")) return "alta";
  if(n.startsWith("baix")) return "baixa";
  return URGENCIAS.includes(n) ? n : "baixa";
}
function isDate(s){ return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function diffDays(dateStr){
  if(!isDate(dateStr)) return null;
  return Math.round((new Date(dateStr + "T00:00:00Z") - REF_DAY) / 86400000);
}
function fmtImpact(dir){
  const d = urgencyClass(dir);
  if(d.startsWith("up") || d.startsWith("positiv") || d.startsWith("alta")) return "↗";
  if(d.startsWith("down") || d.startsWith("negativ") || d.startsWith("queda")) return "↘";
  return "→";
}
function fmtDeadline(dateStr){
  const days = diffDays(dateStr);
  if(days === null) return "—";
  return `${dateStr} · ${days >= 0 ? `D-${days}` : `D+${Math.abs(days)}`}`;
}
function flagVal(v){ return v === true ? "TRUE" : v === false ? "FALSE" : "—"; }
function flagColor(v){ return v === true ? "var(--ok)" : "var(--muted)"; }

function normPrazo(p){
  p = p || {};
  return {
    has_deadline: p.has_deadline === true,
    deadline_date: isDate(p.deadline_date) ? p.deadline_date : null,
    action_required: str(p.action_required) || "—"
  };
}
function normImpact(f){
  if(!f || typeof f !== "object") return null;
  return {
    direction: str(f.direction) || "—",
    magnitude: str(f.magnitude) || "—",
    justification: str(f.justification)
  };
}
function normTrace(t){
  if(!Array.isArray(t)) return [];
  return t
    .map(x => ({ exact_quote: str(x && x.exact_quote), article_or_section: str(x && x.article_or_section) }))
    .filter(x => x.exact_quote);
}
function normArr(v, fn){ return Array.isArray(v) ? v.map(fn).filter(Boolean) : []; }
function normCitation(c){ c = c || {}; const title = str(c.title); const url = str(c.url); if(!title && !url) return null; return { title: title || url, url, cited_text: str(c.cited_text) }; }
function normSources(obj){
  if(!obj || typeof obj !== "object" || Array.isArray(obj)) return [];
  return Object.entries(obj)
    .map(([title, url]) => ({ title: str(title), url: str(url), cited_text: "" }))
    .filter(c => c.url || c.title);
}
function normEntity(e){ e = e || {}; const name = str(e.name); return name ? { name, type: str(e.type) || "outro", role: str(e.role) } : null; }
function normLaw(l){ l = l || {}; const ref = str(l.ref); return ref ? { ref, description: str(l.description) } : null; }
function normIndicator(i){ i = i || {}; const indicator = str(i.indicator); if(!indicator) return null; const v = typeof i.value === "number" ? i.value : (i.value != null && i.value !== "" ? Number(i.value) : null); return { indicator, value: Number.isFinite(v) ? v : null, unit: str(i.unit), period: str(i.period), source: str(i.source) }; }
function normImpactLink(x){ x = x || {}; const agent = str(x.agent); return agent ? { agent, effect: str(x.effect), direction: str(x.direction) || "Neutro" } : null; }
function safeUrl(u){ const s = str(u); return /^https?:\/\//i.test(s) ? s : ""; }
function normDoc(raw, i){
  raw = raw || {};
  const name = str(raw.document_name);
  const slug = urgencyClass(name).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const documentId = str(raw.document_id);
  return {
    id: raw.id != null ? String(raw.id) : (documentId || `doc-${i}-${slug || "x"}`),
    document_id: documentId || "—",
    document_name: name || "(sem nome)",
    orgao_emissor: str(raw.orgao_emissor) || "—",
    classification: str(raw.classification) || "—",
    grau_urgencia: canonUrg(raw.grau_urgencia),
    relevance_score: str(raw.relevance_score),
    is_relevant: typeof raw.is_relevant === "boolean" ? raw.is_relevant : null,
    aplicavel_renovaveis: typeof raw.aplicavel_renovaveis === "boolean" ? raw.aplicavel_renovaveis : null,
    summary: str(raw.summary),
    prazos_acao: Array.isArray(raw.prazos_acao) ? raw.prazos_acao.map(normPrazo) : [],
    financial_impact: normImpact(raw.financial_impact),
    traceability: normTrace(raw.traceability),
    citations: (Array.isArray(raw.citations) && raw.citations.length) ? normArr(raw.citations, normCitation) : normSources(raw.sources),
    entities: normArr(raw.entities, normEntity),
    laws: normArr(raw.laws, normLaw),
    market_context: normArr(raw.market_context, normIndicator),
    impact_chain: normArr(raw.impact_chain, normImpactLink),
    source_file: str(raw.source_file),
    published_at: isDate(raw.published_at) ? raw.published_at : null,
    ingested_at: str(raw.ingested_at)
  };
}
function buildDocs(raw){
  const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.docs) ? raw.docs : []);
  const seen = new Set();
  const out = [];
  arr.forEach((r, i) => {
    const d = normDoc(r, i);
    const key = (d.document_id !== "—" ? d.document_id : d.document_name) + "|" + (d.prazos_acao[0]?.deadline_date || "");
    if(seen.has(key)) return;
    seen.add(key);
    out.push(d);
  });
  return out;
}

function readUrl(){
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") || "";
  state.orgao = p.get("orgao") || "Todos";
  state.urgencia = p.get("urg") || "Todas";
  state.onlyRenov = p.get("renov") === "1";
  state.sort = p.get("sort") || "prazo";
  state.selectedId = p.get("id") || null;
}
function writeUrl(){
  const p = new URLSearchParams();
  if(state.q) p.set("q", state.q);
  if(state.orgao !== "Todos") p.set("orgao", state.orgao);
  if(state.urgencia !== "Todas") p.set("urg", state.urgencia);
  if(state.onlyRenov) p.set("renov", "1");
  if(state.sort !== "prazo") p.set("sort", state.sort);
  if(state.selectedId) p.set("id", state.selectedId);
  const qs = p.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}
function syncControls(){
  document.getElementById("q").value = state.q;
  document.getElementById("orgao").value = state.orgao;
  document.getElementById("urg").value = state.urgencia;
  document.getElementById("renov").checked = state.onlyRenov;
  document.getElementById("sort").value = state.sort;
}

function setStatus(kind, msg){
  const tb = document.getElementById("tableBody");
  const db = document.getElementById("detailBody");
  const meta = document.getElementById("countMeta");
  if(kind === "loading"){
    tb.innerHTML = `<div class="mono" style="padding:20px;color:var(--muted-2);font-size:12px">carregando…</div>`;
    db.innerHTML = `<div class="mono" style="padding:16px;color:var(--muted-2);font-size:12px">aguardando dados…</div>`;
    meta.textContent = "carregando…";
  } else if(kind === "error"){
    tb.innerHTML = `<div class="mono" style="padding:20px;color:var(--red);font-size:12px">erro ao carregar webhook: ${esc(msg)}</div>`;
    db.innerHTML = `<div class="mono" style="padding:16px;color:var(--red);font-size:12px">falha ao carregar a fonte de dados. verifique o caminho/endpoint e o CORS.</div>`;
    meta.textContent = "erro";
  }
}

async function loadDocs(){
  if(inflight) inflight.abort();
  const ctrl = new AbortController();
  inflight = ctrl;
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  setStatus("loading");
  try {
    const res = await fetch(API_URL, { method: "GET", headers: { "Accept": "application/json" }, signal: ctrl.signal });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    DOCS = buildDocs(data);
    if(!DOCS.length) throw new Error("payload vazio");
    if(!DOCS.some(d => d.id === state.selectedId)) state.selectedId = DOCS[0].id;
    lastUpdated = new Date();
    renderAll();
    renderUpdated();
  } catch(err){
    if(err.name === "AbortError" && inflight !== ctrl) return;
    DOCS = [];
    setStatus("error", err.name === "AbortError" ? `timeout após ${FETCH_TIMEOUT_MS / 1000}s` : err.message);
    renderUpdated();
  } finally {
    clearTimeout(timer);
    if(inflight === ctrl) inflight = null;
  }
}

function renderUpdated(){
  const el = document.getElementById("updatedMeta");
  if(!el) return;
  el.textContent = lastUpdated ? `atualizado ${lastUpdated.toLocaleTimeString("pt-BR")}` : "sem dados";
}

function filtered(){
  return DOCS.filter(d => {
    if(state.orgao !== "Todos" && d.orgao_emissor !== state.orgao) return false;
    if(state.urgencia !== "Todas" && d.grau_urgencia !== state.urgencia) return false;
    if(state.onlyRenov && d.aplicavel_renovaveis !== true) return false;
    if(state.q){
      const q = state.q.toLowerCase();
      const hay = (d.document_name + " " + d.summary + " " + d.classification + " " + d.orgao_emissor + " " + d.prazos_acao.map(p => p.action_required).join(" ") + " " + d.traceability.map(t => t.exact_quote).join(" ")).toLowerCase();
      if(!hay.includes(q)) return false;
    }
    return true;
  }).sort((a, b) => {
    if(state.sort === "relevancia") return (parseFloat(b.relevance_score) || 0) - (parseFloat(a.relevance_score) || 0);
    if(state.sort === "urgencia") return (URG_ORDER[a.grau_urgencia] ?? 9) - (URG_ORDER[b.grau_urgencia] ?? 9);
    const da = a.prazos_acao[0]?.deadline_date ? new Date(a.prazos_acao[0].deadline_date) : new Date("2099-01-01");
    const db = b.prazos_acao[0]?.deadline_date ? new Date(b.prazos_acao[0].deadline_date) : new Date("2099-01-01");
    return da - db;
  });
}

function renderKpis(){
  const total = DOCS.length;
  const relev = DOCS.filter(d => d.is_relevant === true).length;
  const ativos = DOCS.filter(d => { const n = diffDays(d.prazos_acao[0]?.deadline_date); return n !== null && n >= 0 && n <= 30; }).length;
  const criticas = DOCS.filter(d => d.grau_urgencia === "crítica").length;
  const traced = DOCS.filter(d => d.traceability.length > 0 || d.citations.length > 0).length;
  const orgaos = [...new Set(DOCS.map(d => d.orgao_emissor).filter(o => o && o !== "—"))].join(", ");
  document.getElementById("kpiTotal").textContent = `${total} docs`;
    document.getElementById("kpiTotalSub").textContent = (orgaos || "—") + " · fonte de dados";
  document.getElementById("kpiRelev").textContent = `${relev} / ${total}`;
  document.getElementById("kpiPrazos").textContent = `${ativos} com deadline ≤30d`;
  document.getElementById("kpiPrazosSub").textContent = `${criticas} críticas · risco perda prazo`;
  document.getElementById("kpiTrace").textContent = `${traced} / ${total}`;
}

function renderTable(){
  const list = filtered();
  const root = document.getElementById("tableBody");
  root.innerHTML = "";
  if(!list.length){
    root.innerHTML = `<div class="mono" style="padding:20px;color:var(--muted-2);font-size:12px">nenhum documento com os filtros atuais</div>`;
  }
  list.forEach(d => {
    const div = document.createElement("div");
    div.className = "row" + (d.id === state.selectedId ? " active" : "");
    div.setAttribute("role", "button");
    div.tabIndex = 0;
    div.setAttribute("aria-label", d.document_name);
    const first = d.prazos_acao[0];
    const deadlineTxt = first?.deadline_date ? fmtDeadline(first.deadline_date) : "—";
    const impact = d.financial_impact ? `${fmtImpact(d.financial_impact.direction)} ${esc(d.financial_impact.magnitude)}` : "—";
    div.innerHTML = `
      <div class="cell-doc mono">${esc(d.document_name)}</div>
      <div class="cell-meta mono">${esc(d.orgao_emissor)}</div>
      <div class="cell-meta mono" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.classification)}</div>
      <div><span class="badge ${urgencyClass(d.grau_urgencia)} mono">${esc(d.grau_urgencia)}</span></div>
      <div class="cell-meta mono">${esc(deadlineTxt)}</div>
      <div class="cell-meta mono impact">${impact}</div>
    `;
    div.onclick = () => { state.selectedId = d.id; renderAll(); };
    div.onkeydown = e => { if(e.key === "Enter" || e.key === " "){ e.preventDefault(); state.selectedId = d.id; renderAll(); } };
    root.appendChild(div);
  });
  document.getElementById("countMeta").textContent = `${list.length} docs`;
  writeUrl();
}

function renderDetail(){
  const root = document.getElementById("detailBody");
  const d = DOCS.find(x => x.id === state.selectedId) || DOCS[0];
  if(!d){
    root.innerHTML = `<div class="mono" style="padding:16px;color:var(--muted-2);font-size:12px">sem documentos</div>`;
    return;
  }
  const prazos = d.prazos_acao.length ? d.prazos_acao : [{ has_deadline: false, deadline_date: null, action_required: "sem prazo mapeado" }];
  root.innerHTML = `
    <div class="mono" style="font-size:10px;letter-spacing:.12em;color:var(--muted-2)">${esc(d.orgao_emissor)} · ${esc(d.classification)} · ${esc(d.document_id)}${d.published_at ? " · " + esc(d.published_at) : ""}</div>
    <div style="font-size:16px;font-weight:600;line-height:1.3">${esc(d.document_name)}</div>
    <div class="summary">${esc(d.summary)}</div>

    <div class="block">
      <div class="block-label">prazos_acao · countdown ref ${REF_DATE.toISOString().slice(0, 10)}</div>
      ${prazos.map(p => `
        <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:10px">
          <div style="display:flex;gap:8px;align-items:center">
            <span class="badge ${p.has_deadline ? "critica" : "baixa"} mono">${p.has_deadline ? "HAS_DEADLINE" : "SEM PRAZO"}</span>
            ${p.deadline_date ? `<span class="mono" style="font-size:11px">${esc(fmtDeadline(p.deadline_date))}</span>` : ""}
          </div>
          <div class="mono" style="font-size:12px;color:var(--text);line-height:1.5">${esc(p.action_required)}</div>
        </div>
      `).join("")}
    </div>

    <div class="block">
      <div class="block-label">financial_impact</div>
      ${d.financial_impact ? `
        <div style="display:flex;flex-direction:column;gap:10px">
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <span class="mono" style="font-size:11px;border:1px solid var(--border-2);border-radius:6px;padding:4px 8px;background:var(--surface);color:var(--text)">${esc(d.financial_impact.direction)}</span>
            <span class="mono" style="font-size:11px;border:1px solid var(--border-2);border-radius:6px;padding:4px 8px;background:var(--surface);color:var(--text)">${esc(d.financial_impact.magnitude)}</span>
          </div>
          ${d.financial_impact.justification ? `<div class="mono" style="font-size:12px;color:var(--text);line-height:1.5">${esc(d.financial_impact.justification)}</div>` : ""}
        </div>
      ` : `<div class="mono" style="font-size:12px;color:var(--muted-2);border:1px dashed var(--border);border-radius:10px;padding:12px">sem impacto financeiro mapeado</div>`}
    </div>

    ${d.market_context.length ? `
      <div class="block">
        <div class="block-label">contexto de mercado</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${d.market_context.map(m => `
            <div style="display:flex;justify-content:space-between;gap:8px">
              <span class="mono" style="font-size:11px;color:var(--muted)">${esc(m.indicator)}${m.period ? " · " + esc(m.period) : ""}</span>
              <span class="mono" style="font-size:11px;color:var(--text)">${m.value == null ? "—" : esc(m.value)} ${esc(m.unit)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    ` : ""}

    ${d.traceability.length ? `
      <div class="block">
        <div class="block-label">traceability · citação literal (${d.traceability.length})</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${d.traceability.map(t => `
            <div class="trace" style="padding:8px 12px">
              <div class="mono" style="font-size:9px;color:var(--muted-2);margin-bottom:4px">${esc(t.article_or_section || "—")}</div>
              <div class="mono" style="font-size:11px;line-height:1.6;color:var(--text)">“${esc(t.exact_quote)}”</div>
            </div>
          `).join("")}
        </div>
      </div>
    ` : ""}

    ${d.citations.length ? `
      <div class="block">
        <div class="block-label">fontes externas · web (${d.citations.length})</div>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${d.citations.map(c => `
            <div class="trace" style="padding:8px 12px">
              ${safeUrl(c.url) ? `<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener noreferrer" class="mono" style="font-size:11px;color:var(--ok);text-decoration:none">${esc(c.title)}</a>` : `<div class="mono" style="font-size:11px;color:var(--ok)">${esc(c.title)}</div>`}
              ${c.cited_text ? `<div class="mono" style="font-size:10px;line-height:1.5;color:var(--muted);margin-top:4px">“${esc(c.cited_text)}”</div>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    ` : ""}

    ${(d.entities.length || d.laws.length) ? `
      <div class="block">
        <div class="block-label">entidades e leis</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${d.entities.map(e => `<span class="mono" style="font-size:11px;border:1px solid var(--border);border-radius:6px;padding:4px 8px;background:var(--chip)">${esc(e.name)}${e.type ? " · " + esc(e.type) : ""}</span>`).join("")}
          ${d.laws.map(l => `<span class="mono" style="font-size:11px;border:1px solid var(--border-2);border-radius:6px;padding:4px 8px;background:var(--chip);color:var(--amber)">${esc(l.ref)}</span>`).join("")}
        </div>
      </div>
    ` : ""}

    ${d.impact_chain.length ? `
      <div class="block">
        <div class="block-label">cadeia de impacto</div>
        <div style="display:flex;flex-direction:column;gap:6px">
          ${d.impact_chain.map(x => `
            <div style="display:flex;gap:8px;align-items:baseline">
              <span class="mono" style="font-size:11px;color:${urgencyClass(x.direction).startsWith("negativ") ? "var(--red)" : urgencyClass(x.direction).startsWith("positiv") ? "var(--ok)" : "var(--muted)"}">${esc(fmtImpact(x.direction))}</span>
              <span class="mono" style="font-size:11px;color:var(--text)">${esc(x.agent)}</span>
              <span class="mono" style="font-size:10px;color:var(--muted)">${esc(x.effect)}</span>
            </div>
          `).join("")}
        </div>
      </div>
    ` : ""}

    <div class="grid2">
      <div class="mini"><div class="mono" style="font-size:10px;color:var(--muted-2)">IS_RELEVANT</div><div class="mono" style="font-size:12px;margin-top:6px;color:${flagColor(d.is_relevant)}">${flagVal(d.is_relevant)}</div></div>
      <div class="mini"><div class="mono" style="font-size:10px;color:var(--muted-2)">APLICAVEL_RENOVAVEIS</div><div class="mono" style="font-size:12px;margin-top:6px;color:${flagColor(d.aplicavel_renovaveis)}">${flagVal(d.aplicavel_renovaveis)}</div></div>
      <div class="mini"><div class="mono" style="font-size:10px;color:var(--muted-2)">RELEVANCE_SCORE</div><div class="mono" style="font-size:11px;margin-top:6px">${esc(d.relevance_score) || "—"}</div></div>
      <div class="mini"><div class="mono" style="font-size:10px;color:var(--muted-2)">DOCUMENT_ID</div><div class="mono" style="font-size:11px;margin-top:6px">${esc(d.document_id)}</div></div>
    </div>

    <div class="block">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
        <div class="block-label" style="margin-bottom:0">agente RAG · sobre este documento</div>
        <button id="chatToggle" class="btn mono" style="height:28px">conversar ▾</button>
      </div>
      <div id="chatPanel" style="display:none;margin-top:10px">
        <div id="chatLog" style="display:flex;flex-direction:column;gap:8px;max-height:280px;overflow:auto;margin-bottom:8px"></div>
        <div id="chatError" class="mono" style="font-size:11px;color:var(--red);min-height:14px"></div>
        <div style="display:flex;gap:8px;margin-top:8px;align-items:flex-end">
          <textarea id="chatInput" class="mono" rows="2" placeholder="pergunte sobre este documento…" style="flex:1;resize:vertical;background:var(--surface);color:var(--text);border:1px solid var(--border-2);border-radius:10px;padding:8px 10px;font-size:12px;outline:none"></textarea>
          <button id="chatSend" class="btn mono" style="height:38px">enviar</button>
        </div>
      </div>
    </div>

    <div>
      <button class="btn mono" onclick="toggleRaw()">VER JSON RAW · radar_regulatorio_analises</button>
      <pre id="rawPre" class="pre" style="display:none;margin-top:8px">${esc(JSON.stringify(d, null, 2))}</pre>
    </div>
  `;
  wireChat(d);
  renderChat(d);
}

const chats = new Map();
function chatFor(id){
  if(!chats.has(id)) chats.set(id, { sessionId: null, messages: [], loading: false, error: null, open: false });
  return chats.get(id);
}
function wireChat(d){
  const ta = document.getElementById("chatInput");
  const btn = document.getElementById("chatSend");
  const toggle = document.getElementById("chatToggle");
  if(toggle) toggle.onclick = () => { const c = chatFor(d.id); c.open = !c.open; renderChat(d); if(c.open && ta) ta.focus(); };
  if(btn) btn.onclick = () => sendChat(d);
  if(ta) ta.onkeydown = e => { if(e.key === "Enter" && !e.shiftKey){ e.preventDefault(); sendChat(d); } };
}
function renderChat(d){
  const log = document.getElementById("chatLog");
  if(!log) return;
  const c = chatFor(d.id);
  const bubble = (role, content) => `
    <div style="display:flex;flex-direction:column;gap:2px;align-items:${role === "user" ? "flex-end" : "flex-start"}">
      <div class="mono" style="font-size:9px;color:var(--muted-2)">${role === "user" ? "você" : "agente"}</div>
      <div style="max-width:90%;white-space:pre-wrap;font-size:12px;line-height:1.5;padding:8px 10px;border-radius:10px;border:1px solid var(--border);background:${role === "user" ? "var(--chip)" : "var(--chip)"};color:var(--text)">${esc(content)}</div>
    </div>`;
  log.innerHTML = c.messages.map(m => bubble(m.role, m.content)).join("") + (c.loading ? bubble("assistant", "…pensando") : "");
  const panel = document.getElementById("chatPanel");
  const toggle = document.getElementById("chatToggle");
  if(panel) panel.style.display = c.open ? "block" : "none";
  if(toggle) toggle.textContent = c.open ? "conversar ▴" : "conversar ▾";
  const errEl = document.getElementById("chatError");
  if(errEl) errEl.textContent = c.error ? `erro: ${c.error}` : "";
  const send = document.getElementById("chatSend");
  const ta = document.getElementById("chatInput");
  if(send) send.disabled = c.loading;
  if(ta) ta.disabled = c.loading;
  log.scrollTop = log.scrollHeight;
}
async function sendChat(d){
  const c = chatFor(d.id);
  const ta = document.getElementById("chatInput");
  const text = ta ? str(ta.value).trim() : "";
  if(!text || c.loading) return;
  if(!c.sessionId) c.sessionId = (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : `s-${Date.now()}`;
  c.messages.push({ role: "user", content: text });
  c.error = null;
  c.loading = true;
  if(ta) ta.value = "";
  renderChat(d);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ chatInput: text, sessionId: c.sessionId, document_id: d.document_id }),
      signal: ctrl.signal
    });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const out = str(data.output || data.text || data.answer);
    if(!out) throw new Error("resposta vazia");
    c.messages.push({ role: "assistant", content: out });
  } catch(err){
    c.error = err.name === "AbortError" ? `timeout após ${CHAT_TIMEOUT_MS / 1000}s` : err.message;
  } finally {
    clearTimeout(timer);
    c.loading = false;
    renderChat(d);
  }
}

function toggleRaw(){
  const el = document.getElementById("rawPre");
  el.style.display = el.style.display === "none" ? "block" : "none";
}

function renderTimeline(){
  const list = DOCS.filter(d => { const n = diffDays(d.prazos_acao[0]?.deadline_date); return n !== null && n >= 0 && n <= 60; }).sort((a, b) => new Date(a.prazos_acao[0].deadline_date) - new Date(b.prazos_acao[0].deadline_date)).slice(0, 8);
  const root = document.getElementById("timelineDots");
  root.innerHTML = "";
  list.forEach(d => {
    const days = diffDays(d.prazos_acao[0].deadline_date);
    const color = d.grau_urgencia === "crítica" ? "var(--red)" : d.grau_urgencia === "alta" ? "var(--orange)" : d.grau_urgencia === "moderada" ? "var(--amber)" : "var(--muted)";
    const tag = days === null ? "—" : days >= 0 ? `D-${days}` : `D+${Math.abs(days)}`;
    const div = document.createElement("div");
    div.className = "dot-item";
    div.setAttribute("role", "button");
    div.tabIndex = 0;
    div.setAttribute("aria-label", `${d.document_name} · ${tag}`);
    div.innerHTML = `<div class="dot-circle" style="background:${color}"></div><div class="mono" style="font-size:11px">${tag}</div><div class="mono" style="font-size:9px;color:var(--muted-2);max-width:12ch;text-align:center;line-height:1.2">${esc(d.document_name.split(" ").slice(0, 3).join(" "))}</div>`;
    div.onclick = () => { state.selectedId = d.id; renderAll(); window.scrollTo({ top: 0, behavior: "smooth" }); };
    div.onkeydown = e => { if(e.key === "Enter" || e.key === " "){ e.preventDefault(); state.selectedId = d.id; renderAll(); } };
    root.appendChild(div);
  });
}

function renderAll(){
  renderKpis();
  renderTable();
  renderDetail();
  renderTimeline();
}

function applyTheme(t){
  document.documentElement.setAttribute("data-theme", t);
  const btn = document.getElementById("themeToggle");
  if(btn) btn.textContent = t === "dark" ? "☀️" : "🌙";
}

window.addEventListener("DOMContentLoaded", () => {
  applyTheme(localStorage.getItem("theme") === "light" ? "light" : "dark");
  document.getElementById("themeToggle").addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    localStorage.setItem("theme", next);
    applyTheme(next);
  });
  readUrl();
  syncControls();
  const onSearch = debounce(v => { state.q = v; renderTable(); }, 200);
  document.getElementById("q").addEventListener("input", e => onSearch(e.target.value));
  document.getElementById("orgao").addEventListener("change", e => { state.orgao = e.target.value; renderAll(); });
  document.getElementById("urg").addEventListener("change", e => { state.urgencia = e.target.value; renderAll(); });
  document.getElementById("renov").addEventListener("change", e => { state.onlyRenov = e.target.checked; renderAll(); });
  document.getElementById("sort").addEventListener("change", e => { state.sort = e.target.value; renderAll(); });
  document.getElementById("refresh").addEventListener("click", loadDocs);
  loadDocs();
});
