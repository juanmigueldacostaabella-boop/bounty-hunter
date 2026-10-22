const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3050;
const SINGLE_TICK = process.argv.includes('--single-tick');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getDefaultState() {
  return {
    startedAt: new Date().toISOString(),
    lastScanAt: null,
    scanCount: 0,
    config: {
      githubToken: process.env.GITHUB_TOKEN || '',
      payoutAddress: process.env.PAYOUT_ADDRESS || '0xTuWalletAqui_O_TuPaypal',
      payoutType: process.env.PAYOUT_TYPE || 'USDC_EVM', // USDC_EVM, SOLANA, PAYPAL
      autoSubmitPR: false,
      minBountyUsd: 20
    },
    metrics: {
      totalBountiesDetected: 0,
      totalBountyPoolUsd: 0,
      solutionsGenerated: 0,
      potentialEarningsUsd: 0,
      prsSubmitted: 0
    },
    activeBounties: [], // list of detected bounties with details
    solutions: [],      // generated solutions / patches
    submittedClaims: [],
    logs: []
  };
}

let state = getDefaultState();
if (fs.existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    state = { ...getDefaultState(), ...saved, config: { ...getDefaultState().config, ...(saved.config || {}) } };
  } catch (err) {
    console.error('Error cargando estado, iniciando limpio:', err.message);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.error('Error guardando estado:', err.message);
  }
}

function addLog(level, msg) {
  const entry = {
    time: new Date().toISOString(),
    level,
    msg
  };
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs.length = 100;
  console.log(`[${entry.time}] [${level}] ${msg}`);
}

async function fetchJson(url, timeoutMs = 8000, options = {}) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  const token = process.env.GITHUB_TOKEN || state.config.githubToken;
  const defaultHeaders = {
    'User-Agent': 'Nexus-BountyHunter-24-7/1.0',
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json'
  };
  if (token) {
    defaultHeaders['Authorization'] = `token ${token}`;
  }
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { ...defaultHeaders, ...(options.headers || {}) }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } finally {
    clearTimeout(id);
  }
}

// Extrae el valor en dólares ($) de un título o cuerpo de issue
function extractBountyValue(text) {
  if (!text) return 50; // valor estimado base para bounties abiertos
  // Patrones: [Bounty: $90], $150, 100 USD, 500 USDC, 200 USDT
  const regexPatterns = [
    /\b(?:bounty|reward|prize)[\s:=-]*\$?\s*([0-9]{2,5})\b/i,
    /\$\s*([0-9]{2,5})\s*(?:usd|usdc|usdt)?/i,
    /([0-9]{2,5})\s*(?:usd|usdc|usdt|dollars)/i,
    /\[bounty:\s*\$?([0-9]{2,5})\]/i
  ];
  for (const pat of regexPatterns) {
    const match = text.match(pat);
    if (match && match[1]) {
      const val = parseInt(match[1], 10);
      if (val >= 10 && val <= 50000) return val;
    }
  }
  return 50; // Si tiene la etiqueta bounty pero no especifica monto, asignar estimación mínima
}

// Determinar dificultad y categoría
function categorizeBounty(title, body) {
  const fullText = (title + ' ' + (body || '')).toLowerCase();
  let category = 'Bug Fix / Código';
  let difficulty = 'Medio';

  if (fullText.includes('typo') || fullText.includes('readme') || fullText.includes('doc')) {
    category = 'Documentación / Typo';
    difficulty = 'Fácil';
  } else if (fullText.includes('test') || fullText.includes('validation') || fullText.includes('check')) {
    category = 'Validación / Tests';
    difficulty = 'Fácil';
  } else if (fullText.includes('security') || fullText.includes('vulnerability') || fullText.includes('reentrancy')) {
    category = 'Seguridad Web3';
    difficulty = 'Avanzado';
  } else if (fullText.includes('feature') || fullText.includes('implement')) {
    category = 'Nueva Función';
    difficulty = 'Medio';
  }
  return { category, difficulty };
}

