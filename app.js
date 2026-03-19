/* ================================================
   KONFIGURASJON
   ================================================ */
var GOOGLE_CLIENT_ID = '10152340554-g0bdlarlbf8tr4ldn31foq79uh0feqn8.apps.googleusercontent.com';

var GITHUB_REPO = 'himmelfisk/fellesutgifter';
var GITHUB_DATA_FILE = 'data.json';

var NUM_ADMIN_EMAILS = 5;

var NUM_EXTRA_ROWS = 10;

var DEFAULT_TENANTS = [
    { code: 'K0101', defaultName: 'Kenneth', pct: 22.19 },
    { code: 'H0101', defaultName: 'Ole',     pct: 28.64 },
    { code: 'H0102', defaultName: 'Theodor', pct: 27.76 },
    { code: 'L0101', defaultName: 'Lis',     pct: 21.41 }
];

var COST_FIELDS = [
    { key: 'if_cost',    label: 'IF (forsikring)' },
    { key: 'kommunale',  label: 'Kommunale avgifter' },
    { key: 'anticimex',  label: 'Anticimex' },
    { key: 'uforutsett', label: 'Uforutsett' }
];

var STORAGE_KEY = 'fellesutgifter_data';
var TOKEN_KEY = 'fellesutgifter_gh_token';

/* ================================================
   STATE
   ================================================ */
var currentUser = null;
var isAdmin = false;
var activeTab = null;
var ghFileSha = null;
var appData = {};

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

    loadAllData();
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
    setTimeout(initGoogleSignIn, 500);
    setTimeout(function() { if (!currentUser) initGoogleSignIn(); }, 2000);
});

/* ================================================
   EXTRA COST ROWS
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

/* ================================================
   GITHUB DATA — Read & Write data.json
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
        + '1. Gå til github.com → Settings → Developer Settings → Personal Access Tokens (classic)\n'
        + '2. Opprett en token med "repo" scope\n'
        + '3. Lim inn tokenet her:\n\n'
        + '(Tokenet lagres kun i denne nettleserøkten og forsvinner når du lukker fanen.)'
    );
    if (token) {
        sessionStorage.setItem(TOKEN_KEY, token.trim());
    }
    return token ? token.trim() : '';
}

function fetchGitHubData() {
    return fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_DATA_FILE, {
        headers: { 'Accept': 'application/vnd.github.v3+json' },
        cache: 'no-store'
    })
    .then(function(res) {
        if (res.status === 404) {
            ghFileSha = null;
            return {};
        }
        if (!res.ok) throw new Error('GitHub read failed: ' + res.status);
        return res.json();
    })
    .then(function(file) {
        if (file.sha) {
            ghFileSha = file.sha;
            var content = atob(file.content.replace(/\n/g, ''));
            return JSON.parse(content);
        }
        return {};
    });
}

function writeGitHubData(data) {
    var token = getGitHubToken();
    if (!token) {
        token = promptForToken();
        if (!token) {
            alert('Kan ikke lagre til GitHub uten token.');
            return Promise.reject('no token');
        }
    }

    var content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
    var body = {
        message: 'Oppdater data ' + new Date().toISOString(),
        content: content
    };
    if (ghFileSha) {
        body.sha = ghFileSha;
    }

    setSyncStatus('loading', 'Lagrer...');

    return fetch('https://api.github.com/repos/' + GITHUB_REPO + '/contents/' + GITHUB_DATA_FILE, {
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
            throw new Error('Ugyldig token. Prøv igjen.');
        }
        if (res.status === 409) {
            return fetchGitHubData().then(function() {
                return writeGitHubData(data);
            });
        }
        if (!res.ok) throw new Error('GitHub write failed: ' + res.status);
        return res.json();
    })
    .then(function(result) {
        if (result.content) {
            ghFileSha = result.content.sha;
        }
        setSyncStatus('ok', 'Lagret til GitHub');
    })
    .catch(function(err) {
        setSyncStatus('err', 'Feil: ' + err.message);
        throw err;
    });
}

/* ================================================
   DATA MANAGEMENT
   ================================================ */
