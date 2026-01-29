let globalAppDatabase = []; 
let currentReportData = []; 
let uploadedDatabase = null; 
let activeMode = 'global'; 

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS8XqGItjuzPfwUUWRpp0sMAJtaggktH_HFu8ETpfhPGvn4OIkBsHphgrX4nVh79A/pub?output=csv';

// ==========================================
// 1. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ==========================================

function normalizeString(str) {
    return str ? str.toLowerCase().replace(/[^a-zа-я0-9]/g, '').trim() : "";
}

function normalizeUrl(url) {
    if (!url) return "";
    return url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').trim();
}

function formatInput(input, isFloat = false) {
    // Удаляем все символы, кроме цифр и разделителей
    let val = input.value.replace(/[^0-9.,]/g, ''); 
    if (!val) { input.value = ''; return; }
    
    let rawVal = val.replace(',', '.');
    
    if (isFloat) {
        // Оставляем как есть для дробных чисел (ставок)
        input.value = val; 
    } else {
        // Убираем лишние символы для целых чисел
        let cleanNumber = rawVal.replace(/[^0-9]/g, '');
        let number = parseInt(cleanNumber);
        
        // Форматируем число с пробелами-разделителями тысяч
        if (!isNaN(number)) {
            input.value = number.toLocaleString('ru-RU');
        }
    }
}

function getRawNumber(id) {
    const el = document.getElementById(id);
    if (!el || !el.value) return 0;
    let clean = el.value.replace(/\s/g, '').replace(',', '.');
    return parseFloat(clean) || 0;
}

function updateTotalPercent() {
    const percents = Array.from(document.querySelectorAll('.cat-percent'))
                          .map(input => parseFloat(input.value) || 0);
    const sum = percents.reduce((a, b) => a + b, 0);
    const display = document.getElementById('current-total-percent');
    if (display) {
        display.innerText = sum;
        display.style.color = sum > 100 ? "#ef4444" : "var(--text-light)";
    }
    return sum;
}

// ==========================================
// 2. ЗАГРУЗКА БАЗЫ
// ==========================================