// Generador Autónomo de Solución y Parche de Código con IA Real (Groq 120B)
async function generateAutomatedSolution(bounty) {
  const { title, bodyPreview, fullBody, repo, number, rewardUsd, htmlUrl } = bounty;
  const payout = state.config.payoutAddress || 'github.com/juanmigueldacostaabella-boop';
  const payoutType = state.config.payoutType || 'GITHUB_REWARD_ACCOUNT';
  const groqKey = process.env.GROQ_API_KEY || state.config.groqApiKey || '';

  let explanation = `Technical analysis and proposed resolution for ${repo} #${number}.`;
  let proposedCode = `// Review specific implementation in ${repo} #${number}`;

  if (groqKey) {
    try {
      const prompt = `You are a senior software engineer submitting a high-quality solution for a GitHub bounty issue.
Repository: ${repo}
Issue #${number}: ${title}
Description:
${(fullBody || bodyPreview || '').slice(0, 2200)}

Requirements:
1. Provide a concise, clear 2-sentence technical explanation in professional English explaining the root cause and the fix.
2. Provide the exact code patch, diff, or answer required to resolve the issue cleanly.
Respond strictly in JSON format: {"explanation": "...", "code": "..."}`;

      const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqKey}`
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-120b',
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
          max_tokens: 900
        })
      });
      if (aiRes.ok) {
        const aiData = await aiRes.json();
        const content = aiData.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          if (parsed.explanation) explanation = parsed.explanation;
          if (parsed.code) proposedCode = parsed.code;
        }
      }
    } catch (err) {
      addLog('WARN', `IA fallback en #${number}: ${err.message}`);
    }
  }

  const prTitle = `fix: resolve issue #${number} - ${title.slice(0, 50).replace(/[^\x00-\x7F]/g, "")}`;
  const prBody = `## Proposed Solution for Issue #${number}\n\n` +
    `### Root Cause Analysis & Fix\n${explanation}\n\n` +
    `### Proposed Code Patch\n\`\`\`\n${proposedCode}\n\`\`\`\n\n` +
    `---\n` +
    `*Bounty Reward:* **$${rewardUsd}**\n` +
    `*Beneficiary Account:* \`${payout}\` (${payoutType})\n` +
    `*Contributor:* @juanmigueldacostaabella-boop`;

  return {
    id: crypto.randomUUID(),
    bountyId: bounty.id,
    repo,
    issueNumber: number,
    issueUrl: htmlUrl,
    rewardUsd,
    prTitle,
    prBody,
    proposedCode,
    explanation,
    status: groqKey ? 'SOLUCIÓN_IA_REAL_LISTA' : 'SOLUCIÓN_LISTA',
    createdAt: new Date().toISOString()
  };
}

// Filtro de Seguridad Estricto: Ignora mineros, faucets, scripts sospechosos y promociones
function isSafeBounty(title, body, repo) {
  const full = (title + ' ' + (body || '') + ' ' + repo).toLowerCase();
  const blacklist = [
    'quickstart',
    'miner',
    'mining',
    'faucet',
    'run the 3-second',
    'run this script',
    'curl -s',
    'terminal quickstart',
    'doomsday',
    'airdrop claim',
    'join discord',
    'follow twitter',
    'retweet',
    'giveaway'
  ];
  for (const term of blacklist) {
    if (full.includes(term)) return false;
  }
  return true;
}

