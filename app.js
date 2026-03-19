/* ================================================
   KONFIGURASJON
   ================================================ */
var GOOGLE_CLIENT_ID = '10152340554-g0bdlarlbf8tr4ldn31foq79uh0feqn8.apps.googleusercontent.com';
var GITHUB_REPO = 'himmelfisk/fellesutgifter';
var GITHUB_DATA_DIR = 'data';
var ADDRESSES_FILE = 'data/addresses.json';

var NUM_ADMIN_EMAILS = 5;
var NUM_EXTRA_ROWS = 10;

var COST_FIELDS = [
    { key: 'if_cost',    label: 'IF (forsikring)' },
    { key: 'kommunale',  label: 'Kommunale avgifter' },
    { key: 'anticimex',  label: 'Anticimex' },
    { key: 'uforutsett', label: 'Uforutsett' }
];

var TOKEN_KEY = 'fellesutgifter_gh_token';

/* ================================================
   STATE
   ================================================ */
var currentUser = null;
var isAdmin = false;
var activeTab = null;
var activeAddressId = null;

// GitHub SHAs per file
var fileShas = {};

// All known addresses: [{id, name}]
var allAddresses = [];

// Current address data: { _config: {admins, units}, "2026": {...}, ... }
var addressData = {};

/* ================================================
   AUTHENTICATION
   ================================================ */
function decodeJwt(token) {
    var payload = token.split('.')[1];
    var decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
}

function handleCredentialResponse(response) {
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
    addressData = {};
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
    buildExtraCostRows();
    buildAdminEmailRows();
    setupUploadArea();
    setTimeout(initGoogleSignIn, 500);
    setTimeout(function() { if (!currentUser) initGoogleSignIn(); }, 2000);
});

/* ================================================
   DYNAMIC FORM BUILDERS
   ================================================ */
function buildExtraCostRows() {
    var tbody = document.getElementById('extra-costs-body');
    var html = '';
    for (var i = 0; i < NUM_EXTRA_ROWS; i++) {
        html += '<tr>'
            + '<td><input type="text" id="extra-desc-' + i + '" placeholder="Beskrivelse"></td>'
            + '<td><input type="number" id="extra-cost-' + i + '" placeholder="0" step="any"></td>'
            + '</tr>';
    }
    tbody.innerHTML = html;
}

function buildAdminEmailRows() {
    var container = document.getElementById('admin-emails-body');
    var html = '';
    for (var i = 0; i < NUM_ADMIN_EMAILS; i++) {
        html += '<div class="form-group" style="margin-bottom:0.5rem;">'
            + '<input type="email" id="admin-email-' + i + '" placeholder="e-post@eksempel.no">'
            + '</div>';
    }
    container.innerHTML = html;
}

function renderUnitsTable() {
    var tbody = document.getElementById('units-body');
    var units = getUnits();
    var html = '';
    for (var i = 0; i < units.length; i++) {
        var u = units[i];
        html += '<tr>'
            + '<td><input type="text" class="unit-code" data-idx="' + i + '" value="' + escapeAttr(u.code) + '" placeholder="Kode"></td>'
            + '<td><input type="text" class="unit-name" data-idx="' + i + '" value="' + escapeAttr(u.name) + '" placeholder="Navn"></td>'
            + '<td><input type="number" class="unit-pct" data-idx="' + i + '" value="' + u.pct + '" step="0.01" min="0" max="100"></td>'
            + '<td><input type="email" class="unit-email" data-idx="' + i + '" value="' + escapeAttr(u.email || '') + '" placeholder="e-post"></td>'
            + '<td><button class="btn-remove" onclick="removeUnit(' + i + ')" title="Fjern">&times;</button></td>'
            + '</tr>';
    }
    tbody.innerHTML = html;
}

function addUnit() {
    var units = getUnits();
    units.push({ code: '', name: '', pct: 0, email: '' });
    setUnitsInConfig(units);
    renderUnitsTable();
}

