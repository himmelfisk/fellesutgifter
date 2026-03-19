/* ================================================
   KONFIGURASJON
   ================================================ */
var GOOGLE_CLIENT_ID = '10152340554-g0bdlarlbf8tr4ldn31foq79uh0feqn8.apps.googleusercontent.com';
var GITHUB_REPO = 'himmelfisk/fellesutgifter';
var GITHUB_DATA_DIR = 'data';
var ADDRESSES_FILE = 'data/addresses.json';
var WORKER_URL = 'https://fellesutgifter-proxy.k-a-lorgen.workers.dev';
var MAX_IMAGE_PX = 1200;
var IMAGE_QUALITY = 0.7;

/* ================================================
   STATE
   ================================================ */
var currentUser = null;
var isAdmin = false;
var activeTab = null;
var activeAddressId = null;

var fileShas = {};
var allAddresses = [];       // [{id, name}]
var addressConfig = {};      // {address, admins, units, years}
var yearDataCache = {};      // {"2026": {costs:[...]}}
var formCosts = [];          // [{desc, amount, invoice}]  — in-memory form state
var ocrTargetIdx = -1;       // which cost row is being OCR'd
var googleIdToken = null;    // Google credential for worker auth
var editingYear = null;      // year being edited (locks year input)

/* ================================================
   AUTHENTICATION
   ================================================ */
function decodeJwt(token) {
    var payload = token.split('.')[1];
    var decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
}

function handleCredentialResponse(response) {
    googleIdToken = response.credential;
    var info = decodeJwt(response.credential);
    loginAs(info.email, info.name || info.email);
}

function loginAs(email, name) {
    currentUser = { email: email.toLowerCase().trim(), name: name || email };
    document.getElementById('login-overlay').style.display = 'none';
    document.getElementById('main-content').style.display = 'block';
    document.getElementById('user-info').textContent = currentUser.name;
    loadAddresses();
}

function devLogin() {
    var email = document.getElementById('dev-email').value.trim();
    var name = document.getElementById('dev-name').value.trim();
    if (!email) { alert('Skriv inn en e-postadresse.'); return; }
    loginAs(email, name || email);
}

function logout() {
    currentUser = null;
    isAdmin = false;
    activeAddressId = null;
    activeTab = null;
    addressConfig = {};
    yearDataCache = {};
    formCosts = [];
    allAddresses = [];
    document.getElementById('login-overlay').style.display = 'flex';
    document.getElementById('main-content').style.display = 'none';
    document.getElementById('form-card').style.display = 'none';
}

/* ================================================
   GOOGLE SIGN-IN
   ================================================ */
function initGoogleSignIn() {
    if (typeof google !== 'undefined' && google.accounts) {
        google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: handleCredentialResponse
        });
        google.accounts.id.renderButton(
            document.getElementById('google-signin-btn'),
            { theme: 'outline', size: 'large', text: 'signin_with', locale: 'no' }
        );
    } else {
        document.getElementById('dev-login').style.display = 'block';
    }
}

window.addEventListener('load', function() {
    document.getElementById('inp-year').value = new Date().getFullYear();
    setTimeout(initGoogleSignIn, 500);
});

/* ================================================
   GITHUB API
   ================================================ */
function setSyncStatus(type, text) {
    var el = document.getElementById('sync-status');
    el.className = 'sync-status sync-' + type;
    el.textContent = text;
}

function ghReadFile(path) {
    return fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + path, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store'
    })
    .then(function(res) {
        if (res.status === 404) return null;
        if (!res.ok) throw new Error('GitHub read failed: ' + res.status);
        return res.json();
    })
    .then(function(file) {
        if (!file) return null;
        fileShas[path] = file.sha;
        var raw = atob(file.content.replace(/\n/g, ''));
        return JSON.parse(raw);
    });
}

function ghWriteFile(path, data) {
    if (!googleIdToken) {
        alert('Du m\u00e5 v\u00e6re logget inn med Google for \u00e5 lagre.');
        return Promise.reject('not authenticated');
    }
    var body = {
        action: 'write',
        path: path,
        data: data,
        sha: fileShas[path] || null,
        message: 'Oppdater ' + path + ' ' + new Date().toISOString()
    };
    return fetch(WORKER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + googleIdToken
        },
        body: JSON.stringify(body)
    })
    .then(function(res) {
        if (res.status === 401) {
            return res.json().then(function(e) {
                if (window.__debugWorker) console.error('Worker 401:', e);
                throw new Error('Innlogging utl\u00f8pt. Logg inn p\u00e5 nytt.');
            });
        }
        if (res.status === 403) throw new Error('Du er ikke autorisert som administrator.');
        if (!res.ok) return res.json().then(function(e) { throw new Error(e.error || 'Lagring feilet'); });
        return res.json();
    })
    .then(function(result) {
        if (result && result.sha) fileShas[path] = result.sha;
    });
}

function ghDeleteFile(path) {
    if (!googleIdToken) return Promise.reject('not authenticated');
    if (!fileShas[path]) return Promise.resolve();
    return fetch(WORKER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + googleIdToken
        },
        body: JSON.stringify({ action: 'delete', path: path, sha: fileShas[path] })
    }).then(function(res) {
        if (res.ok) delete fileShas[path];
    });
}

