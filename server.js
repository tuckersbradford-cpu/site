import 'dotenv/config';
import express from 'express';
import path from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;
const SITE_NAME = process.env.SITE_NAME || 'Video Vault';

const ebooksEnv =
  process.env.EBOOKS_SITE_URL ||
  process.env.VITE_CHECKOUT_URL ||
  process.env.VITE_PAYMENT_URL ||
  '';
const EBOOKS_SITE_URL = String(ebooksEnv || '').replace(/\/+$/, '');

const TELEGRAM_USERNAME =
  process.env.TELEGRAM_USERNAME ||
  process.env.VITE_TELEGRAM_USERNAME ||
  '';

const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.VITE_SUPABASE_URL ||
  process.env.VITE_PROJECT_URL ||
  '';

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_ANON_KEY ||
  process.env.VITE_SUPABASE_ANON_KEY ||
  '';

function trimEnv(...keys) {
  for (const k of keys) {
    const v = process.env[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function wasabiSecretFromEnv() {
  const c = {
    accessKey: trimEnv('WASABI_ACCESS_KEY', 'VITE_WASABI_ACCESS_KEY'),
    secretKey: trimEnv('WASABI_SECRET_KEY', 'VITE_WASABI_SECRET_KEY'),
    region: trimEnv('WASABI_REGION', 'VITE_WASABI_REGION'),
    bucket: trimEnv('WASABI_BUCKET', 'VITE_WASABI_BUCKET'),
    endpoint: trimEnv('WASABI_ENDPOINT', 'VITE_WASABI_ENDPOINT').replace(/\/+$/, ''),
  };
  const signingReady = Boolean(
    c.accessKey && c.secretKey && c.bucket && c.region && c.endpoint
  );
  return { ...c, signingReady };
}

function normalizeWasabiConfigRow(wc) {
  if (!wc || typeof wc !== 'object') return null;
  const c = {
    accessKey: String(wc.accessKey || wc.access_key || '').trim(),
    secretKey: String(wc.secretKey || wc.secret_key || '').trim(),
    region: String(wc.region || '').trim(),
    bucket: String(wc.bucket || '').trim(),
    endpoint: String(wc.endpoint || '').replace(/\/+$/, ''),
  };
  const signingReady = Boolean(
    c.accessKey && c.secretKey && c.bucket && c.region && c.endpoint
  );
  return { ...c, signingReady };
}

let supabaseWasabiCache = null;
let supabaseWasabiCacheAt = 0;
const WASABI_CACHE_MS = 120_000;

async function resolveWasabiSigningConfig() {
  const fromEnv = wasabiSecretFromEnv();
  if (fromEnv.signingReady) return fromEnv;

  const now = Date.now();
  if (supabaseWasabiCache && now - supabaseWasabiCacheAt < WASABI_CACHE_MS) {
    return supabaseWasabiCache;
  }

  let merged = { ...fromEnv, signingReady: false };
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('site_config')
        .select('wasabi_config')
        .limit(1)
        .maybeSingle();
      if (!error && data?.wasabi_config) {
        const fromDb = normalizeWasabiConfigRow(data.wasabi_config);
        if (fromDb?.signingReady) {
          merged = fromDb;
        } else if (fromDb && fromEnv.accessKey && fromEnv.secretKey) {
          merged = {
            accessKey: fromEnv.accessKey,
            secretKey: fromEnv.secretKey,
            region: fromDb.region || fromEnv.region,
            bucket: fromDb.bucket || fromEnv.bucket,
            endpoint: (fromDb.endpoint || fromEnv.endpoint || '').replace(/\/+$/, ''),
            signingReady: Boolean(
              fromEnv.accessKey &&
                fromEnv.secretKey &&
                (fromDb.bucket || fromEnv.bucket) &&
                (fromDb.region || fromEnv.region) &&
                (fromDb.endpoint || fromEnv.endpoint)
            ),
          };
        }
      }
    } catch (e) {
      console.warn('Wasabi site_config read failed:', e.message);
    }
  }

  supabaseWasabiCache = merged;
  supabaseWasabiCacheAt = now;
  return merged;
}

function isHttpUrl(val) {
  const s = String(val || '').trim();
  return /^https?:\/\//i.test(s);
}

/** Same shape as main app: site_config.crypto jsonb array of "SYMBOL:address" strings or objects. */
function normalizeCryptoWalletEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string') {
    const s = entry.trim();
    if (!s) return null;
    const idx = s.indexOf(':');
    if (idx <= 0) {
      return { symbol: 'CRYPTO', address: s, label: 'Wallet' };
    }
    const symbol = s.slice(0, idx).trim() || 'CRYPTO';
    const address = s.slice(idx + 1).trim();
    if (!address) return null;
    return { symbol, address, label: symbol.toUpperCase() };
  }
  if (typeof entry === 'object') {
    const symbol = String(entry.symbol || entry.coin || entry.currency || '').trim() || 'CRYPTO';
    const address = String(entry.address || entry.addr || '').trim();
    if (!address) return null;
    const label = String(entry.label || entry.network || symbol).trim() || symbol.toUpperCase();
    return { symbol, address, label };
  }
  return null;
}

