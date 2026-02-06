let globalAppDatabase = []; 
let currentReportData = []; 
let uploadedDatabase = null; 
let activeMode = 'global'; 

const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vS8XqGItjuzPfwUUWRpp0sMAJtaggktH_HFu8ETpfhPGvn4OIkBsHphgrX4nVh79A/pub?output=csv';

// 1. ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
function normalizeString(str) {
    return str ? str.toLowerCase().replace(/[^a-zа-я0-9]/g, '').trim() : "";
}

function normalizeUrl(url) {
    if (!url) return "";
    return url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').trim();
}

function formatInput(input) {
    let cursor = input.selectionStart;
    let oldLen = input.value.length;
    // Разрешаем вводить цифры, точки и запятые
    let val = input.value.replace(/[^0-9.,]/g, '').replace(',', '.');
    let parts = val.split('.');
    if (parts.length > 2) val = parts[0] + '.' + parts.slice(1).join('');
    if (!val) { input.value = ''; return; }
    
    let [intPart, decPart] = val.split('.');
    let formattedInt = parseInt(intPart || 0).toLocaleString('ru-RU');
    // Ограничиваем копейки двумя знаками
    input.value = decPart !== undefined ? formattedInt + ',' + decPart.slice(0, 2) : formattedInt;
    
    // Возвращаем курсор на место
    let newLen = input.value.length;
    input.setSelectionRange(cursor + (newLen - oldLen), cursor + (newLen - oldLen));
}

function getRawNumber(id) {
    const el = document.getElementById(id);
    if (!el || !el.value) return 0;
    // Очистка от пробелов и нормализация разделителя
    let clean = el.value.replace(/\s/g, '').replace(/\u00A0/g, '').replace(',', '.');
    return parseFloat(clean) || 0;
}

function updateTotalPercent() {
    const percents = Array.from(document.querySelectorAll('.cat-percent')).map(input => parseFloat(input.value) || 0);
    const sum = percents.reduce((a, b) => a + b, 0);
    const display = document.getElementById('current-total-percent');
    if (display) {
        display.innerText = sum;
        display.style.color = sum > 100 ? "#ef4444" : "var(--text-light)";
    }
    return sum;
}

// 2. ЗАГРУЗКА БАЗЫ
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
                name: cols[0] || '', normName: normalizeString(cols[0] || ''),
                bundle: cols[1] || '', os: finalOs,
                link: cols[3] || '', normLink: normalizeUrl(cols[3] || ''),
                category_ru: cols[5] || '', auctions: parseFloat(cols[6]) || 1000,
                tier: cols[7] || 'Tier 3', priority: parseFloat(cols[8]) || 1
            };
        });
        document.getElementById('stat-total-apps').innerText = globalAppDatabase.length.toLocaleString('ru-RU');
        updateAllCategorySelects();
    } catch (e) { console.error("Ошибка загрузки базы:", e); }
}

function calculateAppWeight(app) {
    const auctions = parseFloat(app.auctions) || 1000;
    const priority = parseFloat(app.priority) || 1;
    let mult = 1.0;
    const t = String(app.tier || '').toLowerCase();
    if (t.includes('1')) mult = 3.0; else if (t.includes('2')) mult = 1.5;
    return Math.pow(Math.max(auctions, 10), 0.7) * priority * mult;
}

function getEnrichedApp(src, idx) {
    const nLink = normalizeUrl(src.link);
    const nName = normalizeString(src.name);
    let match = globalAppDatabase.find(g => nLink !== "" && g.normLink === nLink);
    if (!match && nName !== "") match = globalAppDatabase.find(g => g.normName === nName);
    if (match) return { ...match, displayName: src.name || match.name, bundle: match.bundle, rowIdx: idx };
    return {
        name: src.name || "App " + (idx + 1), displayName: src.name || "App " + (idx + 1),
        bundle: "unknown." + idx, os: nLink.includes('apple.com') ? 'iOS' : 'Android',
        link: src.link || "#", auctions: 500, priority: 1, tier: 'Tier 3', rowIdx: idx
    };
}

