const STORAGE_KEY = 'carteira-inv';
const HISTORY_KEY = 'carteira-inv-history';
const CLAUDE_KEY = 'carteira-inv-claude';
const RF_KEY = 'carteira-inv-rf';
const CORS_PROXY = 'https://corsproxy.io/?';

const CDI_TYPES = ['CDB', 'LCI', 'LCA'];
let currentCDI = 0;

const state = {
    fiis: loadData('fiis'),
    acoes: loadData('acoes'),
    rf: loadRF(),
    quotes: {},
    history: loadHistory(),
};

// ─── PERSISTENCE ───
function loadData(cat) {
    try { return JSON.parse(localStorage.getItem(`${STORAGE_KEY}-${cat}`)) || []; } catch { return []; }
}
function saveData(cat) { localStorage.setItem(`${STORAGE_KEY}-${cat}`, JSON.stringify(state[cat])); }
function loadRF() {
    try { return JSON.parse(localStorage.getItem(RF_KEY)) || []; } catch { return []; }
}
function saveRF() { localStorage.setItem(RF_KEY, JSON.stringify(state.rf)); }
function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || { dates: [], fiis: [], acoes: [], rf: [], divFiis: [], divAcoes: [] }; } catch { return { dates: [], fiis: [], acoes: [], rf: [], divFiis: [], divAcoes: [] }; }
}
function saveHistory() { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); }
function getClaudeKey() { return localStorage.getItem(CLAUDE_KEY) || ''; }
function saveClaudeKey(k) { localStorage.setItem(CLAUDE_KEY, k.trim()); }