function normalizeCryptoList(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeCryptoWalletEntry).filter(Boolean);
}

function mergeCryptoDedup(a, b) {
  const seen = new Set();
  const out = [];
  for (const list of [a, b]) {
    for (const w of list) {
      const key = `${String(w.address)}|${String(w.symbol || '')}`;
      if (!w.address || seen.has(key)) continue;
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}

function sortSources(list) {
  if (!Array.isArray(list)) return [];
  return [...list].sort((a, b) => (Number(a?.position ?? 0) || 0) - (Number(b?.position ?? 0) || 0));
}

/**
 * Keys for signing only. Do NOT put path-style public URLs here — private buckets return 403 in <img>/<video>.
 */
function enrichVideoRow(row) {
  const sortedSources = sortSources(row.video_sources);
  const primarySource = sortedSources[0];

  const vk = row.video_file_id || primarySource?.source_file_id || null;
  const tk = row.thumbnail_file_id || primarySource?.thumbnail_file_id || null;

  const wasabi_video_key = vk ? String(vk).trim() : null;
  const wasabi_thumb_key = tk ? String(tk).trim() : null;

  return {
    ...row,
    video_sources: sortedSources,
    /** Only explicit public URLs stored in DB */
    playback_url:
      row.public_video_url && isHttpUrl(row.public_video_url)
        ? String(row.public_video_url).trim()
        : '',
    poster_url:
      row.thumbnail_url && isHttpUrl(row.thumbnail_url) ? String(row.thumbnail_url).trim() : '',
    wasabi_video_key,
    wasabi_thumb_key,
  };
}

async function signingClientAndBucket() {
  const cfg = await resolveWasabiSigningConfig();
  if (!cfg.signingReady) return { cfg, client: null };
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKey,
      secretAccessKey: cfg.secretKey,
    },
    forcePathStyle: true,
  });
  return { cfg, client };
}

function sanitizeObjectKey(raw) {
  try {
    if (typeof raw !== 'string') raw = String(raw || '');
    raw = decodeURIComponent(raw.trim());
  } catch {
    raw = String(raw || '').trim();
  }
  if (!raw || raw.startsWith('metadata/')) return null;
  return raw;
}

app.use(express.json());

let supabase;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

app.get('/api/health', async (req, res) => {
  const w = await resolveWasabiSigningConfig();
  res.json({
    status: 'OK',
    site: SITE_NAME,
    supabase: Boolean(supabase),
    ebooks_checkout_origin: Boolean(EBOOKS_SITE_URL),
    telegram: Boolean(String(TELEGRAM_USERNAME || '').trim()),
    wasabi_signed_urls: Boolean(w.signingReady),
    wasabi_from_env: Boolean(wasabiSecretFromEnv().signingReady),
  });
});