// 3. РАСПРЕДЕЛЕНИЕ МЕТРИК (Строго по лимитам)
function distributeMetrics(data, totalClicks, totalViews, totalImps) {
    if (data.length === 0 || totalImps === 0) return;

    const distributeByRate = (metric, targetTotal, variation) => {
        if (targetTotal <= 0) { data.forEach(r => r[metric] = 0); return; }
        
        const avgRate = targetTotal / totalImps;
        let currentTotal = 0;

        // Первый проход: пропорционально со случайным отклонением
        data.forEach(row => {
            // Разный шум для каждой метрики предотвращает "дублирование" чисел
            let noise = (1 - variation) + (Math.random() * variation * 2);
            let val = Math.floor(row.imps * avgRate * noise);
            
            // Гарантируем минимум 1, если есть показы и лимит позволяет
            if (val === 0 && row.imps > 0 && targetTotal > data.length) val = 1;
            
            // Не даем досмотрам сравняться с показами (макс 98% от imps), 
            // если только средний VTR не выше 95%
            let cap = (avgRate < 0.95) ? Math.floor(row.imps * 0.98) : row.imps;
            row[metric] = Math.min(cap, val);
            currentTotal += row[metric];
        });

        // БАЛАНСИРОВКА ОСТАТКА (Случайное раскидывание единиц)
        let diff = targetTotal - currentTotal;
        let rows = [...data];
        
        // Цикл работает, пока diff не станет 0 (гарантия идентичности цифр)
        while (diff !== 0) {
            // Перемешиваем массив для рандомного распределения
            rows.sort(() => Math.random() - 0.5);
            let changed = false;
            
            for (let r of rows) {
                if (diff > 0 && r[metric] < r.imps) {
                    r[metric]++; diff--; changed = true;
                } else if (diff < 0 && r[metric] > 0) {
                    // Для VTR не убираем последнюю единицу, если есть показы
                    if (metric === 'views' && r.imps > 0 && r[metric] <= 1) continue;
                    r[metric]--; diff++; changed = true;
                }
                if (diff === 0) break;
            }
            if (!changed) break; // Защита от бесконечного цикла
        }
    };

    // Клики и досмотры теперь распределяются абсолютно независимо
    distributeByRate('clicks', totalClicks, 0.35); 
    distributeByRate('views', totalViews, 0.12);

    data.forEach(a => {
        a.ctr = a.imps > 0 ? (a.clicks / a.imps * 100).toFixed(2) : "0.00";
        a.vtr = a.imps > 0 ? (a.views / a.imps * 100).toFixed(2) : "0.00";
    });
}

// 4. ГЕНЕРАЦИЯ ОТЧЕТА И БЮДЖЕТА
function calculateBudgetsAndRates(data, totalBudgetInput, userRate, bidModel) {
    if (data.length === 0) return;
    const targetCoins = Math.round(totalBudgetInput * 100);
    let rawTotal = 0;
    
    data.forEach(item => {
        const rateNoise = userRate * (0.98 + Math.random() * 0.04);
        if (bidModel === 'CPM') item.raw = (item.imps / 1000) * rateNoise;
        else if (bidModel === 'CPC') item.raw = item.clicks * rateNoise;
        else if (bidModel === 'CPV') item.raw = item.views * rateNoise;
        rawTotal += item.raw;
    });

    const scale = rawTotal > 0 ? (totalBudgetInput / rawTotal) : 0;
    let allocatedCoins = 0;

    data.forEach((item, idx) => {
        if (idx === data.length - 1) {
            // Весь остаток до копейки уходит в последнюю строку
            item.rowBudget = (targetCoins - allocatedCoins) / 100;
        } else {
            let coins = Math.round(item.raw * scale * 100);
            item.rowBudget = coins / 100;
            allocatedCoins += coins;
        }
        
        // Пересчитываем ставки для UI
        if (bidModel === 'CPM') item.currentRate = item.imps > 0 ? (item.rowBudget / item.imps * 1000) : userRate;
        else if (bidModel === 'CPC') item.currentRate = item.clicks > 0 ? (item.rowBudget / item.clicks) : userRate;
        else if (bidModel === 'CPV') item.currentRate = item.views > 0 ? (item.rowBudget / item.views) : userRate;
    });
}