// 1. Escaneo 24/7 de Bounties en GitHub y Plataformas Asociadas
async function scanBounties() {
  addLog('INFO', 'Iniciando escaneo 24/7 de bounties abiertos y seguros...');
  const searchQueries = [
    'is:issue is:open label:bounty',
    'is:issue is:open "bounty" "$"',
    'is:issue is:open "[Bounty:"',
    'is:issue is:open label:algora',
    'is:issue is:open label:polar'
  ];

  const foundMap = new Map();
  for (const b of state.activeBounties) {
    if (isSafeBounty(b.title, b.bodyPreview, b.repo)) {
      foundMap.set(b.id, b);
    }
  }

  for (const q of searchQueries) {
    try {
      const url = `https://api.github.com/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=12`;
      const data = await fetchJson(url);
      if (data && Array.isArray(data.items)) {
        for (const item of data.items) {
          if (foundMap.has(item.id)) continue;

          const repoMatch = item.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/issues/);
          const repo = repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : 'open-source/project';

          // Aplicar filtro de seguridad estricto
          if (!isSafeBounty(item.title, item.body, repo)) {
            continue;
          }

          const rewardUsd = extractBountyValue(item.title + ' ' + (item.body || ''));
          const { category, difficulty } = categorizeBounty(item.title, item.body);

          const bountyObj = {
            id: item.id,
            number: item.number,
            title: item.title,
            repo,
            htmlUrl: item.html_url,
            rewardUsd,
            category,
            difficulty,
            createdAt: item.created_at,
            fullBody: item.body ? item.body.slice(0, 2500) : '',
            bodyPreview: item.body ? item.body.slice(0, 280).replace(/\s+/g, ' ') : 'Sin descripción'
          };

          foundMap.set(item.id, bountyObj);
        }
      }
    } catch (err) {
      addLog('WARN', `Consulta parcial (${q.slice(0, 20)}...): ${err.message}`);
    }
  }

  const allBounties = Array.from(foundMap.values());
  allBounties.sort((a, b) => b.rewardUsd - a.rewardUsd);
  state.activeBounties = allBounties.slice(0, 40);

  state.metrics.totalBountiesDetected = allBounties.length;
  state.metrics.totalBountyPoolUsd = allBounties.reduce((sum, b) => sum + (b.rewardUsd || 0), 0);

  addLog('INFO', `Escaneo completado: ${state.activeBounties.length} bounties activos con un pozo total de $${state.metrics.totalBountyPoolUsd.toLocaleString()} USD.`);

  // 2. Generar automáticamente soluciones con IA Real para los bounties prioritarios
  const existingSolBountyIds = new Set(state.solutions.map(s => s.bountyId));
  let generatedThisTick = 0;
  for (const b of state.activeBounties.slice(0, 10)) {
    if (!existingSolBountyIds.has(b.id) && generatedThisTick < 3) {
      const sol = await generateAutomatedSolution(b);
      state.solutions.unshift(sol);
      if (state.solutions.length > 50) state.solutions.length = 50;
      state.metrics.solutionsGenerated += 1;
      state.metrics.potentialEarningsUsd += b.rewardUsd;
      generatedThisTick += 1;
      addLog('SOLVER', `Solución IA generada para ${b.repo} #${b.number} ($${b.rewardUsd} USD) [${b.category}]`);
    }
  }

  // 3. MODO 100% AUTOMÁTICO: Enviar automáticamente la mejor solución generada por IA
  const isAutoSubmit = state.config.autoSubmitPR || process.env.AUTO_SUBMIT_PR === 'true' || true;
  if (isAutoSubmit) {
    const candidate = state.solutions.find(s => s.status === 'SOLUCIÓN_IA_REAL_LISTA' && !s.submittedAt);
    if (candidate) {
      addLog('AUTO_SUBMIT', `Modo 100% Autónomo: Reclamando bounty para ${candidate.repo} #${candidate.issueNumber}...`);
      await submitSolution(candidate.id);
    }
  }
}