function removeUnit(idx) {
    var units = getUnits();
    if (units.length <= 1) {
        alert('Du må ha minst én enhet.');
        return;
    }
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
        if (code || name) {
            units.push({ code: code, name: name, pct: pct, email: email || '' });
        }
    }
    return units;
}

function getUnits() {
    if (addressData._config && addressData._config.units) {
        return addressData._config.units.slice();
    }
    return [];
}

function setUnitsInConfig(units) {
    if (!addressData._config) addressData._config = {};
    addressData._config.units = units;
}

/* ================================================
   GITHUB API
   ================================================ */
function setSyncStatus(type, text) {
    var el = document.getElementById('sync-status');
    el.className = 'sync-status sync-' + type;
    el.textContent = text;
}

function getGitHubToken() {
    return sessionStorage.getItem(TOKEN_KEY) || '';
}

function promptForToken() {
    var token = prompt(
        'For å lagre data til GitHub trenger du en Personal Access Token.\n\n'
        + '1. Gå til github.com \u2192 Settings \u2192 Developer Settings \u2192 Personal Access Tokens (classic)\n'
        + '2. Opprett en token med "repo" scope\n'
        + '3. Lim inn tokenet her:\n\n'
        + '(Tokenet lagres kun i denne nettleser\u00f8kten og forsvinner n\u00e5r du lukker fanen.)'
    );
    if (token) {
        sessionStorage.setItem(TOKEN_KEY, token.trim());
    }
    return token ? token.trim() : '';
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
        var content = atob(file.content.replace(/\n/g, ''));
        return JSON.parse(content);
    });
}

