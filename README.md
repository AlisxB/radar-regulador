# Radar Regulatório — Análise de Normativos

Front-end estático (HTML/CSS/JS puro, sem build) que consome análises de normativos do setor elétrico via **webhook n8n** e oferece um **chat por documento** apoiado por um agente RAG.

Contexto: Desafio 2.3 · Casa dos Ventos / ProEnergia.

## Como rodar

Precisa de um servidor HTTP — abrir o `index.html` via `file://` **não funciona** (o `fetch` para o n8n exige origem HTTP e o CORS precisa de um `Origin`).

```bash
python3 -m http.server 8123
# abrir http://localhost:8123
```

Qualquer porta serve: o webhook n8n reflete a origem no `Access-Control-Allow-Origin`.

## Arquivos

| Arquivo | Papel |
|---|---|
| `index.html` | estrutura: topbar, KPIs, filtros, tabela, detalhe, timeline |
| `style.css` | tema escuro (variáveis CSS) |
| `script.js` | dados, normalização, render, filtros, chat |

## Configuração

No topo de `script.js`:

```js
const API_URL  = "https://n8n.desenrolaai.tech/webhook/9bbac907-...";  // análises (GET)
const CHAT_URL = "https://n8n.desenrolaai.tech/webhook/e5214df5-...";  // agente RAG (POST)
```

`REF_DATE` (data de referência dos countdowns) é fixa em `2026-09-24`.

## Contrato — análises (`API_URL`)

`GET` → array JSON:

```json
[{
  "id": 2,
  "document_id": "doc-portaria-01",
  "document_name": "Portaria MME SNTEP nº 3.234/2026",
  "orgao_emissor": "DOU",
  "classification": "Portaria MME",
  "grau_urgencia": "moderado",
  "is_relevant": true,
  "aplicavel_renovaveis": true,
  "relevance_score": "0.90",
  "summary": "…",
  "financial_impact": { "direction": "…", "magnitude": "…", "justification": "…" },
  "prazos_acao": [{ "has_deadline": true, "deadline_date": "2026-10-22", "action_required": "…" }],
  "traceability": [{ "exact_quote": "…", "article_or_section": "Art. 2º" }]
}]
```

O front tolera campos ausentes (defaults seguros), normaliza `grau_urgencia` para `{baixa, moderada, alta, crítica}`, deduplica por `document_id|deadline` e **escapa todo campo** antes de renderizar.

## Contrato — chat (`CHAT_URL`)

`POST`:

```json
{ "chatInput": "Qual o prazo para contribuições?", "sessionId": "…", "document_id": "doc-portaria-01" }
```

→ `200`:

```json
{ "output": "O prazo é de até 30 dias … (Art. 2º)" }
```

O `document_id` é obrigatório: escopa o retrieval do agente ao documento aberto. `sessionId` mantém a memória da conversa (uma thread por documento no front).

## Funcionalidades

- KPIs derivados dos dados (total, relevância alta, prazos ≤30d, cobertura rastreável).
- Filtros por órgão, urgência, só renováveis, busca textual (debounce) e ordenação (prazo/relevância/urgência).
- Estado na URL (`?q=&orgao=&urg=&renov=&sort=&id=`) — link e refresh preservam.
- Timeline dos próximos 60 dias.
- Chat colapsável por documento no painel de detalhe.
- Estados de loading/erro, timeout + abort no fetch, linhas navegáveis por teclado.

## Testes

```bash
node --test tests/                 # unitários (offline)
RADAR_LIVE=1 node --test tests/    # + smoke test contra o webhook real
```

Cobrem normalização/dedupe, defaults, escaping de HTML e parsing do estado da URL.

## Segurança / pendências

- ⚠️ Os dois webhooks são **públicos e sem auth**; o CORS reflete qualquer origem. Qualquer um lê os normativos e consome o LLM (custo). Para produção: endpoint read-only + auth, CORS restrito.
- `REF_DATE` hardcoded.
- Deduplicação e normalização de `grau_urgencia` são feitas no front — o ideal é corrigir na origem (workflow n8n).
