const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");

function load() {
  const noop = () => {};
  const store = {};
  const el = (id) => (store[id] ||= { id, innerHTML: "", textContent: "", value: "", disabled: false, style: {}, addEventListener: noop, appendChild: noop, focus: noop });
  const ctx = {
    console, fetch, URL, URLSearchParams, setTimeout, clearTimeout, AbortController, Promise, crypto,
    location: { search: "", pathname: "/index.html" },
    history: { replaceState: noop },
    document: {
      getElementById: el,
      createElement: () => ({ classList: {}, style: {}, innerHTML: "", onclick: null, onkeydown: null, tabIndex: 0, setAttribute: noop }),
      addEventListener: noop,
    },
    window: { addEventListener: noop, scrollTo: noop },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  return { ctx, store, run: (code) => vm.runInContext(code, ctx) };
}

const RAW = [
  {
    id: 2, document_id: "doc-portaria-01", document_name: "Portaria MME SNTEP nº 3.234/2026",
    orgao_emissor: "DOU", classification: "Portaria MME", grau_urgencia: "moderado",
    is_relevant: true, aplicavel_renovaveis: true, relevance_score: "0.90",
    summary: "<img src=x onerror=alert(1)> resumo",
    financial_impact: { direction: "Incerteza/Indeterminado", magnitude: "Nulo", justification: "sem impacto" },
    prazos_acao: [{ has_deadline: true, deadline_date: "2026-10-22", action_required: "contribuir" }],
    traceability: [{ exact_quote: "Fica divulgada…", article_or_section: "Art. 1º" }],
  },
  {
    id: 1, document_id: "doc-portaria-01", document_name: "Portaria MME SNTEP nº 3.234/2026",
    orgao_emissor: "DOU", classification: "Portaria MME", grau_urgencia: "moderado",
    is_relevant: true, aplicavel_renovaveis: true, relevance_score: "0.90",
    summary: "duplicata",
    prazos_acao: [{ has_deadline: true, deadline_date: "2026-10-22", action_required: "contribuir" }],
  },
];

test("buildDocs deduplica por document_id|deadline", () => {
  const { run } = load();
  const docs = run("buildDocs")(RAW);
  assert.equal(docs.length, 1);
});

test("buildDocs normaliza grau_urgencia e flags", () => {
  const { run } = load();
  const [d] = run("buildDocs")(RAW);
  assert.equal(d.grau_urgencia, "moderada");
  assert.equal(d.is_relevant, true);
  assert.equal(d.aplicavel_renovaveis, true);
  assert.equal(d.relevance_score, "0.90");
});

test("buildDocs aplica defaults em campos ausentes", () => {
  const { run } = load();
  const [d] = run("buildDocs")([{ document_name: "x" }]);
  assert.equal(d.financial_impact, null);
  assert.equal(d.prazos_acao.length, 0);
  assert.equal(d.traceability.length, 0);
  assert.equal(d.is_relevant, null);
  assert.equal(d.grau_urgencia, "baixa");
});

test("esc neutraliza HTML", () => {
  const { run } = load();
  const out = run("esc")('<img src=x onerror=alert(1)>"\'&');
  assert.ok(!out.includes("<"), "não deve conter '<' cru");
  assert.ok(out.includes("&lt;"));
  assert.ok(out.includes("&amp;"));
});

test("renderDetail escapa conteúdo não-confiável", () => {
  const { run, store } = load();
  run("DOCS = " + JSON.stringify(run("buildDocs")(RAW)) + "; state.selectedId = DOCS[0].id;");
  run("renderDetail()");
  assert.ok(!/<img/i.test(store.detailBody.innerHTML), "summary malicioso deve estar escapado");
});

test("readUrl/syncControls leem o estado da query string", () => {
  const { ctx, run } = load();
  ctx.location.search = "?orgao=DOU&sort=relevancia&renov=1&id=2";
  run("readUrl(); syncControls();");
  const s = run("JSON.stringify({ orgao: state.orgao, sort: state.sort, renov: state.onlyRenov, id: state.selectedId })");
  assert.equal(s, '{"orgao":"DOU","sort":"relevancia","renov":true,"id":"2"}');
});

test("filtered aplica filtro de órgão e renováveis", () => {
  const { ctx, run } = load();
  ctx.location.search = "?orgao=DOU&renov=1";
  run("readUrl(); DOCS = " + JSON.stringify(run("buildDocs")(RAW)) + ";");
  assert.equal(run("filtered().length"), 1);
  ctx.location.search = "?orgao=ANEEL";
  run("readUrl();");
  assert.equal(run("filtered().length"), 0);
});

test("live: webhook de análises devolve array (RADAR_LIVE=1)", { skip: !process.env.RADAR_LIVE }, async () => {
  const { run } = load();
  const res = await fetch(run("API_URL"), { headers: { Accept: "application/json" } });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});