// 3. Envío Automático de Solución a GitHub (si hay token configurado)
async function submitSolution(solutionId) {
  const sol = state.solutions.find(s => s.id === solutionId);
  if (!sol) return { ok: false, error: 'Solución no encontrada' };

  const token = process.env.GITHUB_TOKEN || state.config.githubToken;
  if (!token) {
    return {
      ok: false,
      error: 'Para enviar Pull Requests o comentarios automáticamente necesitas introducir tu GitHub Token en la configuración.'
    };
  }

  try {
    // Comenta en el issue proponiendo la solución y reclamando el bounty
    const commentUrl = `https://api.github.com/repos/${sol.repo}/issues/${sol.issueNumber}/comments`;
    const res = await fetchJson(commentUrl, 8000, {
      method: 'POST',
      body: JSON.stringify({ body: sol.prBody })
    });

    sol.status = 'ENVIADO_A_GITHUB';
    sol.submittedAt = new Date().toISOString();
    sol.commentUrl = res.html_url;

    state.submittedClaims.unshift({
      id: crypto.randomUUID(),
      repo: sol.repo,
      issueNumber: sol.issueNumber,
      rewardUsd: sol.rewardUsd,
      commentUrl: res.html_url,
      submittedAt: new Date().toISOString()
    });
    state.metrics.prsSubmitted += 1;
    saveState();

    addLog('CLAIM', `¡Solución enviada con éxito a ${sol.repo} #${sol.issueNumber}! Recompensa en juego: $${sol.rewardUsd}`);
    return { ok: true, commentUrl: res.html_url };
  } catch (err) {
    addLog('ERROR', `Fallo al enviar a GitHub: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

let isScanning = false;
async function runHunterTick() {
  if (isScanning) return;
  isScanning = true;
  try {
    state.scanCount += 1;
    state.lastScanAt = new Date().toISOString();
    await scanBounties();
    saveState();
  } catch (err) {
    addLog('ERROR', `Error en ciclo del cazador: ${err.message}`);
  } finally {
    isScanning = false;
  }
}

// Dashboard HTML para visualización y control en tiempo real
function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NEXUS BOUNTY HUNTER 24/7 — Cazador Autónomo de Recompensas</title>
  <style>
    :root {
      --bg: #090d16;
      --card: #121826;
      --border: #1e293b;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --green: #10b981;
      --gold: #f59e0b;
      --blue: #3b82f6;
      --purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      padding: 20px;
      line-height: 1.5;
    }
    .header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      padding: 18px 24px;
      background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
      border: 1px solid #312e81;
      border-radius: 14px;
      margin-bottom: 20px;
      gap: 12px;
    }
    .brand { display: flex; align-items: center; gap: 14px; }
    .pulse {
      width: 12px; height: 12px; border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 12px var(--green);
      animation: blink 1.6s infinite;
    }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    .badge {
      padding: 5px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      background: rgba(16,185,129,0.15);
      color: var(--green);
      border: 1px solid rgba(16,185,129,0.35);
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .kpi {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px;
    }
    .kpi-label { font-size: 11.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.6px; }
    .kpi-val { font-size: 26px; font-weight: 800; margin-top: 6px; }
    .kpi-sub { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .grid-2 {
      display: grid;
      grid-template-columns: 1.35fr 1fr;
      gap: 18px;
      margin-bottom: 20px;
    }
    @media (max-width: 1024px) { .grid-2 { grid-template-columns: 1fr; } }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
    }
    .card h2 {
      font-size: 15px;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #e2e8f0;
      margin-bottom: 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.06); }
    th { color: var(--muted); font-weight: 600; font-size: 11px; text-transform: uppercase; }
    .reward-pill {
      background: rgba(245, 158, 11, 0.15);
      color: var(--gold);
      border: 1px solid rgba(245, 158, 11, 0.35);
      padding: 3px 8px;
      border-radius: 6px;
      font-weight: 800;
      font-size: 12px;
    }
    .diff-pill {
      padding: 2px 7px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(148, 163, 184, 0.15);
      color: var(--muted);
    }
    .btn {
      background: var(--blue);
      color: #fff;
      border: none;
      padding: 7px 13px;
      border-radius: 7px;
      cursor: pointer;
      font-weight: 600;
      font-size: 12px;
      text-decoration: none;
      display: inline-block;
    }
    .btn:hover { opacity: 0.9; }
    .btn-green { background: var(--green); }
    .btn-purple { background: var(--purple); }
    .form-group { margin-bottom: 12px; }
    input, select {
      width: 100%;
      padding: 9px 12px;
      background: #080c14;
      border: 1px solid var(--border);
      border-radius: 7px;
      color: var(--text);
      font-size: 12.5px;
      margin-top: 4px;
    }
    label { font-size: 11.5px; color: var(--muted); font-weight: 600; }
    .solution-box {
      background: #080c14;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      margin-bottom: 12px;
      font-size: 12.5px;
    }
    pre {
      background: #04060a;
      padding: 8px;
      border-radius: 6px;
      overflow-x: auto;
      font-size: 11.5px;
      color: #38bdf8;
      margin-top: 6px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <div class="pulse"></div>
      <div>
        <h1 style="font-size: 20px; font-weight: 800;">NEXUS BOUNTY HUNTER 24/7</h1>
        <div style="font-size: 12px; color: var(--muted);" id="scanSub">Escaneando GitHub, Algora y Polar en busca de recompensas en dinero real...</div>
      </div>
    </div>
    <div style="display:flex; gap:10px; align-items:center;">
      <span class="badge">MOTOR AUTÓNOMO ACTIVO 24/7</span>
      <button class="btn btn-purple" onclick="forceScan()">🔍 Escanear Nuevos Bounties</button>
    </div>
  </div>

  <div class="kpi-grid">
    <div class="kpi">
      <div class="kpi-label">Pozo Total de Bounties Detectado</div>
      <div class="kpi-val" style="color: var(--gold);" id="poolVal">$0</div>
      <div class="kpi-sub" id="countSub">0 tareas con recompensa en efectivo</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Ganancia Potencial de Soluciones Listas</div>
      <div class="kpi-val" style="color: var(--green);" id="potentialVal">$0</div>
      <div class="kpi-sub" id="solutionsSub">0 soluciones y parches generados</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Claims / Pull Requests Enviados</div>
      <div class="kpi-val" id="submittedVal">0</div>
      <div class="kpi-sub">Listos para revisión y pago</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Ciclos 24/7 Ejecutados</div>
      <div class="kpi-val" id="cyclesVal">0</div>
      <div class="kpi-sub">Búsqueda continua cada 30 segundos</div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>🎯 Bounties Abiertos Detectados en Repositorios Activos</h2>
      <table>
        <thead>
          <tr>
            <th>Recompensa</th>
            <th>Proyecto / Repo</th>
            <th>Tarea / Issue</th>
            <th>Tipo</th>
            <th>Acción</th>
          </tr>
        </thead>
        <tbody id="bountiesTable"></tbody>
      </table>
    </div>

    <div class="card">
      <h2>⚙️ Configuración Mínima (Solo 1 Paso)</h2>
      <p style="font-size:12px; color:var(--muted); margin-bottom:12px;">
        Para recibir los pagos directamente y permitir que el agente envíe los Pull Requests por ti:
      </p>

      <div class="form-group">
        <label>1. Dirección donde quieres cobrar (Wallet Cripto o PayPal)</label>
        <input id="cfgPayout" placeholder="Ej: 0x123... (USDC) o tu_email@paypal.com" />
      </div>

      <div class="form-group">
        <label>Tipo de Cobro</label>
        <select id="cfgPayoutType">
          <option value="USDC_EVM">USDC en Red Polygon / Arbitrum / Base (Cero comisiones)</option>
          <option value="SOLANA">Solana (SOL / USDC)</option>
          <option value="PAYPAL">PayPal / Transferencia</option>
        </select>
      </div>

      <div class="form-group">
        <label>2. Tu GitHub Personal Access Token (Gratuito)</label>
        <input id="cfgToken" type="password" placeholder="ghp_xxxxxxxxxxxx (Permite abrir PRs automáticos)" />
        <span style="font-size:11px; color:var(--muted); margin-top:3px; display:block;">
          Generable gratis en github.com > Settings > Developer settings > Tokens (classic).
        </span>
      </div>

      <button class="btn btn-green" style="width:100%; padding:10px; margin-top:6px;" onclick="saveConfig()">
        💾 Guardar Datos de Cobro y Activar Auto-Submit
      </button>
      <div id="saveMsg" style="font-size:12px; color:var(--green); margin-top:6px; text-align:center;"></div>
    </div>
  </div>

  <div class="grid-2">
    <div class="card">
      <h2>💡 Soluciones y Parches de Código Listos para Reclamar</h2>
      <div id="solutionsBox"></div>
    </div>

    <div class="card">
      <h2>📜 Registro de Actividad 24/7</h2>
      <div id="logsBox" style="max-height: 380px; overflow-y: auto; font-family: monospace; font-size: 11.5px; color: #cbd5e1;"></div>
    </div>
  </div>

  <script>
    let configInit = false;

    async function loadData() {
      try {
        const res = await fetch('/api/state');
        const data = await res.json();

        document.getElementById('poolVal').textContent = '$' + Number(data.metrics.totalBountyPoolUsd || 0).toLocaleString() + ' USD';
        document.getElementById('countSub').textContent = (data.metrics.totalBountiesDetected || 0) + ' bounties activos detectados';
        document.getElementById('potentialVal').textContent = '$' + Number(data.metrics.potentialEarningsUsd || 0).toLocaleString() + ' USD';
        document.getElementById('solutionsSub').textContent = (data.metrics.solutionsGenerated || 0) + ' soluciones preparadas';
        document.getElementById('submittedVal').textContent = data.metrics.prsSubmitted || 0;
        document.getElementById('cyclesVal').textContent = data.scanCount || 0;
        document.getElementById('scanSub').textContent = 'Último escaneo: ' + (data.lastScanAt ? new Date(data.lastScanAt).toLocaleTimeString() : 'Iniciando...');

        // Bounties Table
        const bRows = (data.activeBounties || []).map(b => {
          return '<tr>' +
            '<td><span class="reward-pill">$' + b.rewardUsd + '</span></td>' +
            '<td><a href="https://github.com/' + b.repo + '" target="_blank" style="color:var(--blue); text-decoration:none; font-weight:600;">' + b.repo + '</a></td>' +
            '<td><div style="max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="' + b.title + '">#' + b.number + ' ' + b.title + '</div></td>' +
            '<td><span class="diff-pill">' + b.category + '</span></td>' +
            '<td><a href="' + b.htmlUrl + '" target="_blank" class="btn">Ver Issue</a></td>' +
          '</tr>';
        }).join('');
        document.getElementById('bountiesTable').innerHTML = bRows || '<tr><td colspan="5">Buscando bounties abiertos...</td></tr>';

        // Solutions Box
        const sRows = (data.solutions || []).map(s => {
          return '<div class="solution-box">' +
            '<div style="display:flex; justify-content:space-between; align-items:center;">' +
              '<strong>' + s.repo + ' #' + s.issueNumber + '</strong>' +
              '<span class="reward-pill">Recompensa: $' + s.rewardUsd + '</span>' +
            '</div>' +
            '<div style="color:var(--muted); font-size:12px; margin-top:4px;">' + s.explanation + '</div>' +
            '<pre>' + s.proposedCode + '</pre>' +
            '<div style="margin-top:8px; display:flex; justify-content:space-between; align-items:center;">' +
              '<span style="font-size:11px; color:var(--green);">' + s.status + '</span>' +
              '<div>' +
                '<a href="' + s.issueUrl + '" target="_blank" class="btn" style="margin-right:6px;">Abrir en GitHub</a>' +
                '<button class="btn btn-green" onclick="submitSol(\'' + s.id + '\')">Enviar Solución & Cobrar</button>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');
        document.getElementById('solutionsBox').innerHTML = sRows || '<div class="solution-box">El agente está analizando código para generar las primeras soluciones...</div>';

        // Logs
        const lRows = (data.logs || []).map(l => {
          return '<div>[' + new Date(l.time).toLocaleTimeString() + '] [' + l.level + '] ' + l.msg + '</div>';
        }).join('');
        document.getElementById('logsBox').innerHTML = lRows;

        if (!configInit && data.config) {
          configInit = true;
          document.getElementById('cfgPayout').value = data.config.payoutAddress || '';
          document.getElementById('cfgPayoutType').value = data.config.payoutType || 'USDC_EVM';
        }
      } catch (e) {
        console.error(e);
      }
    }

    async function forceScan() {
      await fetch('/api/scan', { method: 'POST' });
      await loadData();
    }

    async function saveConfig() {
      const body = {
        payoutAddress: document.getElementById('cfgPayout').value.trim(),
        payoutType: document.getElementById('cfgPayoutType').value,
        githubToken: document.getElementById('cfgToken').value.trim()
      };
      await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      document.getElementById('saveMsg').textContent = '¡Configuración guardada y activa!';
      setTimeout(() => { document.getElementById('saveMsg').textContent = ''; }, 3000);
      await loadData();
    }

    async function submitSol(id) {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ solutionId: id })
      });
      const data = await res.json();
      if (data.ok) {
        alert('¡Solución enviada a GitHub con éxito!');
      } else {
        alert(data.error);
      }
      await loadData();
    }

    loadData();
    setInterval(loadData, 4000);
  </script>
</body>
</html>`;
}

// Servidor Web y API
function startServer() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/api/state' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }

    if (req.url === '/api/scan' && req.method === 'POST') {
      await runHunterTick();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === '/api/submit' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const result = await submitSolution(parsed.solutionId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    if (req.url === '/api/config' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          if (parsed.payoutAddress) state.config.payoutAddress = parsed.payoutAddress;
          if (parsed.payoutType) state.config.payoutType = parsed.payoutType;
          if (parsed.githubToken !== undefined && parsed.githubToken !== '') {
            state.config.githubToken = parsed.githubToken;
          }
          saveState();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboardHtml());
  });

  server.listen(PORT, () => {
    addLog('SYSTEM', `Panel del Cazador de Bounties activo en http://localhost:${PORT}`);
  });
}

(async () => {
  addLog('SYSTEM', 'Iniciando NEXUS BOUNTY HUNTER 24/7...');
  await runHunterTick();

  if (SINGLE_TICK) {
    addLog('SYSTEM', 'Ciclo single-tick completado.');
    process.exit(0);
  }

  startServer();
  // Escaneo continuo cada 35 segundos las 24 horas
  setInterval(runHunterTick, 35000);
})();
