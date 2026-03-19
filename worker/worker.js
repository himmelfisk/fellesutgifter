/**
 * Cloudflare Worker — GitHub proxy for Fellesutgifter.
 *
 * Environment variables (set as secrets in Cloudflare dashboard):
 *   GITHUB_TOKEN   — GitHub Personal Access Token with "repo" scope
 *
 * Environment variables (plain text):
 *   GITHUB_REPO    — e.g. "himmelfisk/fellesutgifter"
 *   GOOGLE_CLIENT_ID — Google OAuth client ID for token verification
 *   ALLOWED_ORIGIN — e.g. "https://himmelfisk.github.io"
 */

export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return corsResponse(env, new Response(null, { status: 204 }));
    }

    try {
      // Only accept POST (we use POST for all write operations)
      if (request.method !== 'POST') {
        return corsResponse(env, jsonResponse(405, { error: 'Method not allowed' }));
      }

      // Verify Google ID token
      const authHeader = request.headers.get('Authorization') || '';
      const idToken = authHeader.replace('Bearer ', '');
      if (!idToken) {
        return corsResponse(env, jsonResponse(401, { error: 'Mangler autentisering' }));
      }

      const tokenResult = await verifyGoogleToken(idToken, env.GOOGLE_CLIENT_ID);
      if (tokenResult.error) {
        return corsResponse(env, jsonResponse(401, { error: 'Ugyldig Google-token', detail: tokenResult.error, clientIdSet: !!env.GOOGLE_CLIENT_ID }));
      }
      const googleUser = tokenResult.user;

      // Parse request body
      const body = await request.json();
      const { action, path, data, sha, message } = body;

      if (!path) {
        return corsResponse(env, jsonResponse(400, { error: 'Mangler path' }));
      }

      // Check admin authorization by reading the relevant config file
      const isAuthorized = await checkAdminAccess(googleUser.email, path, env);
      if (!isAuthorized) {
        return corsResponse(env, jsonResponse(403, { error: 'Ikke autorisert som administrator' }));
      }

      let result;
      if (action === 'delete') {
        result = await githubDelete(path, sha, env);
      } else {
        result = await githubWrite(path, data, sha, message, env);
      }

      return corsResponse(env, jsonResponse(200, result));
    } catch (err) {
      return corsResponse(env, jsonResponse(500, { error: err.message || 'Intern feil' }));
    }
  }
};

async function verifyGoogleToken(idToken, clientId) {
  try {
    const res = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken));
    if (!res.ok) {
      const errText = await res.text();
      return { error: 'Google tokeninfo HTTP ' + res.status + ': ' + errText };
    }
    const info = await res.json();
    if (info.aud !== clientId) {
      return { error: 'AUD mismatch. Token aud: ' + info.aud + ' Expected: ' + clientId };
    }
    return { user: { email: info.email.toLowerCase().trim(), name: info.name || info.email } };
  } catch (err) {
    return { error: 'Token verification exception: ' + err.message };
  }
}