async function handleSignedUrlRequest(req, res) {
  try {
    let fileId = req.params.fileId;
    if (!fileId && req.query.key != null) {
      fileId = Array.isArray(req.query.key) ? req.query.key[0] : req.query.key;
    }
    fileId = sanitizeObjectKey(fileId);
    if (!fileId) {
      return res.status(400).json({ error: 'Missing or invalid object key (use ?key=... or path).' });
    }

    const { cfg, client } = await signingClientAndBucket();
    if (!client || !cfg.signingReady) {
      return res.status(503).json({
        error:
          'Wasabi signing not configured. Set WASABI_* or VITE_WASABI_* env vars on this service, or store full wasabi_config in Supabase site_config.',
      });
    }

    const command = new GetObjectCommand({
      Bucket: cfg.bucket,
      Key: fileId,
    });
    const url = await getSignedUrl(client, command, { expiresIn: 3600 });
    res.json({ success: true, url, expiresIn: 3600 });
  } catch (error) {
    console.error('signed-url error:', error.name, error.message);
    res.status(500).json({
      error: 'Failed to generate signed URL',
      details: error.message,
      code: error.name || '',
    });
  }
}

/** Prefer ?key=... — safe for keys that contain slashes (Express path params vary). */
app.get('/api/signed-url', handleSignedUrlRequest);
app.get('/api/signed-url/:fileId', handleSignedUrlRequest);

app.get('/api/video-ids', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
    const { data, error } = await supabase
      .from('videos')
      .select('id')
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) return res.status(502).json({ error: error.message });
    res.json({ ids: (data || []).map((r) => r.id).filter(Boolean) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to list ids' });
  }
});

/** Telegram username: Supabase site_config first, then env (videos-site). */
async function resolveTelegramUsername() {
  let telegram = TELEGRAM_USERNAME;
  if (supabase) {
    try {
      const { data } = await supabase
        .from('site_config')
        .select('telegram_username')
        .limit(1)
        .maybeSingle();
      if (data?.telegram_username) telegram = data.telegram_username;
    } catch (e) {
      console.warn('site_config telegram_username read failed:', e.message);
    }
  }
  return String(telegram || '').replace(/^@/, '').trim();
}

app.get('/api/site-brief', async (req, res) => {
  try {
    let videoListTitle = trimEnv('VIDEO_LIST_TITLE', 'VITE_VIDEO_LIST_TITLE');
    let telegram = await resolveTelegramUsername();
    let cryptoFromDb = [];
    if (supabase) {
      const { data } = await supabase
        .from('site_config')
        .select('video_list_title, telegram_username, crypto')
        .limit(1)
        .maybeSingle();
      if (data?.video_list_title) videoListTitle = data.video_list_title;
      if (data?.telegram_username) telegram = String(data.telegram_username).replace(/^@/, '').trim();
      cryptoFromDb = normalizeCryptoList(data?.crypto);
    }
    const cryptoFromEnv = normalizeCryptoList(trimEnv('CRYPTO_WALLETS_JSON', 'VITE_CRYPTO_WALLETS_JSON'));
    const crypto_wallets = mergeCryptoDedup(cryptoFromDb, cryptoFromEnv);
    res.json({
      video_list_title: videoListTitle || '',
      telegram_username: (telegram || '').replace(/^@/, ''),
      crypto_wallets,
    });
  } catch {
    const crypto_wallets = normalizeCryptoList(trimEnv('CRYPTO_WALLETS_JSON', 'VITE_CRYPTO_WALLETS_JSON'));
    res.json({
      video_list_title: '',
      telegram_username: (TELEGRAM_USERNAME || '').replace(/^@/, ''),
      crypto_wallets,
    });
  }
});