function loadAllData() {
    setSyncStatus('loading', 'Henter data...');

    fetchGitHubData()
    .then(function(ghData) {
        var local = {};
        try { local = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) {}
        appData = Object.assign({}, local, ghData);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
        setSyncStatus('ok', 'Synkronisert');
        updateAdminState();
        render();
    })
    .catch(function() {
        try { appData = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch(e) { appData = {}; }
        setSyncStatus('err', 'Offline-modus');
        updateAdminState();
        render();
    });
}

function saveData(data) {
    appData = data;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function updateAdminState() {
    if (!currentUser) return;

    var config = appData._config;
    if (!config || !config.admins || config.admins.length === 0) {
        isAdmin = true;
    } else {
        isAdmin = false;
        for (var i = 0; i < config.admins.length; i++) {
            if (config.admins[i] === currentUser.email) {
                isAdmin = true;
                break;
            }
        }
    }

    var adminBtn = document.getElementById('admin-btn');
    if (isAdmin) {
        adminBtn.style.display = 'inline-block';
        adminBtn.className = 'btn-admin';
    } else {
        adminBtn.style.display = 'none';
        document.getElementById('form-card').style.display = 'none';
    }

    var addrEl = document.getElementById('address-display');
    if (config && config.address) {
        addrEl.textContent = '\u2014 ' + config.address;
    } else {
        addrEl.textContent = '';
    }

    if (config) {
        document.getElementById('cfg-address').value = config.address || '';
        var admins = config.admins || [];
        for (var ai = 0; ai < NUM_ADMIN_EMAILS; ai++) {
            document.getElementById('admin-email-' + ai).value = (ai < admins.length) ? admins[ai] : '';
        }
    } else {
        document.getElementById('cfg-address').value = '';
        document.getElementById('admin-email-0').value = currentUser.email;
        for (var aj = 1; aj < NUM_ADMIN_EMAILS; aj++) {
            document.getElementById('admin-email-' + aj).value = '';
        }
    }
}

function fmt(n) {
    return n.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPct(n) {
    return n.toFixed(2).replace('.', ',') + ' %';
}

/* ================================================
   TENANT HELPERS
   ================================================ */
function getTenantsForYear(entry) {
    var tenants = [];
    for (var i = 0; i < DEFAULT_TENANTS.length; i++) {
        var dt = DEFAULT_TENANTS[i];
        var name = dt.defaultName;
        var pct = dt.pct;
        if (entry.tenants && entry.tenants[dt.code]) name = entry.tenants[dt.code];
        if (entry.percentages && entry.percentages[dt.code] !== undefined) pct = entry.percentages[dt.code];
        tenants.push({ code: dt.code, name: name, pct: pct });
    }
    return tenants;
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

    appData._config = { address: address, admins: admins };
    saveData(appData);
    updateAdminState();
    render();

    writeGitHubData(appData).catch(function(err) {
        console.error('GitHub save error:', err);
    });
}

function saveYear() {
    if (!isAdmin) return;
    var year = document.getElementById('inp-year').value.trim();
    if (!year || isNaN(parseInt(year))) {
        alert('Vennligst fyll inn et gyldig år.');
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

    var tenants = {};
    var percentages = {};
    for (var t = 0; t < DEFAULT_TENANTS.length; t++) {
        var code = DEFAULT_TENANTS[t].code;
        var nameVal = document.getElementById('tenant-' + code).value.trim();
        tenants[code] = nameVal || DEFAULT_TENANTS[t].defaultName;
        var pctVal = parseFloat(document.getElementById('pct-' + code).value);
        percentages[code] = isNaN(pctVal) ? DEFAULT_TENANTS[t].pct : pctVal;
    }

    var emails = {};
    for (var e = 0; e < DEFAULT_TENANTS.length; e++) {
        var ecode = DEFAULT_TENANTS[e].code;
        var emailVal = document.getElementById('email-' + ecode).value.trim();
        if (emailVal) emails[ecode] = emailVal.toLowerCase();
    }

    var data = Object.assign({}, appData);
    data[year] = {
        if_cost: ifCost,
        kommunale: kommunale,
        anticimex: anticimex,
        uforutsett: uforutsett,
        extras: extras,
        tenants: tenants,
        percentages: percentages,
        emails: emails
    };
    saveData(data);
    render(year);
    clearForm();

    writeGitHubData(data).catch(function(err) {
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

    for (var t = 0; t < DEFAULT_TENANTS.length; t++) {
        document.getElementById('tenant-' + DEFAULT_TENANTS[t].code).value = DEFAULT_TENANTS[t].defaultName;
        document.getElementById('pct-' + DEFAULT_TENANTS[t].code).value = DEFAULT_TENANTS[t].pct;
        document.getElementById('email-' + DEFAULT_TENANTS[t].code).value = '';
    }
}

function loadYearIntoForm(year) {
    if (!isAdmin) return;
    var entry = appData[year];
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

    var tenants = entry.tenants || {};
    var percentages = entry.percentages || {};
    for (var t = 0; t < DEFAULT_TENANTS.length; t++) {
        var code = DEFAULT_TENANTS[t].code;
        document.getElementById('tenant-' + code).value = tenants[code] || DEFAULT_TENANTS[t].defaultName;
        document.getElementById('pct-' + code).value =
            (percentages[code] !== undefined) ? percentages[code] : DEFAULT_TENANTS[t].pct;
    }

    var emails = entry.emails || {};
    for (var e = 0; e < DEFAULT_TENANTS.length; e++) {
        var ecode = DEFAULT_TENANTS[e].code;
        document.getElementById('email-' + ecode).value = emails[ecode] || '';
    }

    document.getElementById('form-card').style.display = 'block';
}

/* ================================================
   PDF EXPORT
   ================================================ */
function exportPdf(year) {
    var entry = appData[year];
    if (!entry) return;

    var yearTenants = getTenantsForYear(entry);

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

    h += '<h1>Kostnadsoversikt ' + year + '</h1>';
    h += '<h2>Generert ' + new Date().toLocaleDateString('nb-NO') + '</h2>';

    h += '<div class="summary">';
    for (var si = 0; si < allCosts.length; si++) {
        h += '<div class="s-item"><div class="lbl">' + allCosts[si].label + '</div><div class="val">kr ' + fmt(allCosts[si].value) + '</div></div>';
    }
    h += '<div class="s-item s-total"><div class="lbl">Totalt</div><div class="val">kr ' + fmt(total) + '</div></div>';
    h += '</div>';

    h += '<table><thead><tr><th>Kostnad (pr. mnd)</th>';
    for (var ti = 0; ti < yearTenants.length; ti++) {
        h += '<th>' + yearTenants[ti].name + '<span class="pct">' + fmtPct(yearTenants[ti].pct) + '</span></th>';
    }
    h += '</tr></thead><tbody>';

    var pm = yearTenants.map(function() { return 0; });
    for (var ri = 0; ri < allCosts.length; ri++) {
        var monthly = allCosts[ri].value / 12;
        h += '<tr><td>' + allCosts[ri].label + '</td>';
        for (var pi = 0; pi < yearTenants.length; pi++) {
            var share = monthly * yearTenants[pi].pct / 100;
            pm[pi] += share;
            h += '<td>kr ' + fmt(share) + '</td>';
        }
        h += '</tr>';
    }

    h += '</tbody><tfoot><tr><td>Sum pr. mnd</td>';
    for (var mi = 0; mi < yearTenants.length; mi++) h += '<td>kr ' + fmt(pm[mi]) + '</td>';
    h += '</tr><tr><td>Sum pr. \u00e5r</td>';
    for (var ai = 0; ai < yearTenants.length; ai++) h += '<td>kr ' + fmt(pm[ai] * 12) + '</td>';
    h += '</tr></tfoot></table>';
    h += '<div class="footer">Fellesutgifter &mdash; ' + year + '</div></body></html>';

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
    var data = appData;
    var years = Object.keys(data).filter(function(k) { return k !== '_config'; }).sort();

    if (!isAdmin && currentUser) {
        years = years.filter(function(y) {
            var entry = data[y];
            if (!entry.emails || Object.keys(entry.emails).length === 0) return true;
            var vals = Object.keys(entry.emails).map(function(k) { return entry.emails[k]; });
            return vals.indexOf(currentUser.email) !== -1;
        });
    }

    var container = document.getElementById('tabs-container');

    if (years.length === 0) {
        var msg;
        if (!appData._config) {
            msg = 'Velkommen! Klikk \u00ab\u2699\ufe0f Administrer\u00bb for \u00e5 opprette en adresse.';
        } else if (isAdmin) {
            msg = 'Ingen data lagt til enn\u00e5. Klikk \u00ab\u2699\ufe0f Administrer\u00bb og fyll inn skjemaet.';
        } else {
            msg = 'Ingen data tilgjengelig enn\u00e5.';
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
    var yearTenants = getTenantsForYear(entry);

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
        html += '<div class="summary-item"><div class="label">' + allCosts[si].label + '</div><div class="value">kr ' + fmt(allCosts[si].value) + '</div></div>';
    }
    html += '<div class="summary-item" style="background:#1e3c72;color:#fff;"><div class="label" style="color:rgba(255,255,255,0.7);">Totalt</div><div class="value" style="color:#fff;">kr ' + fmt(total) + '</div></div>';
    html += '</div>';

    html += '<table><thead><tr><th>Kostnad (pr. mnd)</th>';
    for (var ti = 0; ti < yearTenants.length; ti++) {
        html += '<th>' + yearTenants[ti].name + '<span class="pct">' + fmtPct(yearTenants[ti].pct) + '</span></th>';
    }
    html += '</tr></thead><tbody>';

    var personTotalsMonthly = yearTenants.map(function() { return 0; });

    for (var ri = 0; ri < allCosts.length; ri++) {
        var val = allCosts[ri].value;
        var monthly = val / 12;
        html += '<tr><td>' + allCosts[ri].label + '</td>';
        for (var pj = 0; pj < yearTenants.length; pj++) {
            var share = monthly * yearTenants[pj].pct / 100;
            personTotalsMonthly[pj] += share;
            html += '<td>kr ' + fmt(share) + '</td>';
        }
        html += '</tr>';
    }

    html += '</tbody><tfoot><tr><td>Sum pr. mnd</td>';
    for (var mi = 0; mi < yearTenants.length; mi++) {
        html += '<td>kr ' + fmt(personTotalsMonthly[mi]) + '</td>';
    }
    html += '</tr><tr><td>Sum pr. \u00e5r</td>';
    for (var ai = 0; ai < yearTenants.length; ai++) {
        html += '<td>kr ' + fmt(personTotalsMonthly[ai] * 12) + '</td>';
    }
    html += '</tr></tfoot></table></div>';

    container.innerHTML = html;
}

function switchTab(year) {
    activeTab = String(year);
    render();
}