async function checkAdminAccess(email, path, env) {
  // For addresses.json — check if user is admin in ANY address config
  // For data/{id}.json or data/{id}-{year}.json — check that specific address config
  // First-time setup (no addresses.json yet) — allow anyone
  const repo = env.GITHUB_REPO;
  const token = env.GITHUB_TOKEN;

  // Extract address ID from path
  const match = path.match(/^data\/([a-z0-9]{8})(?:-.+)?\.json$/);

  if (path === 'data/addresses.json') {
    // User must be admin of at least one address, or addresses.json doesn't exist yet
    const addressesRes = await fetch(`https://api.github.com/repos/${repo}/contents/data/addresses.json`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': `token ${token}`, 'User-Agent': 'FellesutgifterWorker' }
    });
    if (addressesRes.status === 404) return true; // First-time setup
    if (!addressesRes.ok) return false;
    const addressesFile = await addressesRes.json();
    const addresses = JSON.parse(atob(addressesFile.content.replace(/\n/g, '')));
    if (addresses.length === 0) return true;

    // Check each address config for admin membership
    let anyConfigFound = false;
    for (const addr of addresses) {
      const configRes = await fetch(`https://api.github.com/repos/${repo}/contents/data/${addr.id}.json`, {
        headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': `token ${token}`, 'User-Agent': 'FellesutgifterWorker' }
      });
      if (!configRes.ok) continue;
      anyConfigFound = true;
      const configFile = await configRes.json();
      const config = JSON.parse(atob(configFile.content.replace(/\n/g, '')));
      if (config.admins && config.admins.includes(email)) return true;
    }
    // If no config files exist (all deleted), treat as fresh setup
    if (!anyConfigFound) return true;
    return false;
  }

  if (!match) return false;
  const addressId = match[1];

  // Read the address config to check admins
  const configRes = await fetch(`https://api.github.com/repos/${repo}/contents/data/${addressId}.json`, {
    headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': `token ${token}`, 'User-Agent': 'FellesutgifterWorker' }
  });

  if (configRes.status === 404) {
    // New address being created — check addresses.json to see if it's truly new
    return true;
  }
  if (!configRes.ok) return false;

  const configFile = await configRes.json();
  const config = JSON.parse(atob(configFile.content.replace(/\n/g, '')));

  if (!config.admins || config.admins.length === 0) return true;
  return config.admins.includes(email);
}

async function githubWrite(path, data, sha, message, env) {
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(data, null, 2))));
  const body = { message: message || `Oppdater ${path}`, content };
  if (sha) body.sha = sha;

  let res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'PUT',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'FellesutgifterWorker'
    },
    body: JSON.stringify(body)
  });

  // Handle 409 SHA conflict by fetching current SHA and retrying once
  if (res.status === 409) {
    const freshRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': `token ${env.GITHUB_TOKEN}`, 'User-Agent': 'FellesutgifterWorker' }
    });
    if (freshRes.ok) {
      const freshFile = await freshRes.json();
      body.sha = freshFile.sha;
    } else {
      delete body.sha;
    }
    res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
      method: 'PUT',
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'User-Agent': 'FellesutgifterWorker'
      },
      body: JSON.stringify(body)
    });
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub PUT feilet (${res.status}): ${errText}`);
  }

  const result = await res.json();
  return { sha: result.content ? result.content.sha : null };
}

async function githubDelete(path, sha, env) {
  if (!sha) throw new Error('SHA kreves for sletting');
  let res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
    method: 'DELETE',
    headers: {
      'Accept': 'application/vnd.github.v3+json',
      'Authorization': `token ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'FellesutgifterWorker'
    },
    body: JSON.stringify({ message: `Slett ${path}`, sha })
  });

  // Handle 409 SHA conflict by fetching current SHA and retrying
  if (res.status === 409) {
    const freshRes = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
      headers: { 'Accept': 'application/vnd.github.v3+json', 'Authorization': `token ${env.GITHUB_TOKEN}`, 'User-Agent': 'FellesutgifterWorker' }
    });
    if (freshRes.ok) {
      const freshFile = await freshRes.json();
      res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`, {
        method: 'DELETE',
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'Authorization': `token ${env.GITHUB_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'FellesutgifterWorker'
        },
        body: JSON.stringify({ message: `Slett ${path}`, sha: freshFile.sha })
      });
    } else if (freshRes.status === 404) {
      return { deleted: true }; // Already deleted
    }
  }

  // File already gone — treat as success
  if (res.status === 404) return { deleted: true };

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub DELETE feilet (${res.status}): ${errText}`);
  }
  return { deleted: true };
}

function jsonResponse(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function corsResponse(env, response) {
  const origin = env.ALLOWED_ORIGIN || '*';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(response.body, {
    status: response.status,
    headers
  });
}
