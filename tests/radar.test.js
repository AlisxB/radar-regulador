const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "script.js"), "utf8");

function load() {
  const noop = () => {};
  const store = {};
  const el = (id) => (store[id] ||= { id, innerHTML: "", textContent: "", value: "", disabled: false, style: {}, children: [], addEventListener: noop, focus: noop, appendChild(c){ this.children.push(c); } });
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

test("fmtImpact mapeia direções do schema", () => {
  const { run } = load();
  assert.equal(run("fmtImpact")("Positivo"), "↗");
  assert.equal(run("fmtImpact")("Negativo"), "↘");
  assert.equal(run("fmtImpact")("Neutro"), "→");
  assert.equal(run("fmtImpact")("Incerteza/Indeterminado"), "→");
});

test("renderiza campos de pesquisa e sanitiza URL", () => {
  const { run, store } = load();
  const raw = [{
    document_name: "Doc", document_id: "d1", grau_urgencia: "alta",
    entities: [{ name: "<b>x</b>", type: "orgao" }],
    citations: [{ title: "evil", url: "javascript:alert(1)", cited_text: "q" }],
    market_context: [{ indicator: "PLD SE", value: 850, unit: "R$/MWh" }],
    impact_chain: [{ agent: "gerador", effect: "e", direction: "Negativo" }],
  }];
  run("DOCS = " + JSON.stringify(run("buildDocs")(raw)) + "; state.selectedId = DOCS[0].id;");
  run("renderDetail()");
  const html = store.detailBody.innerHTML;
  assert.ok(!/<b>x<\/b>/.test(html), "entidade deve estar escapada");
  assert.ok(!/href="javascript:/i.test(html), "url javascript: não pode virar href");
  assert.ok(html.includes("PLD SE"));
  assert.ok(html.includes("gerador"));
});

test("sources (dict) vira citations (array)", () => {
  const { run } = load();
  const [d] = run("buildDocs")([{ document_name: "D", document_id: "d1", sources: { "a.com": "https://a.com", "b.com": "https://b.com" } }]);
  assert.equal(d.citations.length, 2);
  assert.equal(d.citations[0].title, "a.com");
  assert.equal(d.citations[0].url, "https://a.com");
});

test("nextPrazoDate escolhe o proximo prazo", () => {
  const { run } = load();
  const [d] = run("buildDocs")([{ document_name: "D", document_id: "d1",
    prazos_acao: [{ deadline_date: "2028-01-01" }, { deadline_date: "2026-10-22" }, { deadline_date: "2026-09-30" }] }]);
  assert.equal(run("nextPrazoDate")(d), "2026-09-30");
});

test("timeline inclui todos os prazos na janela de 60d", () => {
  const { run, store } = load();
  const raw = [{ document_name: "Doc", document_id: "d1", grau_urgencia: "alta",
    prazos_acao: [{ deadline_date: "2026-09-30" }, { deadline_date: "2026-10-22" }, { deadline_date: "2028-01-01" }] }];
  run("DOCS = " + JSON.stringify(run("buildDocs")(raw)) + "; state.selectedId = DOCS[0].id;");
  run("renderTimeline()");
  assert.equal(store["timelineDots"].children.length, 2);
});

test("live: fonte primária devolve array (RADAR_LIVE=1)", { skip: !process.env.RADAR_LIVE }, async () => {
  const { run } = load();
  const url = run("API_URL");
  let data;
  if(/^https?:\/\//.test(url)){
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    assert.equal(res.status, 200);
    data = await res.json();
  } else {
    data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", url.replace(/^\.\//, "")), "utf8"));
  }
  assert.ok(Array.isArray(data));
});