function generateReport() {
    const totalImps = getRawNumber('total-imps');
    const totalClicks = getRawNumber('total-clicks');
    const totalViews = getRawNumber('total-views');
    const totalBudgetInput = getRawNumber('total-budget');
    const userRate = getRawNumber('bid-rate');
    
    const selectedOs = document.querySelector('input[name="os-filter"]:checked').value;
    const bidModel = document.getElementById('bid-model').value;
    const minusCategories = Array.from(document.querySelectorAll('.minus-cat-select'))
                                 .map(s => s.value)
                                 .filter(v => v !== "");

    // --- НОВЫЙ БЛОК: Считывание Blacklist ---
    const blacklistInput = document.getElementById('blacklist').value;
    const blacklistBundles = blacklistInput.split(/[\n,]+/)
                                            .map(b => b.trim())
                                            .filter(b => b !== "");
    // ----------------------------------------

    if (totalImps <= 0) return alert("Показы должны быть больше нуля");
    if (!totalClicks && totalClicks !== 0) return alert("Заполните количество кликов");

    let enrichedRows = [];

    if (activeMode === 'global') {
        const rows = Array.from(document.querySelectorAll('.category-row')).map(r => ({
            catRu: r.querySelector('.cat-select').value,
            percent: parseFloat(r.querySelector('.cat-percent').value) || 0
        })).filter(row => row.catRu !== "" && row.percent > 0);

        rows.forEach(row => {
            let apps = globalAppDatabase.filter(a => 
                a.category_ru === row.catRu && 
                (selectedOs === 'all' || a.os === selectedOs) && 
                !minusCategories.includes(a.category_ru) &&
                !blacklistBundles.includes(a.bundle) // Исключаем по Blacklist
            );
            if (apps.length > 0) {
                let catWeight = apps.reduce((s, a) => s + calculateAppWeight(a), 0);
                apps.forEach(a => {
                    let app = {...a, displayName: a.name};
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
                                  .filter(app => 
                                      (selectedOs === 'all' || app.os === selectedOs) &&
                                      !blacklistBundles.includes(app.bundle) // Исключаем по Blacklist
                                  );
        
        enrichedRows.forEach(row => { row.baseWeight = calculateAppWeight(row); });
    }

    if (enrichedRows.length === 0) return alert("Нет данных для отчета (возможно, все приложения в Blacklist)");

    // Дальнейшая логика рандомизации, распределения и UI остается прежней...
    enrichedRows.forEach(row => { row.randomizedWeight = row.baseWeight * (0.9 + Math.random() * 0.2); });
    let totalWeightSum = enrichedRows.reduce((s, a) => s + a.randomizedWeight, 0);
    let runningImps = 0;

    enrichedRows.forEach((row, idx) => {
        let imps = (idx === enrichedRows.length - 1) ? (totalImps - runningImps) : Math.round((row.randomizedWeight / totalWeightSum) * totalImps);
        row.imps = Math.max(0, imps);
        runningImps += row.imps;
    });

    distributeMetrics(enrichedRows, totalClicks, totalViews, totalImps);
    calculateBudgetsAndRates(enrichedRows, totalBudgetInput, userRate, bidModel);
    updateUI(enrichedRows);
}

// 5. ИНТЕРФЕЙС И ЭКСПОРТ
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
            <td class="col-finance" align="right"><strong>${item.rowBudget.toLocaleString('ru-RU', {minimumFractionDigits:2})}</strong></td>
        </tr>`).join('');
    
    document.getElementById('res-imps').innerText = data.reduce((s, a) => s + a.imps, 0).toLocaleString('ru-RU');
    document.getElementById('res-clicks').innerText = data.reduce((s, a) => s + a.clicks, 0).toLocaleString('ru-RU');
    document.getElementById('res-ctr').innerText = (data.reduce((s, a) => s + a.imps, 0) > 0 ? (data.reduce((s, a) => s + a.clicks, 0) / data.reduce((s, a) => s + a.imps, 0) * 100).toFixed(2) : 0) + '%';
    if (document.getElementById('res-budget')) document.getElementById('res-budget').innerText = data.reduce((s, a) => s + a.rowBudget, 0).toLocaleString('ru-RU', {minimumFractionDigits:2});
    toggleColumns();
}

function exportToExcel() {
    if (currentReportData.length === 0) return alert("Нет данных");
    const exportData = currentReportData.map(i => ({ 
        "Приложение": i.displayName || i.name, "Ссылка": i.link, 
        "Показы": i.imps, "Клики": i.clicks, 
        "CTR": parseFloat((parseFloat(i.ctr) / 100).toFixed(4)),
        "Досмотры": i.views, "VTR": parseFloat((parseFloat(i.vtr) / 100).toFixed(4)),
        "Ставка": parseFloat(i.currentRate.toFixed(2)), "Бюджет": parseFloat(i.rowBudget.toFixed(2))
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r + 1; R <= range.e.r; ++R) {
        if (ws[XLSX.utils.encode_cell({r: R, c: 4})]) ws[XLSX.utils.encode_cell({r: R, c: 4})].z = '0.00%';
        if (ws[XLSX.utils.encode_cell({r: R, c: 6})]) ws[XLSX.utils.encode_cell({r: R, c: 6})].z = '0.00%';
        if (ws[XLSX.utils.encode_cell({r: R, c: 7})]) ws[XLSX.utils.encode_cell({r: R, c: 7})].z = '#,##0.00';
        if (ws[XLSX.utils.encode_cell({r: R, c: 8})]) ws[XLSX.utils.encode_cell({r: R, c: 8})].z = '#,##0.00';
    }
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Report");
    XLSX.writeFile(wb, `Report_${new Date().toISOString().slice(0,10)}.xlsx`);
}

function updateAllCategorySelects() {
    const cats = [...new Set(globalAppDatabase.map(a => a.category_ru))].filter(x => x).sort();
    document.querySelectorAll('.cat-select, .minus-cat-select').forEach(s => {
        let val = s.value;
        s.innerHTML = '<option value="">Выбрать...</option>' + cats.map(c => `<option value="${c}" ${c === val ? 'selected' : ''}>${c}</option>`).join('');
    });
}

function addCategoryRow() {
    const div = document.createElement('div'); div.className = 'category-row';
    div.innerHTML = `<div class="row-inputs" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;"><select class="cat-select" style="flex:1; height:40px;"></select><input type="number" class="cat-percent" placeholder="%" style="width:60px; height:40px; text-align:center;" autocomplete="off"><span class="btn-remove" style="cursor:pointer; color:#ef4444; font-size:22px; font-weight:bold;" onclick="removeCategoryRow(this)">×</span></div>`;
    document.getElementById('category-container').appendChild(div);
    updateAllCategorySelects();
}

function addMinusCategoryRow() {
    const div = document.createElement('div'); div.className = 'minus-category-row';
    div.innerHTML = `<div class="row-inputs" style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;"><select class="minus-cat-select" style="flex:1; height:40px;"></select><span class="btn-remove" style="cursor:pointer; color:#ef4444; font-size:22px; font-weight:bold;" onclick="removeCategoryRow(this)">×</span></div>`;
    document.getElementById('minus-category-container').appendChild(div);
    updateAllCategorySelects();
}

function removeCategoryRow(el) { el.closest('.category-row, .minus-category-row').remove(); updateTotalPercent(); }
function setMode(m) { activeMode = m; document.getElementById('btn-global').classList.toggle('active', m === 'global'); document.getElementById('btn-whitelist').classList.toggle('active', m === 'whitelist'); document.getElementById('global-categories-ui').style.display = m === 'global' ? 'block' : 'none'; document.getElementById('whitelist-content-section').style.display = m === 'whitelist' ? 'block' : 'none'; }
function toggleColumns() { const v = document.getElementById('show-video-stats').checked; const f = document.getElementById('show-finance-stats').checked; document.querySelectorAll('.col-video').forEach(e => e.style.display = v ? '' : 'none'); document.querySelectorAll('.col-finance').forEach(e => e.style.display = f ? '' : 'none'); }
function clearWhitelist() { document.getElementById('whitelist').value = ''; uploadedDatabase = null; document.getElementById('upload-status').innerText = ''; }
function resetAll() { location.reload(); }
function reshuffleStats() { generateReport(); }

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