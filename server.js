'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
const REDEMPTIONS_FILE = path.join(DATA_DIR, 'redemptions.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ADMIN_USER = (process.env.ADMIN_USER || '').trim();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_AUTH_CONFIGURED = Boolean(ADMIN_USER && ADMIN_PASSWORD);

const demoCampaign = {
  path: 'demo',
  title: 'Shadow Crown',
  description: 'A legendary crown infused with shadows. Only available through special events.',
  image: '/redeem-banner.png'
};

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  if (!fs.existsSync(CAMPAIGNS_FILE)) {
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify([demoCampaign], null, 2), 'utf8');
  }

  if (!fs.existsSync(REDEMPTIONS_FILE)) {
    fs.writeFileSync(REDEMPTIONS_FILE, '[]\n', 'utf8');
  }
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function writeJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function requiresAdminAccess(pathname) {
  return pathname === '/admin' || pathname === '/admin.html' || pathname === '/api/campaigns';
}

function matchesSecret(actual, expected) {
  const actualDigest = crypto.createHash('sha256').update(actual).digest();
  const expectedDigest = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

function hasValidAdminCredentials(req) {
  if (!ADMIN_AUTH_CONFIGURED) return false;

  const authorization = req.headers.authorization || '';
  if (!authorization.startsWith('Basic ')) return false;

  let decoded;
  try {
    decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }

  const separatorIndex = decoded.indexOf(':');
  if (separatorIndex < 0) return false;

  const username = decoded.slice(0, separatorIndex);
  const password = decoded.slice(separatorIndex + 1);
  return matchesSecret(username, ADMIN_USER) && matchesSecret(password, ADMIN_PASSWORD);
}

function rejectAdminAccess(res, statusCode, message) {
  res.writeHead(statusCode, {
    'www-authenticate': 'Basic realm="Reward Campaign Panel", charset="UTF-8"',
    'cache-control': 'no-store',
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(message)
  });
  res.end(message);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function isValidPath(value) {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 80;
}

function getPathFromUrl(urlPath, prefix) {
  const value = decodeURIComponent(urlPath.slice(prefix.length));
  return value.replace(/^\/+|\/+$/g, '');
}

function getCampaign(pathKey) {
  const campaigns = readJson(CAMPAIGNS_FILE, []);
  return campaigns.find((campaign) => campaign.path === pathKey) || null;
}

function publicCampaign(campaign) {
  return {
    path: campaign.path,
    title: campaign.title,
    description: campaign.description,
    image: campaign.image
  };
}

function createCode(redemptions, campaignPath) {
  let code;
  do {
    const bytes = crypto.randomBytes(14);
    let suffix = '';
    for (const byte of bytes) suffix += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    code = `RB${suffix}`;
  } while (redemptions.some((redemption) => redemption.code === code));

  redemptions.push({
    code,
    path: campaignPath,
    used: false,
    createdAt: new Date().toISOString()
  });

  return code;
}

function validateCampaign(body) {
  const pathKey = typeof body.path === 'string' ? body.path.trim().toLowerCase() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  const image = typeof body.image === 'string' ? body.image.trim() : '';

  if (!isValidPath(pathKey)) {
    return { error: 'Path must use lowercase letters, numbers, and hyphens only.' };
  }
  if (title.length < 1 || title.length > 100) {
    return { error: 'Title must contain between 1 and 100 characters.' };
  }
  if (description.length < 1 || description.length > 500) {
    return { error: 'Description must contain between 1 and 500 characters.' };
  }
  if (!/^data:image\/(png|jpeg|webp|gif);base64,[a-z0-9+/=\r\n]+$/i.test(image) && !/^\/[a-z0-9._/-]+$/i.test(image)) {
    return { error: 'Upload a PNG, JPG, WEBP, or GIF reward image.' };
  }
  if (image.length > 7 * 1024 * 1024) {
    return { error: 'The reward image is too large. Keep it under 5 MB.' };
  }

  return { campaign: { path: pathKey, title, description, image } };
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon'
};

function serveStatic(res, pathname) {
  const relativePath = pathname === '/' ? 'redeem.html' : decodeURIComponent(pathname.slice(1));
  const isPublicCampaignData = relativePath === 'data/campaigns.json';
  if ((relativePath.startsWith('data/') && !isPublicCampaignData) || relativePath.includes('\\')) {
    sendText(res, 404, 'Not found');
    return;
  }

  const filePath = path.resolve(ROOT_DIR, relativePath);
  if (filePath !== ROOT_DIR && !filePath.startsWith(`${ROOT_DIR}${path.sep}`)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendText(res, 404, 'Not found');
      return;
    }

    const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const cacheControl = path.extname(filePath).toLowerCase() === '.html'
      ? 'no-store, no-cache, must-revalidate'
      : 'public, max-age=3600';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': stats.size,
      'cache-control': cacheControl
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function handleRequest(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = requestUrl.pathname;

  if (requiresAdminAccess(pathname)) {
    if (!ADMIN_AUTH_CONFIGURED) {
      rejectAdminAccess(res, 503, 'Admin access is not configured. Set ADMIN_USER and ADMIN_PASSWORD first.');
      return;
    }
    if (!hasValidAdminCredentials(req)) {
      rejectAdminAccess(res, 401, 'Admin authentication required.');
      return;
    }
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/admin') {
    redirect(res, '/admin.html');
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/q/')) {
    const pathKey = getPathFromUrl(pathname, '/q/');
    if (!isValidPath(pathKey) || !getCampaign(pathKey)) {
      sendText(res, 404, 'This QR campaign was not found.');
      return;
    }
    const redeemParameters = new URLSearchParams({ path: pathKey });
    const requestedCode = requestUrl.searchParams.get('code');
    if (requestedCode) redeemParameters.set('code', requestedCode);
    redirect(res, `/redeem.html?${redeemParameters.toString()}`);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/campaign/')) {
    const pathKey = getPathFromUrl(pathname, '/api/campaign/');
    const campaign = isValidPath(pathKey) ? getCampaign(pathKey) : null;
    if (!campaign) {
      sendJson(res, 404, { error: 'Campaign not found.' });
      return;
    }

    const redemptions = readJson(REDEMPTIONS_FILE, []);
    const code = createCode(redemptions, campaign.path);
    writeJson(REDEMPTIONS_FILE, redemptions);
    sendJson(res, 200, { code, campaign: publicCampaign(campaign) });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/campaigns') {
    const campaigns = readJson(CAMPAIGNS_FILE, []);
    sendJson(res, 200, campaigns.map((campaign) => ({
      path: campaign.path,
      title: campaign.title,
      description: campaign.description,
      hasImage: Boolean(campaign.image)
    })));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/campaigns') {
    const body = await parseJsonBody(req);
    const result = validateCampaign(body);
    if (result.error) {
      sendJson(res, 400, { error: result.error });
      return;
    }

    const campaigns = readJson(CAMPAIGNS_FILE, []);
    const existingIndex = campaigns.findIndex((campaign) => campaign.path === result.campaign.path);
    if (existingIndex === -1) campaigns.push(result.campaign);
    else campaigns[existingIndex] = result.campaign;
    writeJson(CAMPAIGNS_FILE, campaigns);

    sendJson(res, 201, {
      campaign: publicCampaign(result.campaign),
      qrUrl: `/q/${encodeURIComponent(result.campaign.path)}`
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/redeem') {
    const body = await parseJsonBody(req);
    const pathKey = typeof body.path === 'string' ? body.path.trim().toLowerCase() : '';
    const code = typeof body.code === 'string' ? body.code.trim().toUpperCase() : '';
    const redemptions = readJson(REDEMPTIONS_FILE, []);
    const redemption = redemptions.find((item) => item.code === code && item.path === pathKey);

    if (!redemption) {
      sendJson(res, 400, { error: 'This code does not match the selected QR campaign.' });
      return;
    }
    if (redemption.used) {
      sendJson(res, 409, { error: 'This code has already been redeemed.' });
      return;
    }

    const campaign = getCampaign(pathKey);
    if (!campaign) {
      sendJson(res, 404, { error: 'Campaign not found.' });
      return;
    }

    redemption.used = true;
    redemption.redeemedAt = new Date().toISOString();
    writeJson(REDEMPTIONS_FILE, redemptions);
    sendJson(res, 200, { reward: publicCampaign(campaign) });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(res, pathname);
    return;
  }

  sendText(res, 405, 'Method not allowed');
}

ensureStorage();

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const statusCode = error.statusCode || 500;
    if (!res.headersSent) sendJson(res, statusCode, { error: statusCode === 500 ? 'Internal server error.' : error.message });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Redeem flow running at http://${displayHost}:${PORT}`);
  console.log(`Admin panel: http://${displayHost}:${PORT}/admin.html`);
  if (!ADMIN_AUTH_CONFIGURED) {
    console.warn('Admin panel locked: set ADMIN_USER and ADMIN_PASSWORD before opening it.');
  }
});