async function loadDatabaseFromSheets() {
    try {
        const cacheBuster = `&t=${new Date().getTime()}`;
        const response = await fetch(SHEET_URL + cacheBuster);
        const csvData = await response.text();
        const lines = csvData.split(/\r?\n/).filter(line => line.trim() !== '');
        
        globalAppDatabase = lines.slice(1).map(line => {
            const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => c.replace(/"/g, '').trim());
            let rawOs = (cols[2] || '').toUpperCase();
            let finalOs = (rawOs.includes('IPHONE') || rawOs.includes('IOS') || rawOs.includes('IPAD')) ? 'iOS' : 'Android';
            return {
                name: cols[0] || '',
                normName: normalizeString(cols[0] || ''),
                bundle: cols[1] || '',
                os: finalOs,
                link: cols[3] || '',
                normLink: normalizeUrl(cols[3] || ''),
                category_ru: cols[5] || '',
                auctions: parseFloat(cols[6]) || 1000,
                tier: cols[7] || 'Tier 3', 
                priority: parseFloat(cols[8]) || 1
            };
        });
        document.getElementById('stat-total-apps').innerText = globalAppDatabase.length.toLocaleString('ru-RU');
        updateAllCategorySelects();
    } catch (e) { console.error("Ошибка загрузки базы:", e); }
}

function calculateAppWeight(app) {
    const auctions = parseFloat(app.auctions) || 1000;
    const priority = parseFloat(app.priority) || 1;
    let tierMultiplier = 1.0;
    const t = String(app.tier || '').toLowerCase();
    if (t.includes('1')) tierMultiplier = 3.0; 
    else if (t.includes('2')) tierMultiplier = 1.5;
    return Math.pow(Math.max(auctions, 10), 0.7) * priority * tierMultiplier;
}

// ==========================================
// 3. ОБОГАТИЩЕНИЕ СТРОКИ
// ==========================================

function getEnrichedApp(src, idx) {
    const nLink = normalizeUrl(src.link);
    const nName = normalizeString(src.name);
    let match = globalAppDatabase.find(g => nLink !== "" && g.normLink === nLink);
    if (!match && nName !== "") {
        match = globalAppDatabase.find(g => g.normName === nName);
    }
    if (match) {
        return { ...match, displayName: src.name || match.name, bundle: match.bundle, rowIdx: idx };
    }
    return {
        name: src.name || "App " + (idx + 1),
        displayName: src.name || "App " + (idx + 1),
        bundle: "unknown." + idx,
        os: nLink.includes('apple.com') ? 'iOS' : 'Android',
        link: src.link || "#",
        auctions: 500, priority: 1, tier: 'Tier 3', rowIdx: idx
    };
}

// ==========================================
// 4. ГЕНЕРАЦИЯ ОТЧЕТА
// ==========================================

function generateReport() {
    const totalImps = getRawNumber('total-imps');
    const totalClicks = getRawNumber('total-clicks');
    const totalViews = getRawNumber('total-views');
    const totalBudgetInput = getRawNumber('total-budget');
    const userRate = getRawNumber('bid-rate');
    const selectedOs = document.querySelector('input[name="os-filter"]:checked').value;
    const bidModel = document.getElementById('bid-model').value;
    const minusCategories = Array.from(document.querySelectorAll('.minus-cat-select')).map(s => s.value).filter(v => v !== "");

    if (!totalImps || !totalClicks) return alert("Заполните Показы и Клики");

    let enrichedRows = [];

    // 1. Сбор данных в зависимости от выбранного режима (База или Whitelist)
    if (activeMode === 'global') {
        const rows = Array.from(document.querySelectorAll('.category-row')).map(r => ({
            catRu: r.querySelector('.cat-select').value,
            percent: parseFloat(r.querySelector('.cat-percent').value) || 0
        })).filter(row => row.catRu !== "" && row.percent > 0);

        rows.forEach(row => {
            let apps = globalAppDatabase.filter(a => a.category_ru === row.catRu && 
                       (selectedOs === 'all' || a.os === selectedOs) && 
                       !minusCategories.includes(a.category_ru));
            if (apps.length > 0) {
                let catWeight = apps.reduce((s, a) => s + calculateAppWeight(a), 0);
                apps.forEach(a => {
                    let app = {...a, displayName: a.name};
                    // Рассчитываем базовую долю приложения внутри категории
                    app.baseWeight = (calculateAppWeight(a) / catWeight) * row.percent;
                    enrichedRows.push(app);
                });
            }
        });
    } else {
        let sourceLines = uploadedDatabase || document.getElementById('whitelist').value.split('\n').map(l => {
            let t = l.trim(); if (!t) return null;
            if (t.includes(',')) { 
                let p = t.split(','); return { name: p[0].trim(), link: p.slice(1).join(',').trim() }; 
            }
            return t.match(/^http/) ? { name: "", link: t } : { name: t, link: "" };
        }).filter(x => x);

        enrichedRows = sourceLines.map((src, idx) => getEnrichedApp(src, idx))
                                  .filter(app => (selectedOs === 'all' || app.os === selectedOs));
        
        enrichedRows.forEach(row => {
            row.baseWeight = calculateAppWeight(row);
        });
    }

    if (enrichedRows.length === 0) return alert("Нет данных для отчета");

    // 2. Внедрение рандомизации весов
    // Это гарантирует, что даже приложения с одинаковыми параметрами получат разные показы
    enrichedRows.forEach(row => {
        // Добавляем случайное отклонение $\pm 10\%$ (множитель от 0.9 до 1.1)
        row.randomizedWeight = row.baseWeight * (0.9 + Math.random() * 0.2);
    });

    let totalWeightSum = enrichedRows.reduce((s, a) => s + a.randomizedWeight, 0);
    let runningTotalImps = 0;

    // 3. Распределение общего объема показов пропорционально рандомизированным весам
    enrichedRows.forEach((row, idx) => {
        let imps = (idx === enrichedRows.length - 1) 
            ? (totalImps - runningTotalImps) 
            : Math.round((row.randomizedWeight / totalWeightSum) * totalImps);
        
        row.imps = Math.max(0, imps);
        runningTotalImps += row.imps;
    });

    // 4. Распределение кликов, досмотров и расчет бюджетов
    // Эти функции используют Math.random() внутри для создания реалистичного разброса CTR и VTR
    distributeMetrics(enrichedRows, totalClicks, totalViews, totalImps);
    calculateBudgetsAndRates(enrichedRows, totalBudgetInput, userRate, bidModel);
    
    // 5. Обновление интерфейса таблицы
    updateUI(enrichedRows);
}

function distributeMetrics(data, totalClicks, totalViews, totalImps) {
    let tempClicksSum = 0;
    data.forEach(a => {
        // Увеличен разброс: теперь клики могут отклоняться на 25% в обе стороны
        a.rawClicks = a.imps * (totalClicks / totalImps) * (0.75 + Math.random() * 0.5);
        tempClicksSum += a.rawClicks;
    });
    
    let runningClicks = 0;
    let runningViews = 0;
    
    data.forEach((a, i) => {
        let c = (i === data.length - 1) ? (totalClicks - runningClicks) : Math.round(a.rawClicks * (totalClicks / tempClicksSum));
        a.clicks = Math.min(a.imps, Math.max(0, c));
        runningClicks += a.clicks;
        
        let v = 0;
        if (totalViews > 0) {
            v = (i === data.length - 1) ? (totalViews - runningViews) : Math.round(a.imps * (totalViews / totalImps) * (0.8 + Math.random() * 0.4));
            v = Math.min(a.imps, Math.max(0, v));
            runningViews += v;
        }
        a.views = v;
        // Добавляем знак % сразу в данные для корректного отображения
        a.ctr = a.imps > 0 ? (a.clicks / a.imps * 100).toFixed(2) : "0.00";
        a.vtr = a.imps > 0 ? (a.views / a.imps * 100).toFixed(2) : "0.00";
    });
}

function calculateBudgetsAndRates(data, totalBudgetInput, userRate, bidModel) {
    data.forEach(item => {
        item.targetRate = userRate * (0.95 + Math.random() * 0.1); // Вариация 5% для реалистичности
    });

    let rawTotalBudget = 0;
    data.forEach(item => {
        if (bidModel === 'CPM') item.rawBudget = (item.imps / 1000) * item.targetRate;
        else if (bidModel === 'CPC') item.rawBudget = item.clicks * item.targetRate;
        else if (bidModel === 'CPV') item.rawBudget = item.views * item.targetRate; // Бюджет = Ставка * Досмотры
        rawTotalBudget += item.rawBudget;
    });

    const targetBudget = totalBudgetInput > 0 ? totalBudgetInput : rawTotalBudget;
    const scale = rawTotalBudget > 0 ? (targetBudget / rawTotalBudget) : 0;
    let runningBudget = 0;

    data.forEach((item, idx) => {
        let finalBudget = (idx === data.length - 1) ? (targetBudget - runningBudget) : (item.rawBudget * scale);
        item.rowBudget = Math.max(0, finalBudget);
        runningBudget += item.rowBudget;

        if (bidModel === 'CPM') item.currentRate = item.imps > 0 ? (item.rowBudget / item.imps * 1000) : 0;
        else if (bidModel === 'CPC') item.currentRate = item.clicks > 0 ? (item.rowBudget / item.clicks) : 0;
        else if (bidModel === 'CPV') item.currentRate = item.views > 0 ? (item.rowBudget / item.views) : 0;
    });
}

// ==========================================
// 5. ИНТЕРФЕЙС (ОС УБРАНА ИЗ ТАБЛИЦЫ)
// ==========================================

function updateUI(data) {
    currentReportData = data;
    const tbody = document.querySelector('#app-table tbody');
    data.sort((a, b) => b.imps - a.imps);
    
    tbody.innerHTML = data.map(item => `
        <tr>
            <td><strong>${item.displayName || item.name}</strong><br><small style="color:#64748b">${item.bundle}</small></td>
            <td class="link-cell"><a href="${item.link}" target="_blank">Store Link</a></td>
            <td align="right">${item.imps.toLocaleString('ru-RU')}</td>
            <td align="right">${item.clicks.toLocaleString('ru-RU')}</td>
            <td align="center">${item.ctr}%</td>
            <td class="col-video" align="right">${item.views.toLocaleString('ru-RU')}</td>
            <td class="col-video" align="center">${item.vtr}%</td>
            <td class="col-finance" align="right">${item.currentRate.toFixed(2)}</td>
            <td class="col-finance" align="right"><strong>${item.rowBudget.toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2})}</strong></td>
        </tr>`).join('');

    // Обновление карточек итогов
    const totalImps = data.reduce((s, a) => s + a.imps, 0);
    const totalClicks = data.reduce((s, a) => s + a.clicks, 0);
    const totalBudget = data.reduce((s, a) => s + a.rowBudget, 0);

    document.getElementById('res-imps').innerText = totalImps.toLocaleString('ru-RU');
    document.getElementById('res-clicks').innerText = totalClicks.toLocaleString('ru-RU');
    document.getElementById('res-ctr').innerText = (totalImps > 0 ? (totalClicks / totalImps * 100).toFixed(2) : 0) + '%';
    if (document.getElementById('res-budget')) document.getElementById('res-budget').innerText = totalBudget.toLocaleString('ru-RU', {minimumFractionDigits:2});
    
    toggleColumns();
}

// ==========================================
// 6. УПРАВЛЕНИЕ КАТЕГОРИЯМИ (ВИЗУАЛ)
// ==========================================

function updateAllCategorySelects() {
    const selects = document.querySelectorAll('.cat-select, .minus-cat-select');
    const cats = [...new Set(globalAppDatabase.map(a => a.category_ru))].filter(x => x).sort();
    selects.forEach(s => {
        let val = s.value;
        s.innerHTML = '<option value="">Выбрать...</option>' + cats.map(c => `<option value="${c}" ${c === val ? 'selected' : ''}>${c}</option>`).join('');
    });
}

function addCategoryRow() {
    const div = document.createElement('div');
    div.className = 'category-row';
    div.innerHTML = `
        <div class="row-inputs" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <select class="cat-select" style="flex:1; height:40px;"></select>
            <input type="number" class="cat-percent" placeholder="%" style="width:60px; height:40px; text-align:center;" autocomplete="off">
            <span class="btn-remove" style="cursor:pointer; color:#ef4444; font-size:22px; font-weight:bold; width:24px; text-align:center;" onclick="removeCategoryRow(this)">×</span>
        </div>`;
    document.getElementById('category-container').appendChild(div);
    updateAllCategorySelects();
}

function addMinusCategoryRow() {
    const div = document.createElement('div');
    div.className = 'minus-category-row';
    div.innerHTML = `
        <div class="row-inputs" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
            <select class="minus-cat-select" style="flex:1; height:40px;"></select>
            <span class="btn-remove" style="cursor:pointer; color:#ef4444; font-size:22px; font-weight:bold; width:24px; text-align:center;" onclick="removeCategoryRow(this)">×</span>
        </div>`;
    document.getElementById('minus-category-container').appendChild(div);
    updateAllCategorySelects();
}

function removeCategoryRow(el) {
    el.closest('.category-row, .minus-category-row').remove();
    updateTotalPercent();
}

function setMode(m) { 
    activeMode = m; 
    document.getElementById('btn-global').classList.toggle('active', m === 'global'); 
    document.getElementById('btn-whitelist').classList.toggle('active', m === 'whitelist');
    document.getElementById('global-categories-ui').style.display = m === 'global' ? 'block' : 'none';
    document.getElementById('whitelist-content-section').style.display = m === 'whitelist' ? 'block' : 'none';
}
function toggleColumns() {
    const v = document.getElementById('show-video-stats').checked;
    const f = document.getElementById('show-finance-stats').checked;
    document.querySelectorAll('.col-video').forEach(e => e.style.display = v ? '' : 'none');
    document.querySelectorAll('.col-finance').forEach(e => e.style.display = f ? '' : 'none');
}
function clearWhitelist() { document.getElementById('whitelist').value = ''; uploadedDatabase = null; document.getElementById('upload-status').innerText = ''; }
function resetAll() { location.reload(); }
function reshuffleStats() { generateReport(); }

function exportToExcel() {
    if (currentReportData.length === 0) return alert("Нет данных");
    
    const exportData = currentReportData.map(i => ({ 
        "Приложение": i.displayName || i.name, 
        "Ссылка": i.link, // Добавили колонку со ссылкой
        "Bundle": i.bundle, 
        "Показы": i.imps, 
        "Клики": i.clicks, 
        "CTR": i.ctr + "%", // Добавляем знак процента для наглядности
        "Досмотры": i.views, 
        "VTR": i.vtr + "%",
        "Ставка": (i.currentRate.toFixed(2)).replace('.', ','), 
        "Бюджет": (i.rowBudget.toFixed(2)).replace('.', ',')
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new(); 
    XLSX.utils.book_append_sheet(wb, ws, "Report");
    XLSX.writeFile(wb, `Report_${new Date().toISOString().slice(0,10)}.xlsx`);
}

document.addEventListener('DOMContentLoaded', () => {
    loadDatabaseFromSheets();
    document.addEventListener('input', e => { if (e.target.classList.contains('cat-percent')) updateTotalPercent(); });
    const fileIn = document.getElementById('upload-excel');
    if (fileIn) fileIn.addEventListener('change', e => {
        const reader = new FileReader();
        reader.onload = ev => {
            const wb = XLSX.read(new Uint8Array(ev.target.result), {type:'array'});
            const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1});
            uploadedDatabase = rows.slice(1).map(r => ({ name: String(r[0]||''), link: String(r[1]||'') })).filter(a => a.name || a.link);
            document.getElementById('upload-status').innerText = `Загружено: ${uploadedDatabase.length}`;
        };
        reader.readAsArrayBuffer(e.target.files[0]);
    });
});