/* ================================================
   ADDRESS MANAGEMENT
   ================================================ */
function generateId() {
    var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var id = '';
    for (var i = 0; i < 8; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
}

function configFilePath(id) {
    return GITHUB_DATA_DIR + '/' + id + '.json';
}

function yearFilePath(id, year) {
    return GITHUB_DATA_DIR + '/' + id + '-' + year + '.json';
}

function loadAddresses() {
    setSyncStatus('loading', 'Henter adresser...');
    ghReadFile(ADDRESSES_FILE)
    .then(function(data) {
        allAddresses = data || [];
        setSyncStatus('ok', 'Synkronisert');
        afterAddressesLoaded();
    })
    .catch(function() {
        allAddresses = [];
        setSyncStatus('err', 'Offline-modus');
        afterAddressesLoaded();
    });
}

function afterAddressesLoaded() {
    if (allAddresses.length === 0) {
        isAdmin = true;
        activeAddressId = null;
        addressConfig = {};
        yearDataCache = {};
        updateUI();
        render();
        return;
    }
    var savedId = sessionStorage.getItem('fellesutgifter_active_addr');
    if (savedId && allAddresses.some(function(a) { return a.id === savedId; })) {
        selectAddress(savedId);
    } else {
        selectAddress(allAddresses[0].id);
    }
}

function selectAddress(id) {
    activeAddressId = id;
    sessionStorage.setItem('fellesutgifter_active_addr', id);
    activeTab = null;
    yearDataCache = {};
    loadAddressConfig(id);
}

function loadAddressConfig(id) {
    setSyncStatus('loading', 'Henter data...');
    ghReadFile(configFilePath(id))
    .then(function(data) {
        addressConfig = data || {};
        setSyncStatus('ok', 'Synkronisert');
        updateAdminState();
        updateUI();
        renderAfterConfigLoad();
    })
    .catch(function() {
        addressConfig = {};
        setSyncStatus('err', 'Offline-modus');
        updateAdminState();
        updateUI();
        render();
    });
}

function renderAfterConfigLoad() {
    var years = addressConfig.years || [];
    if (years.length === 0) {
        render();
        return;
    }
    var target = activeTab && years.indexOf(activeTab) !== -1 ? activeTab : years[years.length - 1];
    activeTab = target;
    loadYearData(target, function() { render(); });
}

function saveAddressConfig() {
    if (!activeAddressId) return Promise.reject('no address');
    return ghWriteFile(configFilePath(activeAddressId), addressConfig);
}

function loadYearData(year, cb) {
    if (yearDataCache[year]) { if (cb) cb(); return; }
    ghReadFile(yearFilePath(activeAddressId, year))
    .then(function(data) {
        yearDataCache[year] = data || { costs: [] };
        if (cb) cb();
    })
    .catch(function() {
        yearDataCache[year] = { costs: [] };
        if (cb) cb();
    });
}

function saveYearData(year) {
    if (!activeAddressId) return Promise.reject('no address');
    var data = yearDataCache[year];
    if (!data) return Promise.reject('no year data');
    return ghWriteFile(yearFilePath(activeAddressId, year), data);
}

function saveAddressesIndex() {
    return ghWriteFile(ADDRESSES_FILE, allAddresses)
    .catch(function(err) { if (window.__debugWorker) console.error('Feil ved lagring av adresseindeks:', err); });
}

/* ================================================
   UI STATE
   ================================================ */
function updateAdminState() {
    if (!currentUser) return;
    var admins = addressConfig.admins;
    if (!admins || admins.length === 0) {
        isAdmin = true;
    } else {
        isAdmin = admins.indexOf(currentUser.email) !== -1;
    }
}

function updateUI() {
    var adminBtn = document.getElementById('admin-btn');
    var addrEl = document.getElementById('address-display');
    var pickerEl = document.getElementById('address-picker');

    if (isAdmin || allAddresses.length === 0) {
        adminBtn.style.display = 'inline-block';
        adminBtn.className = 'btn-admin';
    } else {
        adminBtn.style.display = 'none';
        document.getElementById('form-card').style.display = 'none';
    }

    if (addressConfig.address) {
        addrEl.textContent = '\u2014 ' + addressConfig.address;
    } else {
        addrEl.textContent = '';
    }

    if (allAddresses.length > 1) {
        var html = '<select id="address-select" onchange="onAddressChange(this.value)">';
        for (var i = 0; i < allAddresses.length; i++) {
            var sel = allAddresses[i].id === activeAddressId ? ' selected' : '';
            html += '<option value="' + allAddresses[i].id + '"' + sel + '>' + escapeHtml(allAddresses[i].name) + '</option>';
        }
        html += '</select>';
        pickerEl.innerHTML = html;
        pickerEl.style.display = 'inline-block';
    } else {
        pickerEl.style.display = 'none';
    }

    // Populate setup form
    document.getElementById('cfg-address').value = addressConfig.address || '';
    renderAdminRows();
    renderUnitsTable();
}

function onAddressChange(id) {
    selectAddress(id);
}

/* ================================================
   FORMAT HELPERS
   ================================================ */
function fmt(n) {
    return n.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
    return n.toFixed(2).replace('.', ',') + ' %';
}

function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* ================================================
   DYNAMIC FORM — ADMIN EMAILS
   ================================================ */
function getAdminList() {
    var admins = addressConfig.admins || [];
    if (admins.length === 0 && currentUser) return [currentUser.email];
    return admins.slice();
}

function renderAdminRows() {
    var container = document.getElementById('admin-emails-body');
    var admins = getAdminList();
    var html = '';
    for (var i = 0; i < admins.length; i++) {
        html += '<div class="admin-row" data-idx="' + i + '">'
            + '<input type="email" class="admin-email-input" value="' + escapeAttr(admins[i]) + '" placeholder="e-post@eksempel.no">'
            + '<button class="btn-remove" onclick="removeAdmin(' + i + ')" title="Fjern">&times;</button>'
            + '</div>';
    }
    container.innerHTML = html;
}

function addAdmin() {
    collectAdminsFromForm();
    var admins = getAdminList();
    admins.push('');
    addressConfig.admins = admins;
    renderAdminRows();
    // Focus the new empty input
    var inputs = document.querySelectorAll('.admin-email-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
}

function removeAdmin(idx) {
    collectAdminsFromForm();
    var admins = getAdminList();
    if (admins.length <= 1) { alert('Du m\u00e5 ha minst \u00e9n administrator.'); return; }
    admins.splice(idx, 1);
    addressConfig.admins = admins;
    renderAdminRows();
}

function collectAdminsFromForm() {
    var inputs = document.querySelectorAll('.admin-email-input');
    var admins = [];
    for (var i = 0; i < inputs.length; i++) {
        var v = inputs[i].value.trim().toLowerCase();
        if (v) admins.push(v);
    }
    addressConfig.admins = admins;
    return admins;
}

/* ================================================
   DYNAMIC FORM — UNITS
   ================================================ */
function getUnits() {
    return (addressConfig.units || []).slice();
}

function setUnitsInConfig(units) {
    addressConfig.units = units;
}

function renderUnitsTable() {
    var tbody = document.getElementById('units-body');
    var units = getUnits();
    var html = '';
    for (var i = 0; i < units.length; i++) {
        var u = units[i];
        html += '<tr>'
            + '<td><input type="text" class="unit-code" data-idx="' + i + '" value="' + escapeAttr(u.code) + '" placeholder="Enhet"></td>'
            + '<td><input type="text" class="unit-name" data-idx="' + i + '" value="' + escapeAttr(u.name) + '" placeholder="Navn"></td>'
            + '<td><input type="number" class="unit-pct" data-idx="' + i + '" value="' + u.pct + '" step="0.01" min="0" max="100"></td>'
            + '<td><input type="email" class="unit-email" data-idx="' + i + '" value="' + escapeAttr(u.email || '') + '" placeholder="e-post"></td>'
            + '<td><button class="btn-remove" onclick="removeUnit(' + i + ')" title="Fjern">&times;</button></td>'
            + '</tr>';
    }
    tbody.innerHTML = html;
}

function addUnit() {
    collectUnitsFromForm();
    var units = getUnits();
    units.push({ code: '', name: '', pct: 0, email: '' });
    setUnitsInConfig(units);
    renderUnitsTable();
}

function removeUnit(idx) {
    collectUnitsFromForm();
    var units = getUnits();
    if (units.length <= 1) { alert('Du m\u00e5 ha minst \u00e9n enhet.'); return; }
    units.splice(idx, 1);
    setUnitsInConfig(units);
    renderUnitsTable();
}

function collectUnitsFromForm() {
    var rows = document.querySelectorAll('#units-body tr');
    var units = [];
    for (var i = 0; i < rows.length; i++) {
        var code = rows[i].querySelector('.unit-code').value.trim();
        var name = rows[i].querySelector('.unit-name').value.trim();
        var pct = parseFloat(rows[i].querySelector('.unit-pct').value) || 0;
        var email = rows[i].querySelector('.unit-email').value.trim().toLowerCase();
        units.push({ code: code, name: name, pct: pct, email: email || '' });
    }
    setUnitsInConfig(units);
    return units;
}

/* ================================================
   DYNAMIC FORM — COSTS (with invoice upload)
   ================================================ */
function syncFormCostsFromDOM() {
    var rows = document.querySelectorAll('.cost-row');
    for (var i = 0; i < rows.length && i < formCosts.length; i++) {
        formCosts[i].desc = rows[i].querySelector('.cost-desc').value;
        formCosts[i].amount = parseFloat(rows[i].querySelector('.cost-amount').value) || 0;
    }
}

function renderCostsForm() {
    var container = document.getElementById('costs-body');
    var html = '';
    for (var i = 0; i < formCosts.length; i++) {
        var c = formCosts[i];
        var hasInv = c.invoice ? true : false;
        html += '<div class="cost-row" data-idx="' + i + '">'
            + '<input type="text" class="cost-desc" value="' + escapeAttr(c.desc) + '" placeholder="Beskrivelse">'
            + '<input type="number" class="cost-amount" value="' + (c.amount || '') + '" placeholder="0" step="any">'
            + '<div class="cost-actions">';
        if (hasInv) {
            html += '<img src="' + c.invoice + '" class="invoice-thumb" onclick="viewInvoice(' + i + ')" title="Vis faktura">'
                + '<button class="btn-inv-remove" onclick="removeInvoice(' + i + ')" title="Fjern faktura">&times;</button>';
        } else {
            html += '<button class="btn-inv-upload" onclick="triggerInvoiceUpload(' + i + ')" title="Last opp faktura">\ud83d\udcce</button>';
        }
        html += '<button class="btn-remove" onclick="removeCost(' + i + ')" title="Fjern kostnad">&times;</button>'
            + '</div></div>';
    }
    container.innerHTML = html;
}

function addCost() {
    syncFormCostsFromDOM();
    formCosts.push({ desc: '', amount: 0, invoice: null });
    renderCostsForm();
}

function removeCost(idx) {
    syncFormCostsFromDOM();
    formCosts.splice(idx, 1);
    renderCostsForm();
}

function removeInvoice(idx) {
    syncFormCostsFromDOM();
    formCosts[idx].invoice = null;
    renderCostsForm();
}

function viewInvoice(idx) {
    if (!formCosts[idx] || !formCosts[idx].invoice) return;
    var win = window.open('', '_blank', 'width=900,height=700');
    win.document.write('<!DOCTYPE html><html><head><title>Faktura</title>'
        + '<style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#333;}'
        + 'img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body>'
        + '<img src="' + formCosts[idx].invoice + '"></body></html>');
    win.document.close();
}

function viewInvoiceData(dataUrl) {
    var win = window.open('', '_blank', 'width=900,height=700');
    win.document.write('<!DOCTYPE html><html><head><title>Faktura</title>'
        + '<style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#333;}'
        + 'img{max-width:100%;max-height:100vh;object-fit:contain;}</style></head><body>'
        + '<img src="' + dataUrl + '"></body></html>');
    win.document.close();
}

function triggerInvoiceUpload(idx) {
    ocrTargetIdx = idx;
    document.getElementById('cost-invoice-input').click();
}

function handleCostInvoiceFile(input) {
    var file = input.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        alert('Vennligst last opp et bilde (JPG, PNG, etc.).');
        return;
    }
    syncFormCostsFromDOM();
    var idx = ocrTargetIdx;
    var reader = new FileReader();
    reader.onload = function(e) {
        compressImage(e.target.result, MAX_IMAGE_PX, IMAGE_QUALITY, function(compressed) {
            if (idx >= 0 && idx < formCosts.length) {
                formCosts[idx].invoice = compressed;
                renderCostsForm();
                runOCRForCost(compressed, idx);
            }
        });
    };
    reader.readAsDataURL(file);
    input.value = '';
}

/* ================================================
   IMAGE COMPRESSION
   ================================================ */
function compressImage(dataUrl, maxSize, quality, callback) {
    var img = new Image();
    img.onload = function() {
        var w = img.width, h = img.height;
        if (w > maxSize || h > maxSize) {
            if (w > h) { h = Math.round(h * maxSize / w); w = maxSize; }
            else { w = Math.round(w * maxSize / h); h = maxSize; }
        }
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        callback(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUrl;
}

/* ================================================
   OCR
   ================================================ */
function runOCRForCost(imageData, costIdx) {
    var progressEl = document.getElementById('ocr-progress');
    var fillEl = document.getElementById('ocr-progress-fill');
    var statusEl = document.getElementById('ocr-status');

    if (typeof Tesseract === 'undefined') return;

    progressEl.style.display = 'block';
    fillEl.style.width = '0%';
    statusEl.textContent = 'Analyserer faktura...';

    Tesseract.recognize(imageData, 'nor', {
        logger: function(m) {
            if (m.status === 'recognizing text') {
                var pct = Math.round((m.progress || 0) * 100);
                fillEl.style.width = pct + '%';
                statusEl.textContent = 'Analyserer tekst... ' + pct + '%';
            } else if (m.status === 'loading language traineddata') {
                fillEl.style.width = (Math.round((m.progress || 0) * 100) * 0.5) + '%';
                statusEl.textContent = 'Laster norsk spr\u00e5kdata...';
            }
        }
    })
    .then(function(result) {
        fillEl.style.width = '100%';
        statusEl.textContent = 'Ferdig!';
        setTimeout(function() { progressEl.style.display = 'none'; }, 1500);

        var text = result.data.text;
        var amounts = parseAmounts(text);
        var total = findTotalAmount(text, amounts);

        if (total && costIdx >= 0 && costIdx < formCosts.length) {
            formCosts[costIdx].amount = total.value;
            // Also try to auto-fill description from invoice classification
            if (!formCosts[costIdx].desc) {
                var cat = classifyInvoice(text);
                if (cat) formCosts[costIdx].desc = cat.label;
            }
            renderCostsForm();
        }
    })
    .catch(function(err) {
        statusEl.textContent = 'OCR feilet: ' + err.message;
        setTimeout(function() { progressEl.style.display = 'none'; }, 3000);
    });
}

function parseAmounts(text) {
    var results = [];
    var regex = /(\d{1,3}(?:[\s.\u00a0]\d{3})*,\d{2})/g;
    var match;
    while ((match = regex.exec(text)) !== null) {
        var numStr = match[1].replace(/[\s.\u00a0]/g, '').replace(',', '.');
        var val = parseFloat(numStr);
        if (val > 0 && val < 100000000) results.push({ value: val, index: match.index, raw: match[0] });
    }
    return results;
}

function classifyInvoice(text) {
    if (/\bif\b.*forsikring|skadeforsikring|if\s+skade|forsikringspremie|if\s+n[o\u00f8]rge/i.test(text))
        return { label: 'IF (forsikring)' };
    if (/kommune|kommunale\s*avgifter|eiendomsskatt|vann.*avl[o\u00f8]p|renovasjon|feiing/i.test(text))
        return { label: 'Kommunale avgifter' };
    if (/anticimex|skadedyr/i.test(text))
        return { label: 'Anticimex' };
    return null;
}

function findTotalAmount(text, amounts) {
    if (amounts.length === 0) return null;
    var lower = text.toLowerCase();
    var kws = ['totalt', 'total', '\u00e5 betale', 'a betale', 'sum', 'bel\u00f8p', 'netto'];
    for (var k = 0; k < kws.length; k++) {
        var idx = lower.indexOf(kws[k]);
        if (idx === -1) continue;
        var best = null;
        for (var a = 0; a < amounts.length; a++) {
            var dist = amounts[a].index - idx;
            if (dist > -20 && dist < 150) {
                if (!best || amounts[a].value > best.value) best = amounts[a];
            }
        }
        if (best) return best;
    }
    var largest = amounts[0];
    for (var i = 1; i < amounts.length; i++) {
        if (amounts[i].value > largest.value) largest = amounts[i];
    }
    return largest;
}

/* ================================================
   UNIT HELPERS
   ================================================ */
function getUnitsForDisplay() {
    var units = getUnits();
    if (units.length === 0) return [];
    var result = [];
    for (var i = 0; i < units.length; i++) {
        result.push({ code: units[i].code, name: units[i].name || units[i].code, pct: units[i].pct });
    }
    return result;
}

/* ================================================
   FORM ACTIONS
   ================================================ */
function toggleForm() {
    var card = document.getElementById('form-card');
    var show = card.style.display === 'none';
    card.style.display = show ? 'block' : 'none';
    if (show) updateFormButtons();
}

function saveSetup() {
    // Legacy — now called from saveAll
    return _saveSetupInner();
}

function _saveSetupInner() {
    var address = document.getElementById('cfg-address').value.trim();
    if (!address) { alert('Vennligst fyll inn en adresse.'); return null; }

    var admins = collectAdminsFromForm();
    if (admins.length === 0) { alert('Legg til minst \u00e9n administrator-e-post.'); return null; }

    var units = collectUnitsFromForm();

    var isNewAddress = !activeAddressId;
    if (isNewAddress) {
        activeAddressId = generateId();
        sessionStorage.setItem('fellesutgifter_active_addr', activeAddressId);
    }

    addressConfig.address = address;
    addressConfig.admins = admins;
    addressConfig.units = units;
    if (!addressConfig.years) addressConfig.years = [];

    // Update addresses index
    var found = false;
    for (var a = 0; a < allAddresses.length; a++) {
        if (allAddresses[a].id === activeAddressId) {
            allAddresses[a].name = address;
            found = true;
            break;
        }
    }
    if (!found) {
        allAddresses.push({ id: activeAddressId, name: address });
    }

    return { admins: admins, units: units, address: address };
}

function saveAll() {
    if (!isAdmin) return;

    var setup = _saveSetupInner();
    if (!setup) return;

    var year = document.getElementById('inp-year').value.trim();
    var hasYear = year && !isNaN(parseInt(year));

    var saves = [saveAddressConfig(), saveAddressesIndex()];

    if (hasYear) {
        if (!activeAddressId) { alert('Lagre adresse f\u00f8rst.'); return; }

        syncFormCostsFromDOM();
        var costs = [];
        for (var i = 0; i < formCosts.length; i++) {
            var c = formCosts[i];
            if (c.desc || c.amount) {
                costs.push({ desc: c.desc, amount: c.amount, invoice: c.invoice || null });
            }
        }
        yearDataCache[year] = { costs: costs };

        if (!addressConfig.years) addressConfig.years = [];
        if (addressConfig.years.indexOf(year) === -1) {
            addressConfig.years.push(year);
            addressConfig.years.sort();
        }

        saves.push(saveYearData(year));
        activeTab = year;
    }

    updateAdminState();
    updateUI();
    render();
    clearForm();

    setSyncStatus('loading', 'Lagrer...');
    Promise.all(saves)
    .then(function() { setSyncStatus('ok', 'Lagret'); })
    .catch(function(err) {
        setSyncStatus('err', 'Feil: ' + (err.message || err));
        if (window.__debugWorker) console.error('Save error:', err);
    });
}

function deleteYear() {
    if (!isAdmin || !editingYear) return;
    var year = editingYear;
    if (!confirm('Er du sikker p\u00e5 at du vil slette \u00e5r ' + year + ' og alle kostnader for dette \u00e5ret?')) return;

    // Remove from config
    if (addressConfig.years) {
        var idx = addressConfig.years.indexOf(year);
        if (idx !== -1) addressConfig.years.splice(idx, 1);
    }

    // Remove from cache
    delete yearDataCache[year];

    // Delete year file from GitHub
    var path = yearFilePath(activeAddressId, year);

    setSyncStatus('loading', 'Sletter...');
    Promise.all([ghDeleteFile(path), saveAddressConfig()])
    .then(function() {
        activeTab = (addressConfig.years && addressConfig.years.length > 0) ? addressConfig.years[addressConfig.years.length - 1] : null;
        clearForm();
        updateUI();
        render();
        setSyncStatus('ok', 'Slettet');
    })
    .catch(function(err) {
        setSyncStatus('err', 'Feil: ' + (err.message || err));
    });
}

function newAddress() {
    activeAddressId = null;
    addressConfig = {};
    yearDataCache = {};
    fileShas = {};
    activeTab = null;
    editingYear = null;
    document.getElementById('cfg-address').value = '';
    document.getElementById('admin-emails-body').innerHTML = '';
    document.getElementById('units-body').innerHTML = '';
    clearForm();
    addAdmin();
    addUnit();
    document.getElementById('form-card').style.display = 'block';
    render();
}

function updateFormButtons() {
    var delBtn = document.getElementById('btn-delete-year');
    var titleEl = document.getElementById('year-section-title');
    var newAddrBtn = document.getElementById('btn-new-address');
    if (delBtn) delBtn.style.display = editingYear ? 'inline-block' : 'none';
    if (titleEl) titleEl.textContent = editingYear ? ('Rediger ' + editingYear) : 'Legg til \u00e5r';
    if (newAddrBtn) newAddrBtn.style.display = (allAddresses.length > 0 && !editingYear) ? 'inline-block' : 'none';
}

function saveYear() {
    // Legacy compatibility — redirect to saveAll
    saveAll();
}

function clearForm() {
    editingYear = null;
    var inp = document.getElementById('inp-year');
    inp.value = new Date().getFullYear();
    inp.readOnly = false;
    inp.style.opacity = '1';
    formCosts = [];
    renderCostsForm();
    updateFormButtons();
}

function loadYearIntoForm(year) {
    if (!isAdmin) return;
    var data = yearDataCache[year];
    if (!data) return;

    editingYear = year;
    var inp = document.getElementById('inp-year');
    inp.value = year;
    inp.readOnly = true;
    inp.style.opacity = '0.6';

    formCosts = [];
    var costs = data.costs || [];
    for (var i = 0; i < costs.length; i++) {
        formCosts.push({
            desc: costs[i].desc || '',
            amount: costs[i].amount || 0,
            invoice: costs[i].invoice || null
        });
    }
    renderCostsForm();
    document.getElementById('form-card').style.display = 'block';
    updateFormButtons();
}

/* ================================================
   PDF EXPORT
   ================================================ */
function exportPdf(year) {
    var data = yearDataCache[year];
    if (!data) return;

    var allCosts = data.costs || [];
    var yearUnits = getUnitsForDisplay();
    var addrName = addressConfig.address || '';

    var total = 0;
    for (var ci = 0; ci < allCosts.length; ci++) total += (allCosts[ci].amount || 0);

    var h = '<!DOCTYPE html><html><head><meta charset="UTF-8">'
        + '<title>Kostnadsoversikt ' + year + '</title>'
        + '<style>'
        + 'body{font-family:"Segoe UI",Tahoma,sans-serif;padding:2.5rem;color:#333;max-width:800px;margin:0 auto;}'
        + 'h1{color:#1e3c72;font-size:1.6rem;margin-bottom:0.2rem;}'
        + 'h2{color:#555;font-size:1rem;font-weight:400;margin-bottom:1.5rem;}'
        + '.summary{display:flex;flex-wrap:wrap;gap:0.7rem;margin-bottom:1.5rem;}'
        + '.s-item{background:#f0f4f8;border-radius:8px;padding:0.6rem 1rem;min-width:130px;}'
        + '.s-item .lbl{font-size:0.72rem;color:#777;text-transform:uppercase;letter-spacing:0.3px;}'
        + '.s-item .val{font-size:1.05rem;font-weight:700;color:#1e3c72;}'
        + '.s-total{background:#1e3c72;color:#fff;}'
        + '.s-total .lbl{color:rgba(255,255,255,0.7);}'
        + '.s-total .val{color:#fff;}'
        + 'table{width:100%;border-collapse:collapse;margin-top:1rem;}'
        + 'thead th{background:#1e3c72;color:#fff;padding:0.6rem 0.5rem;text-align:right;font-size:0.82rem;'
        + '-webkit-print-color-adjust:exact;print-color-adjust:exact;}'
        + 'thead th:first-child{text-align:left;}'
        + 'thead th .pct{display:block;font-weight:400;font-size:0.68rem;opacity:0.8;}'
        + 'tbody td{padding:0.45rem 0.5rem;text-align:right;border-bottom:1px solid #eee;font-size:0.88rem;}'
        + 'tbody td:first-child{text-align:left;font-weight:600;color:#555;}'
        + 'tfoot td{padding:0.55rem 0.5rem;text-align:right;font-weight:700;border-top:2px solid #1e3c72;color:#1e3c72;font-size:0.9rem;}'
        + 'tfoot td:first-child{text-align:left;}'
        + '.footer{margin-top:2.5rem;font-size:0.72rem;color:#bbb;text-align:center;}'
        + '@media print{body{padding:1.5rem;}thead th{background:#1e3c72 !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}}'
        + '</style></head><body>';

    h += '<h1>Kostnadsoversikt ' + year + (addrName ? ' \u2014 ' + escapeHtml(addrName) : '') + '</h1>';
    h += '<h2>Generert ' + new Date().toLocaleDateString('nb-NO') + '</h2>';

    h += '<div class="summary">';
    for (var si = 0; si < allCosts.length; si++) {
        h += '<div class="s-item"><div class="lbl">' + escapeHtml(allCosts[si].desc) + '</div><div class="val">kr ' + fmt(allCosts[si].amount || 0) + '</div></div>';
    }
    h += '<div class="s-item s-total"><div class="lbl">Totalt</div><div class="val">kr ' + fmt(total) + '</div></div>';
    h += '</div>';

    if (yearUnits.length > 0) {
        h += '<table><thead><tr><th>Kostnad (pr. mnd)</th>';
        for (var ti = 0; ti < yearUnits.length; ti++) {
            h += '<th>' + escapeHtml(yearUnits[ti].name) + '<span class="pct">' + fmtPct(yearUnits[ti].pct) + '</span></th>';
        }
        h += '</tr></thead><tbody>';

        var pm = yearUnits.map(function() { return 0; });
        for (var ri = 0; ri < allCosts.length; ri++) {
            var monthly = (allCosts[ri].amount || 0) / 12;
            h += '<tr><td>' + escapeHtml(allCosts[ri].desc) + '</td>';
            for (var pi = 0; pi < yearUnits.length; pi++) {
                var share = monthly * yearUnits[pi].pct / 100;
                pm[pi] += share;
                h += '<td>kr ' + fmt(share) + '</td>';
            }
            h += '</tr>';
        }

        h += '</tbody><tfoot><tr><td>Sum pr. mnd</td>';
        for (var mi = 0; mi < yearUnits.length; mi++) h += '<td>kr ' + fmt(pm[mi]) + '</td>';
        h += '</tr><tr><td>Sum pr. \u00e5r</td>';
        for (var ai = 0; ai < yearUnits.length; ai++) h += '<td>kr ' + fmt(pm[ai] * 12) + '</td>';
        h += '</tr></tfoot></table>';
    }

    h += '<div class="footer">Fellesutgifter \u2014 ' + escapeHtml(addrName) + ' \u2014 ' + year + '</div></body></html>';

    var printWin = window.open('', '_blank', 'width=900,height=700');
    printWin.document.write(h);
    printWin.document.close();
    printWin.focus();
    setTimeout(function() { printWin.print(); }, 400);
}

/* ================================================
   RENDER
   ================================================ */
function render() {
    var years = (addressConfig.years || []).slice().sort();

    // Filter by email access for non-admins
    if (!isAdmin && currentUser) {
        var units = getUnits();
        var hasAccess = false;
        for (var ui = 0; ui < units.length; ui++) {
            if (units[ui].email === currentUser.email) { hasAccess = true; break; }
        }
        if (!hasAccess && units.length > 0) years = [];
    }

    var container = document.getElementById('tabs-container');

    if (years.length === 0) {
        var msg;
        if (allAddresses.length === 0) {
            msg = 'Velkommen! Klikk \u00ab\u2699\ufe0f Administrer\u00bb for \u00e5 opprette en adresse.';
        } else if (!addressConfig.admins) {
            msg = 'Laster...';
        } else if (isAdmin) {
            msg = 'Ingen data lagt til enn\u00e5. Klikk \u00ab\u2699\ufe0f Administrer\u00bb og fyll inn skjemaet.';
        } else {
            msg = 'Ingen data tilgjengelig for deg enn\u00e5.';
        }
        container.innerHTML = '<div class="no-data">' + msg + '</div>';
        activeTab = null;
        return;
    }

    if (!activeTab || years.indexOf(activeTab) === -1) {
        activeTab = years[years.length - 1];
    }

    // Make sure year data is loaded
    if (!yearDataCache[activeTab]) {
        container.innerHTML = '<div class="no-data">Laster \u00e5rsdata...</div>';
        loadYearData(activeTab, function() { renderTabContent(years); });
        return;
    }

    renderTabContent(years);
}

function renderTabContent(years) {
    var container = document.getElementById('tabs-container');
    var tabBarHtml = '<div class="tab-bar">';
    for (var yi = 0; yi < years.length; yi++) {
        var y = years[yi];
        var cls = y === activeTab ? 'tab-btn active' : 'tab-btn';
        tabBarHtml += '<button class="' + cls + '" onclick="switchTab(\'' + y + '\')">' + y + '</button>';
    }
    tabBarHtml += '</div>';

    var data = yearDataCache[activeTab];
    if (!data) {
        container.innerHTML = tabBarHtml + '<div class="tab-content"><div class="no-data">Ingen data.</div></div>';
        return;
    }

    var allCosts = data.costs || [];
    var yearUnits = getUnitsForDisplay();

    var total = 0;
    for (var ci = 0; ci < allCosts.length; ci++) total += (allCosts[ci].amount || 0);

    var html = tabBarHtml + '<div class="tab-content">';

    html += '<button class="btn-pdf" onclick="exportPdf(\'' + activeTab + '\')">&#128196; Eksporter til PDF</button>';
    if (isAdmin) {
        html += '<button class="btn-secondary action-btn" style="margin-right:0.5rem" onclick="loadYearIntoForm(\'' + activeTab + '\')">Rediger</button>';
    }
    html += '<div style="clear:both;"></div>';

    html += '<h3>Oversikt for ' + activeTab + '</h3>';

    // Summary cards
    html += '<div class="summary">';
    for (var si = 0; si < allCosts.length; si++) {
        var invIcon = allCosts[si].invoice ? ' \ud83d\udcce' : '';
        html += '<div class="summary-item">'
            + '<div class="label">' + escapeHtml(allCosts[si].desc) + invIcon + '</div>'
            + '<div class="value">kr ' + fmt(allCosts[si].amount || 0) + '</div>';
        if (allCosts[si].invoice) {
            html += '<a href="#" class="invoice-link" onclick="viewInvoiceData(\'' + allCosts[si].invoice.substring(0, 50) + '\'); return false;" '
                + 'data-cost-idx="' + si + '">Vis faktura</a>';
        }
        html += '</div>';
    }
    html += '<div class="summary-item" style="background:#1e3c72;color:#fff;">'
        + '<div class="label" style="color:rgba(255,255,255,0.7);">Totalt</div>'
        + '<div class="value" style="color:#fff;">kr ' + fmt(total) + '</div></div>';
    html += '</div>';

    // Distribution table
    if (yearUnits.length > 0 && allCosts.length > 0) {
        html += '<table><thead><tr><th>Kostnad (pr. mnd)</th>';
        for (var ti = 0; ti < yearUnits.length; ti++) {
            html += '<th>' + escapeHtml(yearUnits[ti].name) + '<span class="pct">' + fmtPct(yearUnits[ti].pct) + '</span></th>';
        }
        html += '</tr></thead><tbody>';

        var personTotalsMonthly = yearUnits.map(function() { return 0; });
        for (var ri = 0; ri < allCosts.length; ri++) {
            var monthly = (allCosts[ri].amount || 0) / 12;
            html += '<tr><td>' + escapeHtml(allCosts[ri].desc) + '</td>';
            for (var pj = 0; pj < yearUnits.length; pj++) {
                var share = monthly * yearUnits[pj].pct / 100;
                personTotalsMonthly[pj] += share;
                html += '<td>kr ' + fmt(share) + '</td>';
            }
            html += '</tr>';
        }

        html += '</tbody><tfoot><tr><td>Sum pr. mnd</td>';
        for (var mi = 0; mi < yearUnits.length; mi++) html += '<td>kr ' + fmt(personTotalsMonthly[mi]) + '</td>';
        html += '</tr><tr><td>Sum pr. \u00e5r</td>';
        for (var ai2 = 0; ai2 < yearUnits.length; ai2++) html += '<td>kr ' + fmt(personTotalsMonthly[ai2] * 12) + '</td>';
        html += '</tr></tfoot></table>';
    } else if (yearUnits.length === 0) {
        html += '<p style="color:#999;margin-top:1rem;">Ingen enheter lagt til. G\u00e5 til Administrer for \u00e5 legge til enheter.</p>';
    }

    html += '</div>';
    container.innerHTML = html;

    // Bind invoice view links properly (since inline data URLs are too long for onclick)
    var links = container.querySelectorAll('.invoice-link');
    for (var li = 0; li < links.length; li++) {
        (function(link) {
            var idx = parseInt(link.getAttribute('data-cost-idx'));
            link.onclick = function(e) {
                e.preventDefault();
                if (allCosts[idx] && allCosts[idx].invoice) {
                    viewInvoiceData(allCosts[idx].invoice);
                }
            };
        })(links[li]);
    }
}

function switchTab(year) {
    activeTab = String(year);
    if (!yearDataCache[year]) {
        loadYearData(year, function() { render(); });
    } else {
        render();
    }
}