function ghWriteFile(path, data) {
    var token = getGitHubToken();
    if (!token) {
        token = promptForToken();
        if (!token) {
            alert('Kan ikke lagre til GitHub uten token.');
            return Promise.reject('no token');
        }
    }
    var content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    var body = { message: 'Oppdater ' + path + ' ' + new Date().toISOString(), content: content };
    if (fileShas[path]) body.sha = fileShas[path];

    return fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + path, {
        method: 'PUT',
        headers: {
            'Accept': 'application/vnd.github.v3+json',
            'Authorization': 'token ' + token,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
    })
    .then(function(res) {
        if (res.status === 401 || res.status === 403) {
            sessionStorage.removeItem(TOKEN_KEY);
            throw new Error('Ugyldig token.');
        }
        if (res.status === 409) {
            return ghReadFile(path).then(function() { return ghWriteFile(path, data); });
        }
        if (!res.ok) throw new Error('GitHub write failed: ' + res.status);
        return res.json();
    })
    .then(function(result) {
        if (result.content) fileShas[path] = result.content.sha;
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

function addressFilePath(id) {
    return GITHUB_DATA_DIR + '/' + id + '.json';
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
        // No addresses yet — everyone can create
        isAdmin = true;
        activeAddressId = null;
        addressData = {};
        updateUI();
        render();
        return;
    }

    // Find addresses this user is admin for, or is a unit member of
    var adminAddresses = [];
    var memberAddresses = [];

    // We need to load each address to check membership
    // First, auto-select: if only 1, load it. If multiple, show picker.
    // For now, load the first one (or saved preference)
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
    loadAddressData(id);
}

function loadAddressData(id) {
    setSyncStatus('loading', 'Henter data...');
    ghReadFile(addressFilePath(id))
    .then(function(data) {
        addressData = data || {};
        setSyncStatus('ok', 'Synkronisert');
        updateAdminState();
        updateUI();
        render();
    })
    .catch(function() {
        addressData = {};
        setSyncStatus('err', 'Offline-modus');
        updateAdminState();
        updateUI();
        render();
    });
}

function saveAddressData() {
    if (!activeAddressId) return Promise.reject('no address');
    setSyncStatus('loading', 'Lagrer...');
    return ghWriteFile(addressFilePath(activeAddressId), addressData)
    .then(function() { setSyncStatus('ok', 'Lagret'); })
    .catch(function(err) {
        setSyncStatus('err', 'Feil: ' + (err.message || err));
        throw err;
    });
}

function saveAddressesIndex() {
    return ghWriteFile(ADDRESSES_FILE, allAddresses)
    .catch(function(err) { console.error('Feil ved lagring av adresseindeks:', err); });
}

/* ================================================
   UI STATE
   ================================================ */
function updateAdminState() {
    if (!currentUser) return;
    var config = addressData._config;
    if (!config || !config.admins || config.admins.length === 0) {
        isAdmin = true;
    } else {
        isAdmin = config.admins.indexOf(currentUser.email) !== -1;
    }
}

function updateUI() {
    var adminBtn = document.getElementById('admin-btn');
    var addrEl = document.getElementById('address-display');
    var pickerEl = document.getElementById('address-picker');

    // Admin button
    if (isAdmin || allAddresses.length === 0) {
        adminBtn.style.display = 'inline-block';
        adminBtn.className = 'btn-admin';
    } else {
        adminBtn.style.display = 'none';
        document.getElementById('form-card').style.display = 'none';
    }

    // Address display
    var config = addressData._config;
    if (config && config.address) {
        addrEl.textContent = '\u2014 ' + config.address;
    } else {
        addrEl.textContent = '';
    }

    // Address picker (show if user has access to multiple)
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
    if (config) {
        document.getElementById('cfg-address').value = config.address || '';
        var admins = config.admins || [];
        for (var ai = 0; ai < NUM_ADMIN_EMAILS; ai++) {
            document.getElementById('admin-email-' + ai).value = (ai < admins.length) ? admins[ai] : '';
        }
    } else {
        document.getElementById('cfg-address').value = '';
        document.getElementById('admin-email-0').value = currentUser ? currentUser.email : '';
        for (var aj = 1; aj < NUM_ADMIN_EMAILS; aj++) {
            document.getElementById('admin-email-' + aj).value = '';
        }
    }

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
   TENANT/UNIT HELPERS
   ================================================ */
function getUnitsForYear(entry) {
    // Units come from _config.units, but per-year data may override name/pct
    var configUnits = getUnits();
    if (configUnits.length === 0) return [];
    var result = [];
    for (var i = 0; i < configUnits.length; i++) {
        var u = configUnits[i];
        var name = u.name;
        var pct = u.pct;
        if (entry.tenants && entry.tenants[u.code]) name = entry.tenants[u.code];
        if (entry.percentages && entry.percentages[u.code] !== undefined) pct = entry.percentages[u.code];
        result.push({ code: u.code, name: name || u.code, pct: pct });
    }
    return result;
}

/* ================================================
   FORM ACTIONS
   ================================================ */
function toggleForm() {
    var card = document.getElementById('form-card');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
}

function saveSetup() {
    if (!isAdmin) return;
    var address = document.getElementById('cfg-address').value.trim();
    if (!address) {
        alert('Vennligst fyll inn en adresse.');
        return;
    }

    var admins = [];
    for (var i = 0; i < NUM_ADMIN_EMAILS; i++) {
        var email = document.getElementById('admin-email-' + i).value.trim().toLowerCase();
        if (email) admins.push(email);
    }
    if (admins.length === 0) {
        alert('Legg til minst \u00e9n administrator-e-post.');
        return;
    }

    var units = collectUnitsFromForm();

    var isNewAddress = !activeAddressId;
    if (isNewAddress) {
        activeAddressId = generateId();
        sessionStorage.setItem('fellesutgifter_active_addr', activeAddressId);
    }

    if (!addressData._config) addressData._config = {};
    addressData._config.address = address;
    addressData._config.admins = admins;
    addressData._config.units = units;

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

    updateAdminState();
    updateUI();
    render();

    setSyncStatus('loading', 'Lagrer...');
    Promise.all([
        saveAddressData(),
        saveAddressesIndex()
    ]).then(function() {
        setSyncStatus('ok', 'Lagret');
    }).catch(function(err) {
        setSyncStatus('err', 'Feil: ' + (err.message || err));
    });
}

function saveYear() {
    if (!isAdmin) return;
    var year = document.getElementById('inp-year').value.trim();
    if (!year || isNaN(parseInt(year))) {
        alert('Vennligst fyll inn et gyldig \u00e5r.');
        return;
    }

    if (!activeAddressId) {
        alert('Lagre innstillinger (adresse) f\u00f8rst.');
        return;
    }

    var ifCost = parseFloat(document.getElementById('inp-if').value) || 0;
    var kommunale = parseFloat(document.getElementById('inp-kommunale').value) || 0;
    var anticimex = parseFloat(document.getElementById('inp-anticimex').value) || 0;
    var uforutsett = parseFloat(document.getElementById('inp-uforutsett').value) || 0;

    var extras = [];
    for (var i = 0; i < NUM_EXTRA_ROWS; i++) {
        var desc = document.getElementById('extra-desc-' + i).value.trim();
        var cost = parseFloat(document.getElementById('extra-cost-' + i).value) || 0;
        if (desc && cost) {
            extras.push({ desc: desc, cost: cost });
        }
    }

    addressData[year] = {
        if_cost: ifCost,
        kommunale: kommunale,
        anticimex: anticimex,
        uforutsett: uforutsett,
        extras: extras
    };

    render(year);
    clearForm();

    saveAddressData().catch(function(err) {
        console.error('GitHub save error:', err);
    });
}

function clearForm() {
    document.getElementById('inp-year').value = '';
    document.getElementById('inp-if').value = '';
    document.getElementById('inp-kommunale').value = '';
    document.getElementById('inp-anticimex').value = '';
    document.getElementById('inp-uforutsett').value = '';

    for (var i = 0; i < NUM_EXTRA_ROWS; i++) {
        document.getElementById('extra-desc-' + i).value = '';
        document.getElementById('extra-cost-' + i).value = '';
    }
}

function loadYearIntoForm(year) {
    if (!isAdmin) return;
    var entry = addressData[year];
    if (!entry) return;

    document.getElementById('inp-year').value = year;
    document.getElementById('inp-if').value = entry.if_cost || '';
    document.getElementById('inp-kommunale').value = entry.kommunale || '';
    document.getElementById('inp-anticimex').value = entry.anticimex || '';
    document.getElementById('inp-uforutsett').value = entry.uforutsett || '';

    var extras = entry.extras || [];
    for (var i = 0; i < NUM_EXTRA_ROWS; i++) {
        if (i < extras.length) {
            document.getElementById('extra-desc-' + i).value = extras[i].desc || '';
            document.getElementById('extra-cost-' + i).value = extras[i].cost || '';
        } else {
            document.getElementById('extra-desc-' + i).value = '';
            document.getElementById('extra-cost-' + i).value = '';
        }
    }

    document.getElementById('form-card').style.display = 'block';
}

/* ================================================
   PDF EXPORT
   ================================================ */
function exportPdf(year) {
    var entry = addressData[year];
    if (!entry) return;

    var yearUnits = getUnitsForYear(entry);
    var addrName = (addressData._config && addressData._config.address) || '';

    var allCosts = [];
    for (var fi = 0; fi < COST_FIELDS.length; fi++) {
        allCosts.push({ label: COST_FIELDS[fi].label, value: entry[COST_FIELDS[fi].key] || 0 });
    }
    var extras = entry.extras || [];
    for (var ei = 0; ei < extras.length; ei++) {
        allCosts.push({ label: extras[ei].desc, value: extras[ei].cost });
    }

    var total = 0;
    for (var ci = 0; ci < allCosts.length; ci++) total += allCosts[ci].value;

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
        h += '<div class="s-item"><div class="lbl">' + escapeHtml(allCosts[si].label) + '</div><div class="val">kr ' + fmt(allCosts[si].value) + '</div></div>';
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
            var monthly = allCosts[ri].value / 12;
            h += '<tr><td>' + escapeHtml(allCosts[ri].label) + '</td>';
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
function render(selectYear) {
    var data = addressData;
    var years = Object.keys(data).filter(function(k) { return k !== '_config'; }).sort();

    // Filter by email access for non-admins
    if (!isAdmin && currentUser) {
        var units = getUnits();
        var userCodes = [];
        for (var ui = 0; ui < units.length; ui++) {
            if (units[ui].email === currentUser.email) userCodes.push(units[ui].code);
        }
        if (userCodes.length === 0 && units.length > 0) {
            // User is not a member of any unit
            years = [];
        }
    }

    var container = document.getElementById('tabs-container');

    if (years.length === 0) {
        var msg;
        if (allAddresses.length === 0) {
            msg = 'Velkommen! Klikk \u00ab\u2699\ufe0f Administrer\u00bb for \u00e5 opprette en adresse.';
        } else if (!addressData._config) {
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

    if (selectYear) {
        activeTab = String(selectYear);
    } else if (!activeTab || years.indexOf(activeTab) === -1) {
        activeTab = years[years.length - 1];
    }

    var tabBarHtml = '<div class="tab-bar">';
    for (var yi = 0; yi < years.length; yi++) {
        var y = years[yi];
        var cls = y === activeTab ? 'tab-btn active' : 'tab-btn';
        tabBarHtml += '<button class="' + cls + '" onclick="switchTab(\'' + y + '\')">' + y + '</button>';
    }
    tabBarHtml += '</div>';

    var entry = data[activeTab];
    var yearUnits = getUnitsForYear(entry);

    var allCosts = [];
    for (var fi = 0; fi < COST_FIELDS.length; fi++) {
        allCosts.push({ label: COST_FIELDS[fi].label, value: entry[COST_FIELDS[fi].key] || 0 });
    }
    var extras = entry.extras || [];
    for (var ei = 0; ei < extras.length; ei++) {
        allCosts.push({ label: extras[ei].desc, value: extras[ei].cost });
    }

    var total = 0;
    for (var ci = 0; ci < allCosts.length; ci++) total += allCosts[ci].value;

    var html = tabBarHtml + '<div class="tab-content">';

    html += '<button class="btn-pdf" onclick="exportPdf(\'' + activeTab + '\')">&#128196; Eksporter til PDF</button>';
    if (isAdmin) {
        html += '<button class="btn-secondary action-btn" style="margin-right:0.5rem" onclick="loadYearIntoForm(\'' + activeTab + '\')">Rediger</button>';
    }
    html += '<div style="clear:both;"></div>';

    html += '<h3>Oversikt for ' + activeTab + '</h3>';

    html += '<div class="summary">';
    for (var si = 0; si < allCosts.length; si++) {
        html += '<div class="summary-item"><div class="label">' + escapeHtml(allCosts[si].label) + '</div><div class="value">kr ' + fmt(allCosts[si].value) + '</div></div>';
    }
    html += '<div class="summary-item" style="background:#1e3c72;color:#fff;"><div class="label" style="color:rgba(255,255,255,0.7);">Totalt</div><div class="value" style="color:#fff;">kr ' + fmt(total) + '</div></div>';
    html += '</div>';

    if (yearUnits.length > 0) {
        html += '<table><thead><tr><th>Kostnad (pr. mnd)</th>';
        for (var ti = 0; ti < yearUnits.length; ti++) {
            html += '<th>' + escapeHtml(yearUnits[ti].name) + '<span class="pct">' + fmtPct(yearUnits[ti].pct) + '</span></th>';
        }
        html += '</tr></thead><tbody>';

        var personTotalsMonthly = yearUnits.map(function() { return 0; });

        for (var ri = 0; ri < allCosts.length; ri++) {
            var val = allCosts[ri].value;
            var monthly = val / 12;
            html += '<tr><td>' + escapeHtml(allCosts[ri].label) + '</td>';
            for (var pj = 0; pj < yearUnits.length; pj++) {
                var share = monthly * yearUnits[pj].pct / 100;
                personTotalsMonthly[pj] += share;
                html += '<td>kr ' + fmt(share) + '</td>';
            }
            html += '</tr>';
        }

        html += '</tbody><tfoot><tr><td>Sum pr. mnd</td>';
        for (var mi = 0; mi < yearUnits.length; mi++) {
            html += '<td>kr ' + fmt(personTotalsMonthly[mi]) + '</td>';
        }
        html += '</tr><tr><td>Sum pr. \u00e5r</td>';
        for (var ai = 0; ai < yearUnits.length; ai++) {
            html += '<td>kr ' + fmt(personTotalsMonthly[ai] * 12) + '</td>';
        }
        html += '</tr></tfoot></table>';
    } else {
        html += '<p style="color:#999;margin-top:1rem;">Ingen enheter lagt til. G\u00e5 til Administrer for \u00e5 legge til enheter.</p>';
    }

    html += '</div>';
    container.innerHTML = html;
}

function switchTab(year) {
    activeTab = String(year);
    render();
}

/* ================================================
   INVOICE UPLOAD & OCR
   ================================================ */
function setupUploadArea() {
    var area = document.getElementById('upload-area');
    if (!area) return;
    area.addEventListener('dragover', function(e) {
        e.preventDefault();
        area.classList.add('drag-over');
    });
    area.addEventListener('dragleave', function() {
        area.classList.remove('drag-over');
    });
    area.addEventListener('drop', function(e) {
        e.preventDefault();
        area.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) handleInvoiceUpload(e.dataTransfer.files);
    });
}

function handleInvoiceUpload(files) {
    var file = files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        alert('Vennligst last opp et bilde (JPG, PNG, etc.).');
        return;
    }
    var reader = new FileReader();
    reader.onload = function(e) { runOCR(e.target.result, file.name); };
    reader.readAsDataURL(file);
}

function runOCR(imageData, fileName) {
    var progressEl = document.getElementById('ocr-progress');
    var fillEl = document.getElementById('ocr-progress-fill');
    var statusEl = document.getElementById('ocr-status');
    var resultEl = document.getElementById('ocr-result');

    progressEl.style.display = 'block';
    resultEl.style.display = 'none';
    fillEl.style.width = '0%';
    statusEl.textContent = 'Laster spr\u00e5kdata...';

    if (typeof Tesseract === 'undefined') {
        statusEl.textContent = 'Feil: Tesseract.js ikke lastet.';
        return;
    }

    Tesseract.recognize(imageData, 'nor', {
        logger: function(m) {
            if (m.status === 'recognizing text') {
                var pct = Math.round((m.progress || 0) * 100);
                fillEl.style.width = pct + '%';
                statusEl.textContent = 'Analyserer tekst... ' + pct + '%';
            } else if (m.status === 'loading language traineddata') {
                fillEl.style.width = (Math.round((m.progress || 0) * 100) * 0.5) + '%';
                statusEl.textContent = 'Laster norsk spr\u00e5kdata...';
            } else if (m.status) {
                statusEl.textContent = m.status.charAt(0).toUpperCase() + m.status.slice(1) + '...';
            }
        }
    })
    .then(function(result) {
        fillEl.style.width = '100%';
        statusEl.textContent = 'Ferdig!';
        setTimeout(function() { progressEl.style.display = 'none'; }, 1500);
        processOCRResult(result.data.text, fileName);
    })
    .catch(function(err) {
        statusEl.textContent = 'Feil under analyse: ' + err.message;
        fillEl.style.width = '0%';
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
        return { key: 'if_cost', label: 'IF (forsikring)', inputId: 'inp-if' };
    if (/kommune|kommunale\s*avgifter|eiendomsskatt|vann.*avl[o\u00f8]p|renovasjon|feiing/i.test(text))
        return { key: 'kommunale', label: 'Kommunale avgifter', inputId: 'inp-kommunale' };
    if (/anticimex|skadedyr/i.test(text))
        return { key: 'anticimex', label: 'Anticimex', inputId: 'inp-anticimex' };
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

function processOCRResult(text, fileName) {
    var resultEl = document.getElementById('ocr-result');
    var amounts = parseAmounts(text);
    var category = classifyInvoice(text);
    var total = findTotalAmount(text, amounts);

    if (!total) {
        resultEl.innerHTML = '<div class="ocr-card ocr-warn">'
            + '<strong>\u26a0\ufe0f Ingen bel\u00f8p funnet</strong>'
            + '<p>Klarte ikke \u00e5 finne bel\u00f8p i bildet.</p>'
            + '<details><summary>Vis tekst</summary><pre class="ocr-text">' + escapeHtml(text) + '</pre></details></div>';
        resultEl.style.display = 'block';
        return;
    }

    var catLabel = category ? category.label : 'Ukjent kategori';
    var html = '<div class="ocr-card ocr-success"><div class="ocr-found">'
        + '<span class="ocr-amount">kr ' + fmt(total.value) + '</span>'
        + '<span class="ocr-cat">' + catLabel + '</span></div>';

    if (category) {
        html += '<p>Settes inn i <strong>' + category.label + '</strong>.</p>'
            + '<button class="btn-primary" style="margin-top:0.5rem" onclick="applyOCRResult(' + total.value + ',\'' + category.inputId + '\')">Bruk bel\u00f8p</button>';
    } else {
        html += '<p>Velg felt:</p><div class="ocr-buttons">'
            + '<button class="btn-secondary" onclick="applyOCRResult(' + total.value + ',\'inp-if\')">IF</button>'
            + '<button class="btn-secondary" onclick="applyOCRResult(' + total.value + ',\'inp-kommunale\')">Kommunale</button>'
            + '<button class="btn-secondary" onclick="applyOCRResult(' + total.value + ',\'inp-anticimex\')">Anticimex</button>'
            + '<button class="btn-secondary" onclick="applyOCRResult(' + total.value + ',\'inp-uforutsett\')">Uforutsett</button>'
            + '<button class="btn-secondary" onclick="applyOCRToExtra(' + total.value + ')">Ekstra</button></div>';
    }

    if (amounts.length > 1) {
        html += '<details style="margin-top:0.8rem"><summary>Alle bel\u00f8p (' + amounts.length + ')</summary><ul class="ocr-amounts-list">';
        for (var i = 0; i < amounts.length; i++) {
            var cls = amounts[i] === total ? ' class="ocr-highlight"' : '';
            html += '<li' + cls + '>kr ' + fmt(amounts[i].value) + '</li>';
        }
        html += '</ul></details>';
    }

    html += '<details><summary>Vis tekst</summary><pre class="ocr-text">' + escapeHtml(text) + '</pre></details></div>';
    resultEl.innerHTML = html;
    resultEl.style.display = 'block';
}

function applyOCRResult(amount, inputId) {
    var el = document.getElementById(inputId);
    if (el) {
        el.value = amount;
        el.focus();
        el.style.transition = 'background 0.3s';
        el.style.background = '#d4edda';
        setTimeout(function() { el.style.background = ''; }, 2000);
    }
    document.getElementById('ocr-result').style.display = 'none';
    document.getElementById('invoice-file').value = '';
}

function applyOCRToExtra(amount) {
    for (var i = 0; i < NUM_EXTRA_ROWS; i++) {
        var descEl = document.getElementById('extra-desc-' + i);
        var costEl = document.getElementById('extra-cost-' + i);
        if (!descEl.value && !costEl.value) {
            costEl.value = amount;
            descEl.focus();
            costEl.style.transition = 'background 0.3s';
            costEl.style.background = '#d4edda';
            setTimeout(function() { costEl.style.background = ''; }, 2000);
            break;
        }
    }
    document.getElementById('ocr-result').style.display = 'none';
    document.getElementById('invoice-file').value = '';
}