app.post('/api/videos/:id/views', async (req, res) => {
  try {
    if (!supabase) return res.status(500).json({ error: 'Supabase not configured' });
    const id = req.params.id;
    const { error: rpcErr } = await supabase.rpc('increment', {
      table_name: 'videos',
      row_id: id,
      column_name: 'views',
    });
    if (rpcErr) {
      const { data: current } = await supabase.from('videos').select('views').eq('id', id).maybeSingle();
      await supabase
        .from('videos')
        .update({ views: (current?.views || 0) + 1 })
        .eq('id', id);
    }
    const { data: row } = await supabase.from('videos').select('views').eq('id', id).maybeSingle();
    res.json({ views: row?.views ?? 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to increment views' });
  }
});

app.get('/api/videos/:id', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        error: 'Supabase not configured (set SUPABASE_URL / VITE_SUPABASE_URL plus anon or service role key).',
      });
    }

    const id = req.params.id;
    const joined = await supabase
      .from('videos')
      .select('*, video_sources(*)')
      .eq('id', id)
      .eq('is_active', true)
      .maybeSingle();

    let row = joined.data;
    if (joined.error && /relationship|foreign|video_sources|schema cache/i.test(String(joined.error.message || ''))) {
      const fb = await supabase.from('videos').select('*').eq('id', id).eq('is_active', true).maybeSingle();
      if (fb.error) {
        return res.status(502).json({ error: fb.error.message || 'Database error' });
      }
      row = fb.data;
    } else if (joined.error) {
      return res.status(502).json({ error: joined.error.message || 'Database error' });
    }

    if (!row) return res.status(404).json({ error: 'Video not found' });

    const w = await resolveWasabiSigningConfig();
    const payload = {
      ...enrichVideoRow(row),
      wasabi_signing_ready: Boolean(w.signingReady),
    };

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ video: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load video' });
  }
});

app.get('/api/videos', async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({
        error: 'Supabase not configured (set SUPABASE_URL / VITE_SUPABASE_URL plus anon or service role key).',
      });
    }

    const baseQuery = () => supabase.from('videos').select('*').eq('is_active', true);

    let rows = [];

    const joined = await supabase
      .from('videos')
      .select('*, video_sources(*)')
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (joined.error && /relationship|foreign|video_sources|schema cache/i.test(String(joined.error.message || ''))) {
      const fb = await baseQuery().order('created_at', { ascending: false });
      if (fb.error) {
        console.error('Supabase videos error:', fb.error);
        return res.status(502).json({ error: fb.error.message || 'Database error' });
      }
      rows = fb.data || [];
    } else if (joined.error) {
      console.error('Supabase videos error:', joined.error);
      return res.status(502).json({ error: joined.error.message || 'Database error' });
    } else {
      rows = joined.data || [];
    }

    rows.sort((a, b) => {
      const sa = Number(a?.sort_order);
      const sb = Number(b?.sort_order);
      if (Number.isFinite(sa) && Number.isFinite(sb) && sa !== sb) return sa - sb;
      if (Number.isFinite(sa) && !Number.isFinite(sb)) return -1;
      if (!Number.isFinite(sa) && Number.isFinite(sb)) return 1;
      return new Date(b?.created_at || 0) - new Date(a?.created_at || 0);
    });

    const w = await resolveWasabiSigningConfig();
    const payload = rows.map(enrichVideoRow).map((r) => ({
      ...r,
      wasabi_signing_ready: Boolean(w.signingReady),
    }));

    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json({ videos: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

async function renderHtmlTemplate(fileName) {
  const telegram = await resolveTelegramUsername();
  const html = readFileSync(path.join(__dirname, 'public', fileName), 'utf8');
  return html
    .replace(/\{\{SITE_NAME\}\}/g, SITE_NAME)
    .replace(/\{\{TELEGRAM_USERNAME\}\}/g, telegram)
    .replace(/\{\{EBOOKS_SITE_URL\}\}/g, EBOOKS_SITE_URL);
}

app.get('/', async (req, res) => {
  try {
    res.type('html').send(await renderHtmlTemplate('index.html'));
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/watch/:id', (req, res) => {
  res.redirect(302, `/watch?id=${encodeURIComponent(req.params.id)}`);
});

app.get('/watch', async (req, res) => {
  try {
    res.type('html').send(await renderHtmlTemplate('watch.html'));
  } catch {
    res.sendFile(path.join(__dirname, 'public', 'watch.html'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${SITE_NAME} — videos storefront on port ${PORT}`);
});