// ─── FORMATTERS ───
function fmt(v) { return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
function pct(v) { return v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%'; }

function showToast(msg, type = 'success') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast ${type} show`;
    setTimeout(() => t.classList.remove('show'), 3000);
}

// ─── TABS ───
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`page-${tab.dataset.tab}`).classList.add('active');
    });
});

// ─── CONFIG ───
function openConfigModal() {
    document.getElementById('inputClaudeKey').value = getClaudeKey();
    document.getElementById('configModal').style.display = 'flex';
}

document.getElementById('btnConfig').addEventListener('click', openConfigModal);
document.getElementById('btnCancelConfig').addEventListener('click', () => { document.getElementById('configModal').style.display = 'none'; });
document.getElementById('configModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.target.style.display = 'none'; });

document.getElementById('formConfig').addEventListener('submit', e => {
    e.preventDefault();
    const claude = document.getElementById('inputClaudeKey').value.trim();
    if (claude) saveClaudeKey(claude);
    document.getElementById('configModal').style.display = 'none';
    showToast('Configurações salvas!');
});

// ─── API (Yahoo Finance) ───
function yahooTicker(ticker) {
    return ticker.endsWith('.SA') ? ticker : ticker + '.SA';
}

async function fetchYahoo(url) {
    const r = await fetch(CORS_PROXY + encodeURIComponent(url));
    if (!r.ok) throw new Error('Erro na requisição');
    return r.json();
}

async function fetchQuote(ticker) {
    const yt = yahooTicker(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yt}?interval=1d&range=1y&events=div`;
    const data = await fetchYahoo(url);
    const result = data.chart?.result?.[0];
    if (!result) throw new Error(`${ticker} não encontrado`);

    const meta = result.meta;
    const price = meta.regularMarketPrice;
    const divEvents = result.events?.dividends || {};
    const dividends = Object.values(divEvents);

    return {
        symbol: ticker,
        regularMarketPrice: price,
        dividends: dividends,
    };
}

async function fetchAllQuotes() {
    const allTickers = [...state.fiis, ...state.acoes].map(a => a.ticker);
    if (!allTickers.length) return;

    let success = 0;
    const promises = allTickers.map(async ticker => {
        try {
            const quote = await fetchQuote(ticker);
            state.quotes[ticker] = quote;
            success++;
        } catch (err) {
            console.warn(`Erro ao buscar ${ticker}:`, err);
        }
    });

    await Promise.all(promises);

    if (success > 0) {
        document.getElementById('lastUpdate').textContent = `Última atualização: ${new Date().toLocaleTimeString('pt-BR')}`;
        updateAll();
        recordHistory();
    } else if (allTickers.length > 0) {
        showToast('Erro ao buscar cotações. Tente novamente.', 'error');
    }
}

// ─── DIVIDENDS ───
function getMonthlyDiv(ticker) {
    const q = state.quotes[ticker];
    if (!q?.dividends?.length) return 0;
    const now = new Date();
    const ago = new Date(now);
    ago.setFullYear(ago.getFullYear() - 1);
    const nowTs = now.getTime() / 1000;
    const agoTs = ago.getTime() / 1000;

    const recent = q.dividends.filter(d => d.date >= agoTs && d.date <= nowTs);
    if (!recent.length) return 0;
    return recent.reduce((s, d) => s + (d.amount || 0), 0) / 12;
}

function getDY(ticker) {
    const q = state.quotes[ticker];
    if (!q?.regularMarketPrice) return 0;
    return (getMonthlyDiv(ticker) * 12 / q.regularMarketPrice) * 100;
}

// ─── UPDATE ALL ───
function updateAll() {
    updateCategoryUI('fiis');
    updateCategoryUI('acoes');
    updateRFUI();
    updateDashboard();
}

// ─── CATEGORY UI (FIIs / Ações) ───
function updateCategoryUI(cat) {
    const assets = state[cat];
    const tbody = document.getElementById(`tbody-${cat}`);

    if (!assets.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="9">Nenhum ativo adicionado.</td></tr>`;
    } else {
        tbody.innerHTML = assets.map(a => {
            const q = state.quotes[a.ticker];
            const price = q?.regularMarketPrice || 0;
            const total = price * a.quantidade;
            const vari = a.precoMedio > 0 ? ((price - a.precoMedio) / a.precoMedio) * 100 : 0;
            const mDiv = getMonthlyDiv(a.ticker) * a.quantidade;
            const dy = getDY(a.ticker);
            const cls = vari >= 0 ? 'positive' : 'negative';
            const sign = vari >= 0 ? '+' : '';
            return `<tr>
                <td class="ticker-cell">${a.ticker}</td>
                <td>${a.quantidade}</td>
                <td>${fmt(a.precoMedio)}</td>
                <td>${price ? fmt(price) : '<span class="loading-spinner"></span>'}</td>
                <td><span class="variation-badge ${cls}">${sign}${pct(vari)}</span></td>
                <td><strong>${fmt(total)}</strong></td>
                <td class="positive">${fmt(mDiv)}</td>
                <td>${pct(dy)}</td>
                <td><div class="actions-cell">
                    <button class="btn-icon" onclick="openEdit('${a.ticker}','${cat}')" title="Editar"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                    <button class="btn-icon delete" onclick="removeAsset('${a.ticker}','${cat}')" title="Remover"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
                </div></td></tr>`;
        }).join('');
    }

    let totP = 0, totI = 0, totD = 0, totC = 0;
    assets.forEach(a => {
        const price = state.quotes[a.ticker]?.regularMarketPrice || 0;
        totP += price * a.quantidade;
        totI += a.precoMedio * a.quantidade;
        totD += getMonthlyDiv(a.ticker) * a.quantidade;
        totC += a.quantidade;
    });

    const vAbs = totP - totI;
    const vPct = totI > 0 ? (vAbs / totI) * 100 : 0;
    const dyM = totP > 0 ? (totD * 12 / totP) * 100 : 0;

    document.getElementById(`${cat}-patrimonio`).textContent = fmt(totP);
    const varEl = document.getElementById(`${cat}-variacao`);
    varEl.textContent = `${vAbs >= 0 ? '+' : ''}${fmt(vAbs)} (${vAbs >= 0 ? '+' : ''}${pct(vPct)})`;
    varEl.className = `card-sub ${vAbs >= 0 ? 'positive' : 'negative'}`;
    document.getElementById(`${cat}-dividendos`).textContent = fmt(totD);
    document.getElementById(`${cat}-divdia`).textContent = `${fmt(totD / 30)} por dia`;
    document.getElementById(`${cat}-dy`).textContent = pct(dyM);
    document.getElementById(`${cat}-qtd`).textContent = assets.length;
    document.getElementById(`${cat}-cotas`).textContent = `${totC} cotas`;

    updateCategoryCharts(cat);
}

// ─── CATEGORY CHARTS ───
const charts = {};

function updateCategoryCharts(cat) {
    const h = state.history;
    const pKey = cat === 'fiis' ? 'fiis' : 'acoes';
    const dKey = cat === 'fiis' ? 'divFiis' : 'divAcoes';

    const opts = chartOpts();

    const ctxP = document.getElementById(`chart${cap(cat)}Patrimonio`).getContext('2d');
    if (charts[`${cat}P`]) charts[`${cat}P`].destroy();
    charts[`${cat}P`] = new Chart(ctxP, {
        type: 'line',
        data: { labels: h.dates, datasets: [{ data: h[pKey] || [], borderColor: '#4f8cff', backgroundColor: 'rgba(79,140,255,0.12)', borderWidth: 2.5, fill: true, tension: 0.35, pointRadius: (h.dates?.length || 0) > 30 ? 0 : 3, pointBackgroundColor: '#4f8cff' }] },
        options: opts,
    });

    const ctxD = document.getElementById(`chart${cap(cat)}Dividendos`).getContext('2d');
    if (charts[`${cat}D`]) charts[`${cat}D`].destroy();
    charts[`${cat}D`] = new Chart(ctxD, {
        type: 'bar',
        data: { labels: h.dates, datasets: [{ data: h[dKey] || [], backgroundColor: '#22c55e', borderRadius: 5, borderSkipped: false, maxBarThickness: 36 }] },
        options: opts,
    });
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function chartOpts() {
    return {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { display: false }, tooltip: { backgroundColor: '#1a1d27', titleColor: '#e4e6ed', bodyColor: '#e4e6ed', borderColor: '#2a2d3a', borderWidth: 1, cornerRadius: 8, padding: 10, callbacks: { label: c => ` ${fmt(c.parsed.y)}` } } },
        scales: {
            x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8b8fa3', font: { size: 10 } } },
            y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#8b8fa3', font: { size: 10 }, callback: v => fmt(v) } },
        },
    };
}

// ─── RENDA FIXA ───
function rfMonthly(item) {
    return (item.valor * (item.taxa / 100)) / 12;
}

function updateRFUI() {
    const tbody = document.getElementById('tbody-rf');
    if (!state.rf.length) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="8">Nenhum título de renda fixa.</td></tr>`;
    } else {
        tbody.innerHTML = state.rf.map(item => {
            const venc = new Date(item.vencimento);
            const hoje = new Date();
            const dias = Math.ceil((venc - hoje) / (1000 * 60 * 60 * 24));
            const rend = rfMonthly(item);
            return `<tr>
                <td><strong>${item.nome}</strong></td>
                <td><span class="rf-type-badge">${item.tipo}</span></td>
                <td>${fmt(item.valor)}</td>
                <td>${item.cdiPct ? `${pct(item.cdiPct)} CDI <span style="color:var(--text-secondary);font-size:0.75rem">(${pct(item.taxa)})</span>` : pct(item.taxa)}</td>
                <td class="positive">${fmt(rend)}</td>
                <td>${venc.toLocaleDateString('pt-BR')}</td>
                <td><span class="${dias < 30 ? 'negative' : ''}">${dias}d</span></td>
                <td><div class="actions-cell">
                    <button class="btn-icon" onclick="openEditRF('${item.id}')" title="Editar"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
                    <button class="btn-icon delete" onclick="removeRF('${item.id}')" title="Remover"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg></button>
                </div></td></tr>`;
        }).join('');
    }

    const totVal = state.rf.reduce((s, i) => s + i.valor, 0);
    const totRend = state.rf.reduce((s, i) => s + rfMonthly(i), 0);
    const taxaMedia = totVal > 0 ? state.rf.reduce((s, i) => s + (i.taxa * i.valor), 0) / totVal : 0;
    const tipos = [...new Set(state.rf.map(i => i.tipo))];

    document.getElementById('rf-total').textContent = fmt(totVal);
    document.getElementById('rf-sub').textContent = `${state.rf.length} títulos`;
    document.getElementById('rf-rendimento').textContent = fmt(totRend);
    document.getElementById('rf-renddia').textContent = `${fmt(totRend / 30)} por dia`;
    document.getElementById('rf-taxa').textContent = pct(taxaMedia);
    document.getElementById('rf-qtd').textContent = state.rf.length;
    document.getElementById('rf-tipos').textContent = tipos.join(', ') || '-';

    updateRFCharts();
}

function updateRFCharts() {
    const tipos = {};
    state.rf.forEach(i => { tipos[i.tipo] = (tipos[i.tipo] || 0) + i.valor; });
    const labels = Object.keys(tipos);
    const data = Object.values(tipos);
    const colors = ['#4f8cff', '#22c55e', '#a855f7', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1'];

    const ctx1 = document.getElementById('chartRFTipo').getContext('2d');
    if (charts.rfTipo) charts.rfTipo.destroy();
    charts.rfTipo = new Chart(ctx1, {
        type: 'doughnut',
        data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, labels.length), borderWidth: 0 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '60%',
            plugins: { legend: { position: 'bottom', labels: { color: '#8b8fa3', padding: 12, font: { size: 11 } } }, tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt(c.raw)}` } } },
        },
    });

    const rendByTipo = {};
    state.rf.forEach(i => { rendByTipo[i.tipo] = (rendByTipo[i.tipo] || 0) + rfMonthly(i); });
    const ctx2 = document.getElementById('chartRFRend').getContext('2d');
    if (charts.rfRend) charts.rfRend.destroy();
    charts.rfRend = new Chart(ctx2, {
        type: 'bar',
        data: { labels: Object.keys(rendByTipo), datasets: [{ data: Object.values(rendByTipo), backgroundColor: colors.slice(0, Object.keys(rendByTipo).length), borderRadius: 5, borderSkipped: false, maxBarThickness: 50 }] },
        options: { ...chartOpts(), plugins: { ...chartOpts().plugins, legend: { display: false } } },
    });
}

// ─── DASHBOARD ───
function getTotals(cat) {
    let p = 0, i = 0, d = 0;
    state[cat].forEach(a => {
        const price = state.quotes[a.ticker]?.regularMarketPrice || 0;
        p += price * a.quantidade;
        i += a.precoMedio * a.quantidade;
        d += getMonthlyDiv(a.ticker) * a.quantidade;
    });
    return { patrimonio: p, investido: i, dividendos: d };
}

function updateDashboard() {
    const fiis = getTotals('fiis');
    const acoes = getTotals('acoes');
    const rfTotal = state.rf.reduce((s, i) => s + i.valor, 0);
    const rfRend = state.rf.reduce((s, i) => s + rfMonthly(i), 0);

    const totalP = fiis.patrimonio + acoes.patrimonio + rfTotal;
    const totalI = fiis.investido + acoes.investido + rfTotal;
    const totalD = fiis.dividendos + acoes.dividendos;
    const vAbs = totalP - totalI;
    const vPct = totalI > 0 ? (vAbs / totalI) * 100 : 0;
    const dyM = (totalP - rfTotal) > 0 ? (totalD * 12 / (totalP - rfTotal)) * 100 : 0;

    document.getElementById('dash-patrimonio').textContent = fmt(totalP);
    const varEl = document.getElementById('dash-variacao');
    varEl.textContent = `${vAbs >= 0 ? '+' : ''}${fmt(vAbs)} (${vAbs >= 0 ? '+' : ''}${pct(vPct)})`;
    varEl.className = `card-sub ${vAbs >= 0 ? 'positive' : 'negative'}`;

    document.getElementById('dash-dividendos').textContent = fmt(totalD);
    document.getElementById('dash-divdia').textContent = `${fmt(totalD / 30)} por dia`;
    document.getElementById('dash-dy').textContent = pct(dyM);
    document.getElementById('dash-rendafixa').textContent = fmt(rfRend);
    document.getElementById('dash-rfpct').textContent = totalP > 0 ? `${pct(rfTotal / totalP * 100)} da carteira` : '';

    updateDashCharts(fiis, acoes, rfTotal, rfRend);
}

function updateDashCharts(fiis, acoes, rfTotal, rfRend) {
    const segments = [];
    if (fiis.patrimonio > 0) segments.push({ label: 'Fundos Imobiliários', value: fiis.patrimonio, color: '#4f8cff' });
    if (acoes.patrimonio > 0) segments.push({ label: 'Ações', value: acoes.patrimonio, color: '#a855f7' });
    if (rfTotal > 0) segments.push({ label: 'Renda Fixa', value: rfTotal, color: '#22c55e' });

    const total = segments.reduce((s, seg) => s + seg.value, 0);
    const legend = document.getElementById('compositionLegend');

    if (!segments.length) {
        legend.innerHTML = '<p style="color:var(--text-secondary);font-size:0.85rem">Adicione ativos para ver a composição.</p>';
    } else {
        legend.innerHTML = segments.map(seg => `
            <div class="legend-item">
                <div class="legend-dot" style="background:${seg.color}"></div>
                <span class="legend-label">${seg.label}</span>
                <span class="legend-value">${fmt(seg.value)}</span>
                <span class="legend-pct">${pct(seg.value / total * 100)}</span>
            </div>
        `).join('');
    }

    const ctx = document.getElementById('chartComposicao').getContext('2d');
    if (charts.comp) charts.comp.destroy();
    charts.comp = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: segments.map(s => s.label),
            datasets: [{ data: segments.map(s => s.value), backgroundColor: segments.map(s => s.color), borderWidth: 0 }],
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ` ${c.label}: ${fmt(c.raw)}` } } },
        },
    });

    const h = state.history;
    const totalHist = (h.fiis || []).map((v, i) => v + (h.acoes?.[i] || 0) + (h.rf?.[i] || 0));
    const totalDiv = (h.divFiis || []).map((v, i) => v + (h.divAcoes?.[i] || 0));

    const opts = chartOpts();

    const ctxP = document.getElementById('chartDashPatrimonio').getContext('2d');
    if (charts.dashP) charts.dashP.destroy();
    charts.dashP = new Chart(ctxP, {
        type: 'line',
        data: { labels: h.dates, datasets: [
            { label: 'Total', data: totalHist, borderColor: '#4f8cff', backgroundColor: 'rgba(79,140,255,0.08)', borderWidth: 2.5, fill: true, tension: 0.35, pointRadius: 0 },
            { label: 'FIIs', data: h.fiis || [], borderColor: 'rgba(79,140,255,0.4)', borderWidth: 1, borderDash: [4,4], tension: 0.35, pointRadius: 0 },
            { label: 'Ações', data: h.acoes || [], borderColor: 'rgba(168,85,247,0.4)', borderWidth: 1, borderDash: [4,4], tension: 0.35, pointRadius: 0 },
        ] },
        options: { ...opts, plugins: { ...opts.plugins, legend: { display: true, labels: { color: '#8b8fa3', font: { size: 10 }, boxWidth: 12 } } } },
    });

    const ctxD = document.getElementById('chartDashDividendos').getContext('2d');
    if (charts.dashD) charts.dashD.destroy();
    charts.dashD = new Chart(ctxD, {
        type: 'bar',
        data: { labels: h.dates, datasets: [
            { label: 'FIIs', data: h.divFiis || [], backgroundColor: '#4f8cff', borderRadius: 4, borderSkipped: false, maxBarThickness: 30 },
            { label: 'Ações', data: h.divAcoes || [], backgroundColor: '#a855f7', borderRadius: 4, borderSkipped: false, maxBarThickness: 30 },
        ] },
        options: { ...opts, scales: { ...opts.scales, x: { ...opts.scales.x, stacked: true }, y: { ...opts.scales.y, stacked: true } }, plugins: { ...opts.plugins, legend: { display: true, labels: { color: '#8b8fa3', font: { size: 10 }, boxWidth: 12 } } } },
    });
}

// ─── HISTORY ───
function recordHistory() {
    const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    const h = state.history;
    const fiis = getTotals('fiis');
    const acoes = getTotals('acoes');
    const rfVal = state.rf.reduce((s, i) => s + i.valor, 0);

    if (fiis.patrimonio === 0 && acoes.patrimonio === 0 && rfVal === 0) return;

    const lastIdx = h.dates.length - 1;
    if (lastIdx >= 0 && h.dates[lastIdx] === today) {
        h.fiis[lastIdx] = fiis.patrimonio;
        h.acoes[lastIdx] = acoes.patrimonio;
        h.rf[lastIdx] = rfVal;
        h.divFiis[lastIdx] = fiis.dividendos;
        h.divAcoes[lastIdx] = acoes.dividendos;
    } else {
        h.dates.push(today);
        (h.fiis = h.fiis || []).push(fiis.patrimonio);
        (h.acoes = h.acoes || []).push(acoes.patrimonio);
        (h.rf = h.rf || []).push(rfVal);
        (h.divFiis = h.divFiis || []).push(fiis.dividendos);
        (h.divAcoes = h.divAcoes || []).push(acoes.dividendos);
    }

    if (h.dates.length > 90) {
        ['dates', 'fiis', 'acoes', 'rf', 'divFiis', 'divAcoes'].forEach(k => { h[k] = (h[k] || []).slice(-90); });
    }
    saveHistory();
}

// ─── ADD ASSET (FII / Ação) ───
document.querySelectorAll('.add-form[data-category]').forEach(form => {
    const cat = form.dataset.category;

    form.querySelector('.input-ticker').addEventListener('input', e => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const errEl = form.closest('.card').querySelector('.form-error');
        errEl.textContent = '';

        const ticker = form.querySelector('.input-ticker').value.trim().toUpperCase();
        const qty = parseInt(form.querySelector('.input-qty').value);
        const price = parseFloat(form.querySelector('.input-price').value);

        if (!ticker || !qty || !price) { errEl.textContent = 'Preencha todos os campos.'; return; }
        if (state[cat].find(a => a.ticker === ticker)) { errEl.textContent = `${ticker} já está na carteira.`; return; }

        const btn = form.querySelector('button[type="submit"]');
        btn.innerHTML = '<span class="loading-spinner"></span> Buscando...';
        btn.disabled = true;

        try {
            const quote = await fetchQuote(ticker);
            state.quotes[ticker] = quote;
            state[cat].push({ ticker, quantidade: qty, precoMedio: price });
            saveData(cat);
            updateAll();
            recordHistory();
            form.querySelector('.input-ticker').value = '';
            form.querySelector('.input-qty').value = '';
            form.querySelector('.input-price').value = '';
            showToast(`${ticker} adicionado!`);
        } catch (err) {
            errEl.textContent = err.message;
        } finally {
            btn.innerHTML = 'Adicionar';
            btn.disabled = false;
        }
    });
});

// ─── CDI ───
async function fetchCDI() {
    try {
        const r = await fetch('https://api.bcb.gov.br/dados/serie/bcdata.sgs.4389/dados/ultimos/1?formato=json');
        const data = await r.json();
        if (data?.[0]?.valor) {
            currentCDI = parseFloat(data[0].valor.replace(',', '.'));
            const cdiInfo = document.getElementById('rf-cdi-info');
            if (cdiInfo) cdiInfo.textContent = `CDI atual: ${pct(currentCDI)} a.a.`;
        }
    } catch (e) {
        currentCDI = 14.15;
    }
}

document.getElementById('rf-tipo').addEventListener('change', e => {
    const isCDI = CDI_TYPES.includes(e.target.value);
    document.getElementById('rf-cdi-group').style.display = isCDI ? 'flex' : 'none';
    const taxaInput = document.getElementById('rf-taxaInput');
    const taxaGroup = document.getElementById('rf-taxa-group');

    if (isCDI) {
        taxaInput.removeAttribute('required');
        taxaInput.readOnly = true;
        taxaGroup.querySelector('label').textContent = 'Taxa equivalente (% a.a.)';
        document.getElementById('rf-cdiPct').setAttribute('required', '');
        if (currentCDI === 0) fetchCDI();
    } else {
        taxaInput.setAttribute('required', '');
        taxaInput.readOnly = false;
        taxaInput.value = '';
        taxaGroup.querySelector('label').textContent = 'Taxa (% a.a.)';
        document.getElementById('rf-cdiPct').removeAttribute('required');
        document.getElementById('rf-cdiPct').value = '';
    }
});

document.getElementById('rf-cdiPct').addEventListener('input', e => {
    const pctVal = parseFloat(e.target.value);
    if (pctVal && currentCDI > 0) {
        const taxaEq = (pctVal / 100) * currentCDI;
        document.getElementById('rf-taxaInput').value = taxaEq.toFixed(2);
    } else {
        document.getElementById('rf-taxaInput').value = '';
    }
});

// ─── RENDA FIXA FORM ───
document.getElementById('formRendaFixa').addEventListener('submit', e => {
    e.preventDefault();
    const errEl = document.getElementById('rf-error');
    errEl.textContent = '';

    const nome = document.getElementById('rf-nome').value.trim();
    const tipo = document.getElementById('rf-tipo').value;
    const valor = parseFloat(document.getElementById('rf-valor').value);
    const cdiPct = parseFloat(document.getElementById('rf-cdiPct').value) || null;
    const taxa = parseFloat(document.getElementById('rf-taxaInput').value);
    const vencimento = document.getElementById('rf-vencimento').value;

    if (!nome || !tipo || !valor || !taxa || !vencimento) { errEl.textContent = 'Preencha todos os campos.'; return; }
    if (CDI_TYPES.includes(tipo) && !cdiPct) { errEl.textContent = 'Informe a % do CDI.'; return; }

    state.rf.push({ id: Date.now().toString(), nome, tipo, valor, taxa, vencimento, cdiPct });
    saveRF();
    updateAll();
    recordHistory();

    document.getElementById('rf-nome').value = '';
    document.getElementById('rf-tipo').value = '';
    document.getElementById('rf-valor').value = '';
    document.getElementById('rf-taxaInput').value = '';
    document.getElementById('rf-taxaInput').readOnly = false;
    document.getElementById('rf-taxa-group').querySelector('label').textContent = 'Taxa (% a.a.)';
    document.getElementById('rf-cdiPct').value = '';
    document.getElementById('rf-cdi-group').style.display = 'none';
    document.getElementById('rf-vencimento').value = '';
    showToast(`${nome} adicionado!`);
});

// ─── EDIT / REMOVE (FII / Ação) ───
window.openEdit = function(ticker, cat) {
    const a = state[cat].find(x => x.ticker === ticker);
    if (!a) return;
    document.getElementById('editTicker').value = ticker;
    document.getElementById('editCategory').value = cat;
    document.getElementById('editQty').value = a.quantidade;
    document.getElementById('editPrice').value = a.precoMedio;
    document.getElementById('editModal').style.display = 'flex';
};

document.getElementById('formEdit').addEventListener('submit', e => {
    e.preventDefault();
    const ticker = document.getElementById('editTicker').value;
    const cat = document.getElementById('editCategory').value;
    const a = state[cat].find(x => x.ticker === ticker);
    if (a) {
        a.quantidade = parseInt(document.getElementById('editQty').value);
        a.precoMedio = parseFloat(document.getElementById('editPrice').value);
        saveData(cat);
        updateAll();
        showToast(`${ticker} atualizado!`);
    }
    document.getElementById('editModal').style.display = 'none';
});

document.getElementById('btnCancelEdit').addEventListener('click', () => { document.getElementById('editModal').style.display = 'none'; });
document.getElementById('editModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.target.style.display = 'none'; });

window.removeAsset = function(ticker, cat) {
    if (!confirm(`Remover ${ticker}?`)) return;
    state[cat] = state[cat].filter(a => a.ticker !== ticker);
    delete state.quotes[ticker];
    saveData(cat);
    updateAll();
    showToast(`${ticker} removido.`);
};

// ─── EDIT / REMOVE RF ───
window.openEditRF = function(id) {
    const item = state.rf.find(x => x.id === id);
    if (!item) return;
    document.getElementById('editRFId').value = id;
    document.getElementById('editRFValor').value = item.valor;
    document.getElementById('editRFTaxa').value = item.taxa;
    document.getElementById('editRFModal').style.display = 'flex';
};

document.getElementById('formEditRF').addEventListener('submit', e => {
    e.preventDefault();
    const id = document.getElementById('editRFId').value;
    const item = state.rf.find(x => x.id === id);
    if (item) {
        item.valor = parseFloat(document.getElementById('editRFValor').value);
        item.taxa = parseFloat(document.getElementById('editRFTaxa').value);
        saveRF();
        updateAll();
        showToast('Título atualizado!');
    }
    document.getElementById('editRFModal').style.display = 'none';
});

document.getElementById('btnCancelEditRF').addEventListener('click', () => { document.getElementById('editRFModal').style.display = 'none'; });
document.getElementById('editRFModal').addEventListener('click', e => { if (e.target === e.currentTarget) e.target.style.display = 'none'; });

window.removeRF = function(id) {
    const item = state.rf.find(x => x.id === id);
    if (!confirm(`Remover ${item?.nome}?`)) return;
    state.rf = state.rf.filter(x => x.id !== id);
    saveRF();
    updateAll();
    showToast('Título removido.');
};

// ─── EXPORT CSV ───
document.querySelectorAll('.btn-export').forEach(btn => {
    btn.addEventListener('click', () => {
        const cat = btn.dataset.category;
        if (!state[cat].length) return;
        let csv = 'Ticker,Cotas,Preco Medio,Preco Atual,Variacao,Valor Total,Div Mensal,DY 12m\n';
        state[cat].forEach(a => {
            const price = state.quotes[a.ticker]?.regularMarketPrice || 0;
            const total = price * a.quantidade;
            const vari = a.precoMedio > 0 ? ((price - a.precoMedio) / a.precoMedio) * 100 : 0;
            const mDiv = getMonthlyDiv(a.ticker) * a.quantidade;
            csv += `${a.ticker},${a.quantidade},${a.precoMedio.toFixed(2)},${price.toFixed(2)},${vari.toFixed(2)},${total.toFixed(2)},${mDiv.toFixed(2)},${getDY(a.ticker).toFixed(2)}\n`;
        });
        downloadCSV(csv, `carteira-${cat}`);
    });
});

document.getElementById('btnExportRF').addEventListener('click', () => {
    if (!state.rf.length) return;
    let csv = 'Nome,Tipo,Valor,Taxa,Rend Mensal,Vencimento\n';
    state.rf.forEach(i => { csv += `${i.nome},${i.tipo},${i.valor.toFixed(2)},${i.taxa.toFixed(2)},${rfMonthly(i).toFixed(2)},${i.vencimento}\n`; });
    downloadCSV(csv, 'carteira-rendafixa');
});

function downloadCSV(csv, name) {
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name}-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('CSV exportado!');
}

// ─── REFRESH ───
document.getElementById('btnRefresh').addEventListener('click', () => {
    fetchAllQuotes();
    showToast('Atualizando cotações...');
});

// ─── IA DE APORTE ───
document.getElementById('formIA').addEventListener('submit', async e => {
    e.preventDefault();
    const valor = parseFloat(document.getElementById('ia-valor').value);
    const perfil = document.getElementById('ia-perfil').value;
    if (!valor || valor <= 0) return;

    const resultEl = document.getElementById('iaResult');
    resultEl.style.display = 'flex';
    resultEl.innerHTML = `<div class="ia-card"><div class="ia-loading"><span class="loading-spinner"></span><p>Analisando sua carteira e gerando recomendação...</p></div></div>`;

    const claudeKey = getClaudeKey();

    if (claudeKey) {
        await iaWithClaude(valor, perfil, claudeKey, resultEl);
    } else {
        iaLocal(valor, perfil, resultEl);
    }
});

function iaLocal(valor, perfil, resultEl) {
    const fiis = getTotals('fiis');
    const acoes = getTotals('acoes');
    const rfTotal = state.rf.reduce((s, i) => s + i.valor, 0);
    const total = fiis.patrimonio + acoes.patrimonio + rfTotal;

    const targets = {
        conservador: { fiis: 0.40, acoes: 0.15, rf: 0.45 },
        moderado: { fiis: 0.35, acoes: 0.30, rf: 0.35 },
        arrojado: { fiis: 0.25, acoes: 0.50, rf: 0.25 },
    };

    const target = targets[perfil];
    const newTotal = total + valor;

    const currentPcts = {
        fiis: total > 0 ? fiis.patrimonio / total : 0,
        acoes: total > 0 ? acoes.patrimonio / total : 0,
        rf: total > 0 ? rfTotal / total : 0,
    };

    const gaps = {
        fiis: target.fiis - currentPcts.fiis,
        acoes: target.acoes - currentPcts.acoes,
        rf: target.rf - currentPcts.rf,
    };

    const recommendations = [];
    let remaining = valor;

    const sorted = Object.entries(gaps).sort((a, b) => b[1] - a[1]);

    sorted.forEach(([cat, gap]) => {
        if (remaining <= 0) return;
        const idealAdd = Math.max(0, gap * newTotal);
        const amount = Math.min(remaining, idealAdd > 0 ? idealAdd : remaining * target[cat]);
        if (amount > 0) {
            remaining -= amount;
            recommendations.push({ category: cat, amount, gap });
        }
    });

    if (remaining > 0) {
        const biggest = sorted[0][0];
        const existing = recommendations.find(r => r.category === biggest);
        if (existing) existing.amount += remaining;
        else recommendations.push({ category: biggest, amount: remaining, gap: sorted[0][1] });
    }

    const catNames = { fiis: 'Fundos Imobiliários', acoes: 'Ações', rf: 'Renda Fixa' };
    const catColors = { fiis: '#4f8cff', acoes: '#a855f7', rf: '#22c55e' };

    let specificRecs = '';
    recommendations.forEach(rec => {
        if (rec.category === 'rf') {
            specificRecs += `
                <div class="ia-rec-item">
                    <div class="ia-rec-ticker" style="color:${catColors[rec.category]}">Renda Fixa</div>
                    <div class="ia-rec-info"><div class="ia-rec-reason">Aportar em CDBs, LCIs/LCAs ou Tesouro Direto para equilibrar a carteira.</div></div>
                    <div class="ia-rec-value">${fmt(rec.amount)}</div>
                </div>`;
        } else {
            const assets = state[rec.category];
            if (assets.length > 0) {
                const sorted = assets.map(a => ({
                    ticker: a.ticker,
                    dy: getDY(a.ticker),
                    price: state.quotes[a.ticker]?.regularMarketPrice || 0,
                })).sort((a, b) => b.dy - a.dy);

                const top = sorted.slice(0, 3);
                const perAsset = rec.amount / top.length;

                top.forEach(asset => {
                    const cotas = asset.price > 0 ? Math.floor(perAsset / asset.price) : 0;
                    specificRecs += `
                        <div class="ia-rec-item">
                            <div class="ia-rec-ticker">${asset.ticker}</div>
                            <div class="ia-rec-info">
                                <div>DY: ${pct(asset.dy)} · Preço: ${fmt(asset.price)}</div>
                                <div class="ia-rec-reason">${cotas > 0 ? `Comprar ~${cotas} cotas` : 'Melhor DY da categoria'}</div>
                                <div class="ia-rec-bar"><div class="ia-rec-bar-fill" style="width:${Math.min(100, (perAsset / valor) * 100)}%"></div></div>
                            </div>
                            <div class="ia-rec-value">${fmt(perAsset)}</div>
                        </div>`;
                });
            } else {
                specificRecs += `
                    <div class="ia-rec-item">
                        <div class="ia-rec-ticker" style="color:${catColors[rec.category]}">${catNames[rec.category]}</div>
                        <div class="ia-rec-info"><div class="ia-rec-reason">Adicione ativos de ${catNames[rec.category]} para recomendações específicas.</div></div>
                        <div class="ia-rec-value">${fmt(rec.amount)}</div>
                    </div>`;
            }
        }
    });

    const summary = recommendations.map(r =>
        `• ${catNames[r.category]}: ${fmt(r.amount)} (${pct(r.amount / valor * 100)} do aporte)`
    ).join('\n');

    resultEl.innerHTML = `
        <div class="ia-card">
            <h3>Distribuição Recomendada</h3>
            <div class="ia-summary">${summary}\n\nPerfil: ${perfil.charAt(0).toUpperCase() + perfil.slice(1)} · Carteira atual: ${fmt(total)}</div>
        </div>
        <div class="ia-card">
            <h3>Onde Aportar</h3>
            <div class="ia-recommendation">${specificRecs}</div>
        </div>
        <div class="ia-card">
            <h3>Análise</h3>
            <div class="ia-summary">A recomendação prioriza rebalancear sua carteira em direção à alocação ideal para o perfil ${perfil}. Ativos com maior dividend yield foram priorizados dentro de cada classe.\n\nPara recomendações mais detalhadas com análise de mercado, configure sua chave API do Claude nas configurações (engrenagem).</div>
        </div>`;
}

async function iaWithClaude(valor, perfil, apiKey, resultEl) {
    const fiis = getTotals('fiis');
    const acoes = getTotals('acoes');
    const rfTotal = state.rf.reduce((s, i) => s + i.valor, 0);

    const portfolio = {
        fiis: state.fiis.map(a => ({ ticker: a.ticker, qty: a.quantidade, pm: a.precoMedio, price: state.quotes[a.ticker]?.regularMarketPrice || 0, dy: getDY(a.ticker), divMensal: getMonthlyDiv(a.ticker) * a.quantidade })),
        acoes: state.acoes.map(a => ({ ticker: a.ticker, qty: a.quantidade, pm: a.precoMedio, price: state.quotes[a.ticker]?.regularMarketPrice || 0, dy: getDY(a.ticker), divMensal: getMonthlyDiv(a.ticker) * a.quantidade })),
        rf: state.rf.map(i => ({ nome: i.nome, tipo: i.tipo, valor: i.valor, taxa: i.taxa, vencimento: i.vencimento })),
        totais: { fiis: fiis.patrimonio, acoes: acoes.patrimonio, rf: rfTotal, divFiis: fiis.dividendos, divAcoes: acoes.dividendos },
    };

    const prompt = `Você é um consultor financeiro especialista em investimentos brasileiros. Analise a carteira abaixo e recomende onde aportar R$ ${valor.toFixed(2)} considerando o perfil ${perfil}.

CARTEIRA ATUAL:
${JSON.stringify(portfolio, null, 2)}

REGRAS:
1. Considere o perfil de risco: ${perfil}
2. Priorize rebalanceamento da carteira
3. Considere dividend yield dos ativos
4. Sugira ativos específicos da carteira para aporte
5. Se a carteira estiver desequilibrada, priorize a categoria mais defasada
6. Para renda fixa, sugira tipos específicos (CDB, LCI, Tesouro, etc)

Responda em JSON com esta estrutura:
{
  "distribuicao": [{"categoria": "fiis|acoes|rf", "valor": number, "pct": number}],
  "recomendacoes": [{"ticker": "string", "categoria": "fiis|acoes|rf", "valor": number, "cotas": number, "motivo": "string"}],
  "analise": "string com análise geral em 3-4 frases"
}`;

    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        const data = await response.json();

        if (data.error) {
            resultEl.innerHTML = `<div class="ia-card"><p class="negative">Erro da API: ${data.error.message}</p><p class="ia-summary" style="margin-top:1rem">Usando análise local como fallback.</p></div>`;
            setTimeout(() => iaLocal(valor, perfil, resultEl), 1500);
            return;
        }

        const text = data.content[0].text;
        const jsonMatch = text.match(/\{[\s\S]*\}/);

        if (!jsonMatch) {
            iaLocal(valor, perfil, resultEl);
            return;
        }

        const result = JSON.parse(jsonMatch[0]);

        const distHtml = result.distribuicao.map(d => {
            const catNames = { fiis: 'Fundos Imobiliários', acoes: 'Ações', rf: 'Renda Fixa' };
            return `• ${catNames[d.categoria]}: ${fmt(d.valor)} (${pct(d.pct)})`;
        }).join('\n');

        const recsHtml = result.recomendacoes.map(r => `
            <div class="ia-rec-item">
                <div class="ia-rec-ticker">${r.ticker}</div>
                <div class="ia-rec-info">
                    <div class="ia-rec-reason">${r.motivo}</div>
                    ${r.cotas ? `<div style="font-size:0.82rem;margin-top:4px">Comprar ~${r.cotas} cotas</div>` : ''}
                    <div class="ia-rec-bar"><div class="ia-rec-bar-fill" style="width:${Math.min(100, (r.valor / valor) * 100)}%"></div></div>
                </div>
                <div class="ia-rec-value">${fmt(r.valor)}</div>
            </div>
        `).join('');

        resultEl.innerHTML = `
            <div class="ia-card">
                <h3>Distribuição Recomendada (IA)</h3>
                <div class="ia-summary">${distHtml}</div>
            </div>
            <div class="ia-card">
                <h3>Onde Aportar</h3>
                <div class="ia-recommendation">${recsHtml}</div>
            </div>
            <div class="ia-card">
                <h3>Análise da IA</h3>
                <div class="ia-summary">${result.analise}</div>
            </div>`;

    } catch (err) {
        resultEl.innerHTML = `<div class="ia-card"><p class="negative">Erro: ${err.message}</p></div>`;
        setTimeout(() => iaLocal(valor, perfil, resultEl), 1500);
    }
}

// ─── INIT ───
function init() {
    document.getElementById('tokenBanner').style.display = 'none';
    fetchCDI();
    updateAll();
    if (state.fiis.length || state.acoes.length) {
        fetchAllQuotes();
    }
    setInterval(fetchAllQuotes, 5 * 60 * 1000);
}

init();
