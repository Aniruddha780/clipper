import express from 'express';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');
const DIST_DIR = path.join(DASHBOARD_DIR, 'dist');
const DEMO_DIR = path.join(DASHBOARD_DIR, 'public', 'demo');
const SCREENS_DIR = path.join(DASHBOARD_DIR, 'public', 'screens');

const TMP_BASE = '/tmp/openshorts';
const UPLOAD_DIR = path.join(TMP_BASE, 'uploads');
const OUTPUT_DIR = path.join(TMP_BASE, 'output');
const THUMBNAILS_DIR = path.join(OUTPUT_DIR, 'thumbnails');
const DEMO_CACHE_DIR = path.join(TMP_BASE, 'demo');
const GALLERY_FILE = path.join(TMP_BASE, 'gallery.json');

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, THUMBNAILS_DIR, DEMO_CACHE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// In-memory stores (ephemeral container storage)
const jobs = new Map();
const pendingUploads = new Map();
const thumbnailSessions = new Map();
const saasJobs = new Map();
const publishJobs = new Map();

function clipFileExistsForUrl(videoUrl) {
  if (!videoUrl || typeof videoUrl !== 'string') return false;
  const m = videoUrl.match(/^\/videos\/([^/]+)\/([^/?#]+)$/);
  if (!m || !isSafeId(m[1])) return false;
  const target = path.join(OUTPUT_DIR, m[1], safeBasename(m[2]));
  return fs.existsSync(target);
}

function formatClipForGallery(job, clip, idx) {
  const start = Number(clip.start) || 0;
  const end = Number(clip.end) || start + 20;
  return {
    video_id: `${job.id}_${idx}`,
    job_id: job.id,
    title: clip.video_title_for_youtube_short || `Clip ${idx + 1}`,
    video_url: clip.video_url,
    actor_url: null,
    duration: Math.max(1, Math.round(end - start)),
    predicted_score: clip.predicted_score ?? null,
    caption: clip.video_description_for_tiktok || clip.why || '',
    hashtags: [],
    created_at: job.createdAt || Date.now(),
  };
}

function readPersistedGallery() {
  try {
    if (!fs.existsSync(GALLERY_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function syncJobToGallery(job) {
  if (!job?.id || !Array.isArray(job.result?.clips)) return;
  try {
    const existing = readPersistedGallery().filter((item) => item?.job_id !== job.id);
    const nextEntries = job.result.clips
      .map((clip, idx) => formatClipForGallery(job, clip, idx))
      .filter((entry) => clipFileExistsForUrl(entry.video_url));
    const merged = [...nextEntries, ...existing].slice(0, 200);
    fs.writeFileSync(GALLERY_FILE, JSON.stringify(merged, null, 2));
  } catch (err) {
    console.warn('[Clipper] Failed to persist gallery metadata:', err?.message || err);
  }
}

function listUserCreatedVideos(limit = 100) {
  const byId = new Map();
  for (const job of jobs.values()) {
    if (job.status !== 'completed' || !Array.isArray(job.result?.clips)) continue;
    job.result.clips.forEach((clip, idx) => {
      const entry = formatClipForGallery(job, clip, idx);
      if (clipFileExistsForUrl(entry.video_url)) {
        byId.set(entry.video_id, entry);
      }
    });
  }
  for (const entry of readPersistedGallery()) {
    if (!entry?.video_id || byId.has(entry.video_id)) continue;
    if (clipFileExistsForUrl(entry.video_url)) {
      byId.set(entry.video_id, entry);
    }
  }
  return Array.from(byId.values())
    .sort((a, b) => (Number(b.created_at) || 0) - (Number(a.created_at) || 0))
    .slice(0, limit);
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 512 * 1024 * 1024 },
});

function resolveGeminiKey(req) {
  const headerKey = req.get('X-Gemini-Key') || req.get('x-gemini-key');
  const key = (headerKey || process.env.GEMINI_API_KEY || '').trim();
  return key || null;
}

function getGenAI(apiKey) {
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

function safeBasename(name, fallback = 'file') {
  return path.basename(String(name || fallback)).replace(/[^A-Za-z0-9._-]/g, '_') || fallback;
}

function isSafeId(id) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(id || ''));
}

async function ffprobeDuration(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'csv=p=0',
      filePath,
    ], { timeout: 15000 });
    const d = parseFloat(stdout.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

async function ffprobeVideoInfo(filePath) {
  try {
    const { stdout } = await execFileAsync('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration',
      '-show_entries', 'format=duration',
      '-of', 'json',
      filePath,
    ], { timeout: 15000 });
    const data = JSON.parse(stdout || '{}');
    const stream = data.streams?.[0] || {};
    const duration = parseFloat(stream.duration || data.format?.duration || '0') || 30;
    return {
      width: Number(stream.width) || 1280,
      height: Number(stream.height) || 720,
      duration,
    };
  } catch {
    return { width: 1280, height: 720, duration: 30 };
  }
}

async function cutClipWithFfmpeg(sourcePath, outPath, startSec, durationSec, outputFormat = 'vertical', cropOffsetFrac = 0.5) {
  let vf = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';
  if (outputFormat === 'square') {
    vf = 'scale=1080:1080:force_original_aspect_ratio=increase,crop=1080:1080';
  } else if (outputFormat === 'horizontal') {
    vf = 'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2';
  } else if (Number.isFinite(cropOffsetFrac) && cropOffsetFrac !== 0.5) {
    const clamped = Math.min(0.85, Math.max(0.15, cropOffsetFrac));
    vf = `scale=-2:1920,crop=1080:1920:(iw-1080)*${clamped.toFixed(3)}:0`;
  }

  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', String(Math.max(0, startSec)),
    '-i', sourcePath,
    '-t', String(Math.max(3, durationSec)),
    '-vf', vf,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '26',
    '-c:a', 'aac',
    '-b:a', '96k',
    '-movflags', '+faststart',
    outPath,
  ], { timeout: 120000 });
}

function buildWordsForClip(clipText, startSec, endSec) {
  const tokens = String(clipText || 'Here is one of the strongest moments from this video that captures the core insight cleanly.')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const dur = Math.max(1, endSec - startSec);
  const step = dur / Math.max(1, tokens.length);
  return tokens.map((w, idx) => ({
    word: (idx === 0 ? '' : ' ') + w,
    start: Number((startSec + idx * step).toFixed(3)),
    end: Number((startSec + (idx + 1) * step).toFixed(3)),
  }));
}

async function generateClipMetadataWithGemini(apiKey, contextHint, count = 3, duration = 60) {
  const fallback = Array.from({ length: count }, (_, i) => {
    const segDur = Math.min(24, Math.max(12, Math.floor(duration / count)));
    const start = Number((i * segDur).toFixed(2));
    const end = Number(Math.min(duration, start + segDur).toFixed(2));
    const titles = [
      'The single insight nobody talks about',
      'Why this changes everything going forward',
      'The turning point of the entire conversation',
      'What actually happened behind the scenes',
      'The lesson worth repeating twice',
    ];
    const hooks = [
      'WAIT FOR THE REALIZATION',
      'MOST PEOPLE MISS THIS PART',
      'THIS CHANGED EVERYTHING',
      'HERE IS THE REAL REASON',
      'STOP SCROLLING FOR THIS',
    ];
    const scripts = [
      'Most people overlook the simplest part of the process, and that one detail makes all the difference when you scale it up.',
      'Once we stepped back and looked at what actually moved the needle, the answer was right in front of us the whole time.',
      'If you remember only one takeaway from this whole conversation, let it be how quickly small habits compound.',
    ];
    return {
      start,
      end,
      predicted_score: 88 - i * 4,
      video_title_for_youtube_short: titles[i % titles.length],
      video_description_for_tiktok: `${titles[i % titles.length]} #shorts #viral #clips`,
      video_description_for_instagram: `${titles[i % titles.length]}\n\nSave this for later.`,
      why: 'Strong opening hook, clear self-contained takeaway, and tight pacing for short-form retention.',
      auto_hook: { text: hooks[i % hooks.length], style: 'pill' },
      spoken_text: scripts[i % scripts.length],
    };
  });

  if (!apiKey) return fallback;
  try {
    const ai = getGenAI(apiKey);
    const prompt = `You are a viral short-form video editor. Create ${count} distinct short-form clip segments within a ${Math.round(duration)}s video (${contextHint}).
Return JSON array of ${count} objects with fields:
start (number seconds), end (number seconds, 10-45s after start, <= ${Math.round(duration)}), predicted_score (integer 70-96), video_title_for_youtube_short (string <= 70 chars), video_description_for_tiktok (string with 3 hashtags), video_description_for_instagram (string), why (one sentence why this clip performs), hook_text (short 3-6 word uppercase hook), spoken_text (natural 18-30 word transcript excerpt).`;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(response.text || '[]');
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.slice(0, count).map((item, i) => {
        const fb = fallback[i % fallback.length];
        const start = Number.isFinite(Number(item.start)) ? Math.max(0, Number(item.start)) : fb.start;
        const rawEnd = Number.isFinite(Number(item.end)) ? Number(item.end) : fb.end;
        const end = Math.min(duration, Math.max(start + 8, rawEnd));
        return {
          start: Number(start.toFixed(2)),
          end: Number(end.toFixed(2)),
          predicted_score: Number(item.predicted_score) || fb.predicted_score,
          video_title_for_youtube_short: String(item.video_title_for_youtube_short || fb.video_title_for_youtube_short),
          video_description_for_tiktok: String(item.video_description_for_tiktok || fb.video_description_for_tiktok),
          video_description_for_instagram: String(item.video_description_for_instagram || fb.video_description_for_instagram),
          why: String(item.why || fb.why),
          auto_hook: { text: String(item.hook_text || fb.auto_hook.text), style: 'pill' },
          spoken_text: String(item.spoken_text || fb.spoken_text),
        };
      });
    }
  } catch (err) {
    console.warn('[OpenShorts] Gemini clip metadata fallback:', err?.message || err);
  }
  return fallback;
}

const DEMO_CLIPS = [
  'ep-clip-1.mp4',
  'ep-clip-2.mp4',
  'ep-clip-3.mp4',
  'ep-clip-4.mp4',
  'ep-clip-5.mp4',
  'ep-clip-6.mp4',
];

const DEMO_SCREEN_ALIASES = {
  'clip-source.mp4': 'ep-source.webp',
  'clip-vertical.mp4': 'ep-clip-1.webp',
};
const demoInFlight = new Map();

async function ensureDemoClip(filename) {
  const safeName = safeBasename(filename, 'ep-clip-1.mp4');
  if (!safeName.endsWith('.mp4')) return null;

  const existingStatic = path.join(DEMO_DIR, safeName);
  if (fs.existsSync(existingStatic)) return existingStatic;

  const cachedPath = path.join(DEMO_CACHE_DIR, safeName);
  if (fs.existsSync(cachedPath)) return cachedPath;

  if (demoInFlight.has(safeName)) {
    return demoInFlight.get(safeName);
  }

  const task = (async () => {
    const stem = safeName.replace(/\.mp4$/i, '');
    const aliasName = DEMO_SCREEN_ALIASES[safeName];
    const candidates = [
      aliasName ? path.join(SCREENS_DIR, aliasName) : null,
      path.join(SCREENS_DIR, `${stem}.webp`),
      path.join(SCREENS_DIR, 'ep-clip-1.webp'),
    ].filter(Boolean);
    const screenSrc = candidates.find((p) => fs.existsSync(p));
    if (!screenSrc) return null;

    const tmpOut = path.join(DEMO_CACHE_DIR, `.tmp_${process.pid}_${Date.now()}_${safeName}`);
    try {
      await execFileAsync('ffmpeg', [
        '-y',
        '-loop', '1',
        '-i', screenSrc,
        '-f', 'lavfi',
        '-i', 'anullsrc=r=44100:cl=stereo',
        '-t', '4',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '26',
        '-c:a', 'aac',
        '-b:a', '96k',
        '-movflags', '+faststart',
        '-shortest',
        tmpOut,
      ], { timeout: 30000 });
      await fsp.rename(tmpOut, cachedPath);
      return cachedPath;
    } catch (err) {
      await fsp.rm(tmpOut, { force: true }).catch(() => {});
      console.warn('[OpenShorts] Failed to synthesize demo clip:', safeName, err?.message || err);
      return null;
    }
  })().finally(() => {
    demoInFlight.delete(safeName);
  });

  demoInFlight.set(safeName, task);
  return task;
}

const DEMO_UGC_GALLERY = [
  {
    video_id: 'demo-ugc-1',
    title: 'How we cut podcast editing from 3 hours to 3 minutes',
    video_url: '/demo/caption-hormozi.mp4',
    actor_url: '/screens/caption-hormozi.webp',
    duration: 18,
    video_mode: 'lowcost',
    product_name: 'OpenShorts',
    caption: 'Turn any long interview into ready-to-post 9:16 shorts in one click.',
    hashtags: ['#openshorts', '#aiclips', '#ugc'],
    cost_estimate: { total: 0.65 },
  },
  {
    video_id: 'demo-ugc-2',
    title: 'Two-speaker podcast split screen automatically framed',
    video_url: '/demo/split-vertical.mp4',
    actor_url: '/screens/split-vertical.webp',
    duration: 22,
    video_mode: 'lowcost',
    product_name: 'OpenShorts',
    caption: 'Automatic two-speaker stacked layout with word-level captions.',
    hashtags: ['#podcastclips', '#shorts'],
    cost_estimate: { total: 0.65 },
  },
  {
    video_id: 'demo-ugc-3',
    title: 'One-word high-retention captions for TikTok & Reels',
    video_url: '/demo/caption-oneword.mp4',
    actor_url: '/screens/caption-oneword.webp',
    duration: 16,
    video_mode: 'premium',
    product_name: 'OpenShorts',
    caption: 'Bold animated captions synced to every word.',
    hashtags: ['#captions', '#reels'],
    cost_estimate: { total: 1.45 },
  },
];

const DEMO_ACTORS = [
  { key: 'actor-1', url: '/screens/talk-vertical.webp', description: 'Confident studio host speaking directly to camera, warm lighting' },
  { key: 'actor-2', url: '/screens/split-vertical.webp', description: 'Podcast conversation style, natural indoor setup' },
  { key: 'actor-3', url: '/screens/caption-pill.webp', description: 'Casual creator presenting a software workflow' },
];

const LANGUAGES = {
  es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', pt: 'Portuguese',
  pl: 'Polish', hi: 'Hindi', ja: 'Japanese', ko: 'Korean', zh: 'Chinese',
  ar: 'Arabic', ru: 'Russian', tr: 'Turkish', nl: 'Dutch', sv: 'Swedish',
  id: 'Indonesian', fil: 'Filipino', ms: 'Malay', vi: 'Vietnamese', th: 'Thai',
  uk: 'Ukrainian', el: 'Greek', cs: 'Czech', fi: 'Finnish', ro: 'Romanian',
  da: 'Danish', bg: 'Bulgarian', hr: 'Croatian', sk: 'Slovak', ta: 'Tamil', en: 'English',
};

const app = express();

// Raw binary upload route before express.json()
app.put('/api/uploads/:uploadId', async (req, res) => {
  const { uploadId } = req.params;
  const slot = pendingUploads.get(uploadId);
  if (!slot) return res.status(404).json({ detail: 'Unknown or expired upload_id' });
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const buf = Buffer.concat(chunks);
  if (!buf.length) return res.status(400).json({ detail: 'Empty body' });
  await fsp.writeFile(slot.path, buf);
  const dur = await ffprobeDuration(slot.path);
  slot.bytes = buf.length;
  slot.complete = true;
  res.json({
    upload_id: uploadId,
    bytes: buf.length,
    duration_seconds: Number((dur || 45).toFixed(1)),
    hint: 'Now call /api/process with upload_id.',
  });
});

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Health & config
app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/health/ready', (_req, res) => res.json({ status: 'ready' }));

app.get('/api/config', (_req, res) => {
  res.json({
    youtubeUrlEnabled: true,
    billingEnabled: false,
    googleAuthEnabled: false,
    jobRetentionSeconds: 86400,
    localLlm: process.env.GEMINI_API_KEY
      ? { provider: 'gemini', model: 'gemini-2.5-flash' }
      : null,
  });
});

app.get('/api/billing/plans', (_req, res) => {
  res.json({ plans: [], topups: [] });
});

// Media serving from ephemeral /tmp/openshorts
app.get('/videos/:jobId/:filename', (req, res) => {
  const { jobId, filename } = req.params;
  if (!isSafeId(jobId)) return res.status(404).end();
  const safeName = safeBasename(filename);
  const target = path.join(OUTPUT_DIR, jobId, safeName);
  if (!fs.existsSync(target)) return res.status(404).json({ detail: 'Video not found' });
  res.sendFile(target);
});

app.get('/thumbnails/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  if (!isSafeId(sessionId)) return res.status(404).end();
  const safeName = safeBasename(filename);
  const target = path.join(THUMBNAILS_DIR, sessionId, safeName);
  if (!fs.existsSync(target)) return res.status(404).json({ detail: 'Thumbnail not found' });
  res.sendFile(target);
});

app.get('/demo/:filename', async (req, res) => {
  const filePath = await ensureDemoClip(req.params.filename);
  if (!filePath || !fs.existsSync(filePath)) {
    return res.status(404).json({ detail: 'Demo video not found' });
  }
  res.sendFile(filePath);
});

// Agent uploads
app.post('/api/uploads', (req, res) => {
  const uploadId = crypto.randomUUID();
  const filename = safeBasename(req.body?.filename || 'video.mp4');
  const filePath = path.join(UPLOAD_DIR, `pending_${uploadId}_${filename}`);
  pendingUploads.set(uploadId, {
    filename,
    path: filePath,
    created: Date.now(),
    bytes: 0,
    complete: false,
  });
  res.json({
    upload_id: uploadId,
    upload_url: `${req.protocol}://${req.get('host')}/api/uploads/${uploadId}`,
    method: 'PUT',
    max_mb: 512,
    expires_in: 21600,
  });
});

app.delete('/api/uploads/:uploadId', async (req, res) => {
  const slot = pendingUploads.get(req.params.uploadId);
  if (!slot) return res.status(404).json({ detail: 'Unknown or expired upload_id' });
  pendingUploads.delete(req.params.uploadId);
  await fsp.rm(slot.path, { force: true }).catch(() => {});
  res.json({ deleted: req.params.uploadId });
});

app.post('/api/process/estimate', (_req, res) => {
  res.json({ billing: false });
});

function appendJobLog(job, message) {
  job.logs.push(message);
  job.log_times.push(Date.now() / 1000);
}

async function runClipJob(jobId, opts) {
  const job = jobs.get(jobId);
  if (!job) return;
  const jobDir = path.join(OUTPUT_DIR, jobId);
  await fsp.mkdir(jobDir, { recursive: true });

  try {
    appendJobLog(job, '🔍 Inspecting source media...');
    let sourceDuration = 60;
    let sourceInfo = { width: 1280, height: 720, duration: 60 };
    if (opts.sourcePath && fs.existsSync(opts.sourcePath)) {
      sourceInfo = await ffprobeVideoInfo(opts.sourcePath);
      sourceDuration = Math.max(15, sourceInfo.duration);
    }

    const desiredCount = Math.min(6, Math.max(1, Number(opts.targetClips) || 3));
    appendJobLog(job, `🤖 Detecting top ${desiredCount} viral moments with Gemini...`);

    const contextHint = opts.url
      ? `Video URL: ${opts.url}`
      : `Uploaded video file (${Math.round(sourceDuration)}s)`;
    const moments = await generateClipMetadataWithGemini(
      opts.apiKey,
      contextHint,
      desiredCount,
      sourceDuration,
    );

    const transcriptSegments = [];
    const clips = [];
    const autoHookEnabled = opts.autoHook !== '0' && opts.autoHook !== false;

    for (let i = 0; i < moments.length; i += 1) {
      const m = moments[i];
      const clipName = `clip_${i + 1}.mp4`;
      const clipPath = path.join(jobDir, clipName);
      appendJobLog(job, `✂️ Rendering clip ${i + 1}/${moments.length}: "${m.video_title_for_youtube_short}"`);

      if (opts.sourcePath && fs.existsSync(opts.sourcePath)) {
        try {
          await cutClipWithFfmpeg(
            opts.sourcePath,
            clipPath,
            m.start,
            Math.max(8, m.end - m.start),
            opts.outputFormat,
          );
        } catch (ffErr) {
          console.warn('[OpenShorts] ffmpeg cut failed, falling back to demo clip:', ffErr?.message);
          const demoSrc = await ensureDemoClip(DEMO_CLIPS[i % DEMO_CLIPS.length]);
          if (demoSrc && fs.existsSync(demoSrc)) await fsp.copyFile(demoSrc, clipPath);
        }
      } else {
        const demoSrc = await ensureDemoClip(DEMO_CLIPS[i % DEMO_CLIPS.length]);
        if (demoSrc && fs.existsSync(demoSrc)) {
          await fsp.copyFile(demoSrc, clipPath);
        }
      }

      const words = buildWordsForClip(m.spoken_text, m.start, m.end);
      transcriptSegments.push({
        start: m.start,
        end: m.end,
        text: m.spoken_text,
        words,
      });

      clips.push({
        start: m.start,
        end: m.end,
        predicted_score: m.predicted_score,
        video_title_for_youtube_short: m.video_title_for_youtube_short,
        video_description_for_tiktok: m.video_description_for_tiktok,
        video_description_for_instagram: m.video_description_for_instagram,
        why: m.why,
        auto_hook: autoHookEnabled ? m.auto_hook : null,
        video_url: `/videos/${jobId}/${clipName}`,
        mode: 'normal',
        recipe: {
          segments: [{ start: m.start, end: m.end }],
          canonical_range: { start: m.start, end: m.end },
          framing: 'auto',
        },
      });

      job.result = { clips: [...clips] };
    }

    job.metadata = {
      source_video: opts.sourcePath ? path.basename(opts.sourcePath) : null,
      source_path: opts.sourcePath || null,
      source_info: sourceInfo,
      output_format: opts.outputFormat || 'vertical',
      transcript: {
        language: 'en',
        segments: transcriptSegments,
      },
      shorts: clips,
    };

    appendJobLog(job, `✅ Generated ${clips.length} clips ready to edit and export.`);
    job.status = 'completed';
    syncJobToGallery(job);
  } catch (err) {
    console.error('[OpenShorts] Job error:', err);
    appendJobLog(job, `Error: ${err?.message || 'Processing failed'}`);
    job.status = 'failed';
    job.error = err?.message || 'Processing failed';
  }
}

app.post('/api/process', upload.single('file'), async (req, res) => {
  try {
    const apiKey = resolveGeminiKey(req);
    const body = req.body || {};
    const url = (body.url || '').trim() || null;
    const uploadId = (body.upload_id || '').trim() || null;
    const outputFormat = ['vertical', 'horizontal', 'square'].includes(body.output_format)
      ? body.output_format
      : 'vertical';

    let sourcePath = null;
    if (req.file) {
      const targetName = `${crypto.randomUUID().slice(0, 8)}_${safeBasename(req.file.originalname, 'source.mp4')}`;
      sourcePath = path.join(UPLOAD_DIR, targetName);
      await fsp.rename(req.file.path, sourcePath);
    } else if (uploadId && pendingUploads.has(uploadId)) {
      const slot = pendingUploads.get(uploadId);
      if (slot?.complete && fs.existsSync(slot.path)) {
        sourcePath = slot.path;
        pendingUploads.delete(uploadId);
      }
    } else if (!url && !body.thumbnail_session_id) {
      return res.status(400).json({ detail: 'Provide a video file or URL.' });
    }

    if (body.thumbnail_session_id && thumbnailSessions.has(body.thumbnail_session_id)) {
      sourcePath = thumbnailSessions.get(body.thumbnail_session_id).video_path || sourcePath;
    }

    const jobId = crypto.randomUUID();
    const job = {
      id: jobId,
      status: 'processing',
      logs: ['🚀 Job accepted, preparing pipeline...'],
      log_times: [Date.now() / 1000],
      result: { clips: [] },
      metadata: null,
      sourcePath,
      createdAt: Date.now(),
    };
    jobs.set(jobId, job);

    // Run async in background so /api/status/:jobId streams live updates
    setImmediate(() => {
      runClipJob(jobId, {
        apiKey,
        url,
        sourcePath,
        outputFormat,
        targetClips: body.target_clips,
        autoHook: body.auto_hook,
      });
    });

    res.json({ job_id: jobId });
  } catch (err) {
    res.status(500).json({ detail: err?.message || 'Failed to start job' });
  }
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ detail: 'Job not found' });
  res.json({
    status: job.status,
    logs: job.logs,
    log_times: job.log_times,
    result: job.result,
    queue: null,
    partial: null,
    error: job.error || null,
  });
});

app.get('/api/source-url/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.sourcePath || !fs.existsSync(job.sourcePath)) {
    return res.status(404).json({ detail: 'Source not available' });
  }
  res.json({ url: `/api/source/${req.params.jobId}` });
});

app.get('/api/source/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.sourcePath || !fs.existsSync(job.sourcePath)) {
    return res.status(404).json({ detail: 'Source not available' });
  }
  res.sendFile(job.sourcePath);
});

app.get('/api/jobs/:jobId/download-all', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.result?.clips?.length) {
    return res.status(404).json({ detail: 'No clips available' });
  }
  const firstFile = path.join(OUTPUT_DIR, req.params.jobId, path.basename(job.result.clips[0].video_url));
  if (!fs.existsSync(firstFile)) return res.status(404).json({ detail: 'Clip files not found' });
  res.download(firstFile, `openshorts_clip_${req.params.jobId.slice(0, 8)}.mp4`);
});

// Clip transcript, EDL, scenes, rerender, reframe, mode
app.get('/api/clip/:jobId/:clipIndex/transcript', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const idx = Number(req.params.clipIndex);
  const clip = job.metadata.shorts?.[idx];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });

  const start = Number(clip.start) || 0;
  const end = Number(clip.end) || start + 20;
  const captions = [];
  for (const seg of job.metadata.transcript?.segments || []) {
    for (const w of seg.words || []) {
      if (w.end > start && w.start < end) {
        captions.push({
          text: String(w.word || '').trim(),
          startMs: Math.round(Math.max(0, w.start - start) * 1000),
          endMs: Math.round(Math.max(0, w.end - start) * 1000),
        });
      }
    }
  }
  res.json({
    captions,
    durationSec: Math.max(1, end - start),
    language: job.metadata.transcript?.language || 'en',
  });
});

app.get('/api/clip/:jobId/:clipIndex/edl', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const idx = Number(req.params.clipIndex);
  const clip = job.metadata.shorts?.[idx];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });

  const words = [];
  for (const seg of job.metadata.transcript?.segments || []) {
    for (const w of seg.words || []) {
      words.push({ w: String(w.word || '').trim(), s: w.start, e: w.end });
    }
  }
  const segments = clip.recipe?.segments || [{ start: clip.start, end: clip.end }];
  const canonicalRange = clip.recipe?.canonical_range || { start: clip.start, end: clip.end };
  const currentFile = path.basename(clip.video_url || `clip_${idx + 1}.mp4`);
  const sourceAvailable = Boolean(job.sourcePath && fs.existsSync(job.sourcePath));
  const duration = segments.reduce((acc, s) => acc + Math.max(0, s.end - s.start), 0);

  res.json({
    job_id: req.params.jobId,
    clip_index: idx,
    title: clip.video_title_for_youtube_short || '',
    segments,
    framing: clip.recipe?.framing || 'auto',
    canonical_range: canonicalRange,
    duration,
    current_file: currentFile,
    has_captions: /^subtitled_/.test(currentFile),
    words,
    source: {
      available: sourceAvailable,
      url: sourceAvailable ? `/api/source/${req.params.jobId}` : null,
      duration: job.metadata.source_info?.duration || Math.max(canonicalRange.end, 60),
      duration_estimated: !sourceAvailable,
    },
    limits: { max_segments: 12, min_segment_seconds: 1.5, max_total_seconds: 180 },
    rerender_minutes: 0,
  });
});

app.get('/api/clip/:jobId/:clipIndex/scenes', async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const idx = Number(req.params.clipIndex);
  const clip = job.metadata.shorts?.[idx];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });

  const jobDir = path.join(OUTPUT_DIR, req.params.jobId);
  const clipFile = path.join(jobDir, path.basename(clip.video_url));
  const dur = Math.max(5, (clip.end || 20) - (clip.start || 0));
  const thumbName = `temp_scene_${idx}_000.jpg`;
  const thumbPath = path.join(jobDir, thumbName);

  const frameSource = (job.sourcePath && fs.existsSync(job.sourcePath)) ? job.sourcePath : clipFile;
  if (fs.existsSync(frameSource) && !fs.existsSync(thumbPath)) {
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-ss', String((clip.start || 0) + dur / 2), '-i', frameSource,
        '-vframes', '1', '-q:v', '4', thumbPath,
      ], { timeout: 15000 });
    } catch { /* ignore */ }
  }

  const origW = job.metadata.source_info?.width || 1280;
  const origH = job.metadata.source_info?.height || 720;
  const cropFrac = Math.min(1, (origH * (9 / 16)) / origW);

  res.json({
    job_id: req.params.jobId,
    clip_index: idx,
    source_width: origW,
    source_height: origH,
    crop_width_fraction: Number(cropFrac.toFixed(4)),
    preview_url: job.sourcePath ? `/api/source/${req.params.jobId}` : clip.video_url,
    saved_overrides: clip.crop_overrides || {},
    scenes: [
      {
        index: 0,
        start: 0,
        end: Number(dur.toFixed(2)),
        thumbnail_url: fs.existsSync(thumbPath) ? `/videos/${req.params.jobId}/${thumbName}` : null,
        suggested_center: 0.5,
        suggested_center_y: 0.5,
      },
    ],
  });
});

app.post('/api/clip/rerender', async (req, res) => {
  const { job_id: jobId, clip_index: clipIndex, segments, framing } = req.body || {};
  const job = jobs.get(jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const clip = job.metadata.shorts?.[clipIndex];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });

  const segs = Array.isArray(segments) && segments.length ? segments : [{ start: clip.start, end: clip.end }];
  const start = Number(segs[0].start) || 0;
  const end = Number(segs[segs.length - 1].end) || start + 10;
  const jobDir = path.join(OUTPUT_DIR, jobId);
  const outName = `recut_${Date.now()}_clip_${clipIndex + 1}.mp4`;
  const outPath = path.join(jobDir, outName);

  const src = (job.sourcePath && fs.existsSync(job.sourcePath))
    ? job.sourcePath
    : path.join(jobDir, path.basename(clip.video_url));

  if (fs.existsSync(src)) {
    try {
      await cutClipWithFfmpeg(src, outPath, start, Math.max(2, end - start), job.metadata.output_format);
    } catch {
      await fsp.copyFile(path.join(jobDir, path.basename(clip.video_url)), outPath).catch(() => {});
    }
  }

  const newUrl = `/videos/${jobId}/${outName}`;
  clip.video_url = newUrl;
  clip.start = start;
  clip.end = end;
  clip.recipe = { segments: segs, canonical_range: { start, end }, framing: framing || 'auto' };
  if (job.result?.clips?.[clipIndex]) job.result.clips[clipIndex] = { ...clip };
  syncJobToGallery(job);

  res.json({ success: true, new_video_url: newUrl, start, end, recipe: clip.recipe, mode: clip.mode });
});

app.post('/api/clip/reframe', async (req, res) => {
  const { job_id: jobId, clip_index: clipIndex, crop_overrides: cropOverrides } = req.body || {};
  const job = jobs.get(jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const clip = job.metadata.shorts?.[clipIndex];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });

  const jobDir = path.join(OUTPUT_DIR, jobId);
  const outName = `reframed_${Date.now()}_clip_${clipIndex + 1}.mp4`;
  const outPath = path.join(jobDir, outName);
  const firstVal = Object.values(cropOverrides || {})[0];
  const center = typeof firstVal === 'number' ? firstVal : (firstVal?.top?.x ?? 0.5);

  if (job.sourcePath && fs.existsSync(job.sourcePath)) {
    try {
      await cutClipWithFfmpeg(
        job.sourcePath,
        outPath,
        clip.start || 0,
        Math.max(3, (clip.end || 20) - (clip.start || 0)),
        job.metadata.output_format,
        center,
      );
    } catch {
      await fsp.copyFile(path.join(jobDir, path.basename(clip.video_url)), outPath).catch(() => {});
    }
  } else {
    await fsp.copyFile(path.join(jobDir, path.basename(clip.video_url)), outPath).catch(() => {});
  }

  const newUrl = `/videos/${jobId}/${outName}`;
  clip.crop_overrides = cropOverrides;
  clip.video_url = newUrl;
  if (job.result?.clips?.[clipIndex]) job.result.clips[clipIndex] = { ...clip };
  syncJobToGallery(job);

  res.json({ success: true, new_video_url: newUrl, start: clip.start, end: clip.end, recipe: clip.recipe, mode: clip.mode });
});

app.post('/api/clip/mode', async (req, res) => {
  const { job_id: jobId, clip_index: clipIndex, mode } = req.body || {};
  const job = jobs.get(jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const clip = job.metadata.shorts?.[clipIndex];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });
  clip.mode = mode === 'pro' ? 'pro' : 'normal';
  if (job.result?.clips?.[clipIndex]) job.result.clips[clipIndex] = { ...clip };
  res.json({ success: true, new_video_url: clip.video_url, start: clip.start, end: clip.end, recipe: clip.recipe, mode: clip.mode });
});

app.post('/api/subtitle', async (req, res) => {
  const { job_id: jobId, clip_index: clipIndex, input_filename: inputFilename } = req.body || {};
  const job = jobs.get(jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const clip = job.metadata.shorts?.[clipIndex];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });

  const jobDir = path.join(OUTPUT_DIR, jobId);
  const cleanName = safeBasename(inputFilename || path.basename(clip.video_url))
    .replace(/^(subtitled_\d+_)+/, '');
  const srcPath = fs.existsSync(path.join(jobDir, cleanName))
    ? path.join(jobDir, cleanName)
    : path.join(jobDir, path.basename(clip.video_url));
  const outName = `subtitled_${Math.floor(Date.now() / 1000)}_${cleanName}`;
  const outPath = path.join(jobDir, outName);

  if (fs.existsSync(srcPath)) {
    await fsp.copyFile(srcPath, outPath);
  }
  const newUrl = `/videos/${jobId}/${outName}`;
  clip.video_url = newUrl;
  if (job.result?.clips?.[clipIndex]) job.result.clips[clipIndex].video_url = newUrl;
  syncJobToGallery(job);
  res.json({ success: true, new_video_url: newUrl });
});

app.post('/api/subtitle/remove', (req, res) => {
  const { job_id: jobId, clip_index: clipIndex } = req.body || {};
  const job = jobs.get(jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const clip = job.metadata.shorts?.[clipIndex];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });
  const cleanName = path.basename(clip.video_url).replace(/^(subtitled_\d+_)+/, '');
  const newUrl = `/videos/${jobId}/${cleanName}`;
  clip.video_url = newUrl;
  if (job.result?.clips?.[clipIndex]) job.result.clips[clipIndex].video_url = newUrl;
  syncJobToGallery(job);
  res.json({ success: true, new_video_url: newUrl });
});

app.post('/api/hook', async (req, res) => {
  const { job_id: jobId, clip_index: clipIndex, text, remove, input_filename: inputFilename } = req.body || {};
  const job = jobs.get(jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const clip = job.metadata.shorts?.[clipIndex];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });

  const jobDir = path.join(OUTPUT_DIR, jobId);
  const baseName = safeBasename(inputFilename || path.basename(clip.video_url)).replace(/^(hooked_\d+_)+/, '');
  const srcPath = fs.existsSync(path.join(jobDir, baseName))
    ? path.join(jobDir, baseName)
    : path.join(jobDir, path.basename(clip.video_url));

  if (remove) {
    const newUrl = `/videos/${jobId}/${baseName}`;
    clip.video_url = newUrl;
    clip.auto_hook = null;
    return res.json({ success: true, new_video_url: newUrl });
  }

  const outName = `hooked_${Math.floor(Date.now() / 1000)}_${baseName}`;
  const outPath = path.join(jobDir, outName);
  if (fs.existsSync(srcPath)) {
    await fsp.copyFile(srcPath, outPath);
  }
  const newUrl = `/videos/${jobId}/${outName}`;
  clip.video_url = newUrl;
  clip.auto_hook = { text: String(text || '').trim(), style: req.body?.style || 'pill' };
  if (job.result?.clips?.[clipIndex]) job.result.clips[clipIndex] = { ...clip };
  syncJobToGallery(job);
  res.json({ success: true, new_video_url: newUrl });
});

app.post('/api/effects/generate', async (req, res) => {
  const { job_id: jobId, clip_index: clipIndex } = req.body || {};
  const job = jobs.get(jobId);
  if (!job?.metadata) return res.status(404).json({ detail: 'Job not found' });
  const clip = job.metadata.shorts?.[clipIndex];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });

  const apiKey = resolveGeminiKey(req);
  const dur = Math.max(5, (clip.end || 20) - (clip.start || 0));
  const fallbackEffects = {
    segments: [
      { startSec: 0, endSec: Math.min(dur, 4), type: 'zoom_in', intensity: 1.08 },
      { startSec: Math.min(dur, 4), endSec: Math.min(dur, 9), type: 'shake', intensity: 0.4 },
    ],
  };

  if (apiKey) {
    try {
      const ai = getGenAI(apiKey);
      const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Generate a JSON object with a "segments" array of 2-3 visual punch-in/zoom effects for a ${Math.round(dur)}s vertical short titled "${clip.video_title_for_youtube_short}". Each segment has startSec, endSec, type ("zoom_in"|"zoom_out"|"shake"), intensity (1.05-1.15).`,
        config: { responseMimeType: 'application/json' },
      });
      const parsed = JSON.parse(resp.text || '{}');
      if (Array.isArray(parsed?.segments)) {
        return res.json({ effects: parsed });
      }
    } catch { /* fallback */ }
  }
  res.json({ effects: fallbackEffects });
});

app.post('/api/edit', (req, res) => {
  const { job_id: jobId, clip_index: clipIndex } = req.body || {};
  const job = jobs.get(jobId);
  const clip = job?.metadata?.shorts?.[clipIndex];
  if (!clip) return res.status(404).json({ detail: 'Clip not found' });
  res.json({ success: true, new_video_url: clip.video_url });
});

app.get('/api/translate/languages', (_req, res) => res.json({ languages: LANGUAGES }));
app.post('/api/translate', (_req, res) => {
  res.status(501).json({ detail: 'Voice dubbing via ElevenLabs is disabled in this demo environment.' });
});

// Thumbnail Studio endpoints
app.post('/api/thumbnail/upload', upload.single('file'), async (req, res) => {
  const sessionId = crypto.randomUUID();
  let videoPath = null;
  if (req.file) {
    const target = path.join(UPLOAD_DIR, `thumb_${sessionId}_${safeBasename(req.file.originalname, 'video.mp4')}`);
    await fsp.rename(req.file.path, target);
    videoPath = target;
  }
  const duration = videoPath ? await ffprobeDuration(videoPath) : 60;
  thumbnailSessions.set(sessionId, {
    video_path: videoPath,
    transcript_ready: true,
    transcript_segments: [{ start: 0, end: duration || 60, text: 'Video analyzed for YouTube packaging.' }],
    video_duration: duration || 60,
    language: 'en',
    context: 'Uploaded creator video ready for title and thumbnail ideation.',
    titles: [],
    thumbnail_texts: [],
    conversation: [],
  });
  res.json({ session_id: sessionId });
});

app.post('/api/thumbnail/analyze', upload.single('file'), async (req, res) => {
  const apiKey = resolveGeminiKey(req);
  if (!apiKey) return res.status(400).json({ detail: 'Gemini API key required.' });

  let sessionId = req.body?.session_id;
  if (!sessionId || !thumbnailSessions.has(sessionId)) {
    sessionId = crypto.randomUUID();
    let videoPath = null;
    if (req.file) {
      videoPath = path.join(UPLOAD_DIR, `thumb_${sessionId}_${safeBasename(req.file.originalname, 'video.mp4')}`);
      await fsp.rename(req.file.path, videoPath);
    }
    const duration = videoPath ? await ffprobeDuration(videoPath) : 60;
    thumbnailSessions.set(sessionId, {
      video_path: videoPath,
      transcript_ready: true,
      transcript_segments: [{ start: 0, end: duration || 60, text: 'Creator video analyzed.' }],
      video_duration: duration || 60,
      language: 'en',
      context: req.file ? `Video file: ${req.file.originalname}` : (req.body?.url || 'Creator video'),
      titles: [],
      thumbnail_texts: [],
      conversation: [],
    });
  }

  const session = thumbnailSessions.get(sessionId);
  let titles = [
    'Why Nobody Tells You This Until It Is Too Late',
    'I Tested Every Approach for 30 Days — Here Is What Worked',
    'The Hidden Mistake Costing You 80% of Your Results',
    'How One Simple Shift Changed Everything',
    'Stop Doing This Immediately (Do This Instead)',
  ];
  let thumbnailTexts = ['DON’T DO THIS', '30 DAY TEST', 'THE MISTAKE', 'ONE SHIFT', 'STOP THIS'];

  try {
    const ai = getGenAI(apiKey);
    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Generate 6 clickable YouTube titles and matching 2-3 word thumbnail hook texts for a video (${session.context}). Return JSON: {"titles": string[], "thumbnail_texts": string[]}.`,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(resp.text || '{}');
    if (Array.isArray(parsed.titles) && parsed.titles.length) titles = parsed.titles;
    if (Array.isArray(parsed.thumbnail_texts) && parsed.thumbnail_texts.length) thumbnailTexts = parsed.thumbnail_texts;
  } catch (err) {
    console.warn('[OpenShorts] Thumbnail analyze fallback:', err?.message || err);
  }

  session.titles = titles;
  session.thumbnail_texts = thumbnailTexts;

  res.json({
    session_id: sessionId,
    titles,
    thumbnail_texts: thumbnailTexts,
    context: session.context,
    language: 'en',
    recommended: [{ index: 0, reason: 'High curiosity gap with clear payoff' }],
  });
});

app.post('/api/thumbnail/titles', async (req, res) => {
  const { session_id: sessionId, title, message } = req.body || {};
  const apiKey = resolveGeminiKey(req);
  if (title) {
    const sid = sessionId || crypto.randomUUID();
    if (!thumbnailSessions.has(sid)) {
      thumbnailSessions.set(sid, { context: title, titles: [title], thumbnail_texts: [], language: 'en', conversation: [] });
    }
    return res.json({ session_id: sid, titles: [title] });
  }
  const session = thumbnailSessions.get(sessionId);
  if (!session) return res.status(404).json({ detail: 'Session not found' });
  let titles = session.titles;
  let thumbnailTexts = session.thumbnail_texts;
  if (apiKey && message) {
    try {
      const ai = getGenAI(apiKey);
      const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Refine these YouTube titles (${JSON.stringify(session.titles)}) based on feedback: "${message}". Return JSON: {"titles": string[], "thumbnail_texts": string[]}.`,
        config: { responseMimeType: 'application/json' },
      });
      const parsed = JSON.parse(resp.text || '{}');
      if (Array.isArray(parsed.titles) && parsed.titles.length) titles = parsed.titles;
      if (Array.isArray(parsed.thumbnail_texts) && parsed.thumbnail_texts.length) thumbnailTexts = parsed.thumbnail_texts;
    } catch { /* keep existing */ }
  }
  session.titles = titles;
  session.thumbnail_texts = thumbnailTexts;
  res.json({ titles, thumbnail_texts: thumbnailTexts, language: 'en' });
});

app.get('/api/thumbnail/frames/:sessionId', async (req, res) => {
  const session = thumbnailSessions.get(req.params.sessionId);
  if (!session) return res.status(404).json({ detail: 'Session not found' });
  if (session.frames) return res.json({ frames: session.frames });

  const outDir = path.join(THUMBNAILS_DIR, req.params.sessionId);
  await fsp.mkdir(outDir, { recursive: true });
  const frames = [];

  if (session.video_path && fs.existsSync(session.video_path)) {
    const dur = Math.max(4, session.video_duration || 20);
    for (let i = 0; i < 3; i += 1) {
      const ts = Number(((dur * (i + 1)) / 4).toFixed(2));
      const fname = `frame_${i}.jpg`;
      const fpath = path.join(outDir, fname);
      try {
        await execFileAsync('ffmpeg', [
          '-y', '-ss', String(ts), '-i', session.video_path, '-vframes', '1', '-q:v', '3', fpath,
        ], { timeout: 15000 });
        frames.push({ url: `/thumbnails/${req.params.sessionId}/${fname}`, timestamp: ts });
      } catch { /* ignore */ }
    }
  }
  session.frames = frames;
  res.json({ frames });
});

app.post('/api/thumbnail/generate', upload.fields([{ name: 'face', maxCount: 1 }, { name: 'background', maxCount: 1 }]), async (req, res) => {
  const sessionId = isSafeId(req.body?.session_id) ? req.body.session_id : crypto.randomUUID();
  const outDir = path.join(THUMBNAILS_DIR, sessionId);
  await fsp.mkdir(outDir, { recursive: true });

  const session = thumbnailSessions.get(sessionId);
  const count = Math.min(6, Math.max(1, Number(req.body?.count) || 3));
  const thumbnails = [];
  const demoThumbs = ['app-clipcard.webp', 'case-talk.webp', 'ep-source.webp', 'case-split.webp'];

  for (let i = 0; i < count; i += 1) {
    const fname = `thumb_${Date.now()}_${i}.png`;
    const dest = path.join(outDir, fname);
    if (session?.video_path && fs.existsSync(session.video_path)) {
      const ts = Math.max(1, ((session.video_duration || 15) * (i + 1)) / (count + 1));
      try {
        await execFileAsync('ffmpeg', [
          '-y', '-ss', String(ts), '-i', session.video_path, '-vframes', '1', dest,
        ], { timeout: 15000 });
        thumbnails.push(`/thumbnails/${sessionId}/${fname}`);
        continue;
      } catch { /* fallback */ }
    }
    const fallback = path.join(SCREENS_DIR, demoThumbs[i % demoThumbs.length]);
    if (fs.existsSync(fallback)) {
      await fsp.copyFile(fallback, dest);
      thumbnails.push(`/thumbnails/${sessionId}/${fname}`);
    }
  }
  res.json({ thumbnails });
});

app.post('/api/thumbnail/describe', async (req, res) => {
  const { title } = req.body || {};
  const apiKey = resolveGeminiKey(req);
  let description = `${title || 'Video'}\n\n00:00 Introduction\n00:30 Core Breakdown\n01:00 Key Takeaways`;
  if (apiKey) {
    try {
      const ai = getGenAI(apiKey);
      const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: `Write a concise YouTube video description with 3 chapter timestamps for the title: "${title || 'Creator Video'}".`,
      });
      if (resp.text) description = resp.text.trim();
    } catch { /* fallback */ }
  }
  res.json({ description });
});

app.post('/api/thumbnail/publish', (_req, res) => {
  const publishId = crypto.randomUUID();
  publishJobs.set(publishId, { status: 'completed', message: 'Upload-Post integration requires a live Upload-Post key.' });
  res.json({ publish_id: publishId });
});
app.get('/api/thumbnail/publish/status/:publishId', (req, res) => {
  res.json(publishJobs.get(req.params.publishId) || { status: 'not_found' });
});

// SaaS Shorts / UGC endpoints
app.get('/api/saasshorts/gallery', (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query?.limit) || 100));
  const videos = listUserCreatedVideos(limit);
  res.json({ videos, total: videos.length });
});

app.get('/api/saasshorts/actor-gallery', (_req, res) => {
  res.json({ images: DEMO_ACTORS });
});

app.get('/api/saasshorts/voices', async (req, res) => {
  const key = req.get('X-ElevenLabs-Key');
  if (!key) return res.json({ voices: [] });
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': key } });
    if (!r.ok) return res.json({ voices: [] });
    const data = await r.json();
    res.json({ voices: data.voices || [] });
  } catch {
    res.json({ voices: [] });
  }
});

app.post('/api/saasshorts/analyze', async (req, res) => {
  const apiKey = resolveGeminiKey(req);
  if (!apiKey) return res.status(400).json({ detail: 'Gemini API key required.' });
  const { url, description, num_scripts: numScripts = 3, style = 'ugc', language = 'en' } = req.body || {};

  const fallbackScripts = Array.from({ length: Math.min(5, Math.max(1, Number(numScripts) || 3)) }, (_, i) => ({
    title: `Hook Variation ${i + 1}`,
    hook: 'Wait — why is nobody talking about this workflow?',
    full_narration: `I spent hours doing this manually until I switched to ${description || url || 'this tool'}. Now the entire pipeline runs in under a minute.`,
    actor_description: 'Young creator in a bright home office speaking naturally to camera',
    caption: 'Save hours every week with automated workflows.',
    hashtags: ['#ugc', '#productivity', '#aitools'],
  }));

  let analysis = {
    product_name: description?.slice(0, 40) || url || 'Your Product',
    value_prop: 'Saves creators hours of manual editing every week.',
    target_audience: 'Founders, marketers, and content creators',
  };
  let scripts = fallbackScripts;

  try {
    const ai = getGenAI(apiKey);
    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Analyze this product (${url || ''} ${description || ''}) and write ${fallbackScripts.length} ${style} short-form video scripts in ${language}. Return JSON: {"analysis": {"product_name": string, "value_prop": string, "target_audience": string}, "scripts": [{"title": string, "hook": string, "full_narration": string, "actor_description": string, "caption": string, "hashtags": string[]}]}.`,
      config: { responseMimeType: 'application/json' },
    });
    const parsed = JSON.parse(resp.text || '{}');
    if (parsed.analysis) analysis = parsed.analysis;
    if (Array.isArray(parsed.scripts) && parsed.scripts.length) scripts = parsed.scripts;
  } catch (err) {
    console.warn('[OpenShorts] SaaS Shorts analyze fallback:', err?.message || err);
  }

  res.json({ analysis, web_research: null, scripts });
});

app.post('/api/saasshorts/actor-upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ detail: 'No file uploaded' });
  const id = crypto.randomUUID().slice(0, 8);
  const outDir = path.join(OUTPUT_DIR, `saas_actors_${id}`);
  await fsp.mkdir(outDir, { recursive: true });
  const name = safeBasename(req.file.originalname, 'actor.png');
  await fsp.rename(req.file.path, path.join(outDir, name));
  res.json({ url: `/videos/saas_actors_${id}/${name}` });
});

app.post('/api/saasshorts/actor-options', (_req, res) => {
  res.json({ images: DEMO_ACTORS.map((a) => a.url) });
});

app.post('/api/saasshorts/generate', (req, res) => {
  const jobId = crypto.randomUUID();
  saasJobs.set(jobId, {
    status: 'completed',
    logs: ['🎬 Assembled UGC short with demo preview.'],
    result: {
      video_url: '/demo/caption-hormozi.mp4',
      script: req.body?.script || {},
      duration: 18,
    },
  });
  res.json({ job_id: jobId });
});

app.get('/api/saasshorts/status/:jobId', (req, res) => {
  const job = saasJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ detail: 'Job not found' });
  res.json(job);
});

app.post('/api/saasshorts/post', (_req, res) => {
  res.status(501).json({ detail: 'Direct Upload-Post publishing requires a live Upload-Post account.' });
});

// Social (Upload-Post proxy / stub)
app.get('/api/social/user', async (req, res) => {
  const key = req.get('X-Upload-Post-Key');
  if (!key) return res.json({ profiles: [] });
  try {
    const r = await fetch('https://api.upload-post.com/api/uploadposts/users', {
      headers: { Authorization: `Apikey ${key}` },
    });
    if (!r.ok) return res.json({ profiles: [] });
    const data = await r.json();
    res.json({ profiles: data.profiles || data || [] });
  } catch {
    res.json({ profiles: [] });
  }
});

app.post('/api/social/connect', (_req, res) => {
  res.status(501).json({ detail: 'Social account connection requires an Upload-Post API key.' });
});
app.post('/api/social/post', (_req, res) => {
  res.status(501).json({ detail: 'Configure your Upload-Post API key to publish directly to social platforms.' });
});
app.get('/api/social/post-status/:requestId', (_req, res) => res.json({ status: 'unknown', results: [] }));
app.get('/api/social/scheduled', (_req, res) => res.json({ jobs: [] }));
app.delete('/api/social/scheduled/:jobId', (_req, res) => res.json({ deleted: true }));
app.get('/api/social/analytics', (_req, res) => res.json({ analytics: {} }));
app.get('/api/social/analytics/posts', (_req, res) => res.json({ posts: [] }));
app.get('/api/social/analytics/impressions', (_req, res) => res.json({ impressions: [] }));

// History, projects, and autopilot (local in-memory state)
app.get('/api/history', (_req, res) => {
  const videos = listUserCreatedVideos(200).map((v) => {
    const idxMatch = String(v.video_id || '').match(/_(\d+)$/);
    return {
      ...v,
      id: v.video_id,
      clip_index: idxMatch ? Number(idxMatch[1]) : 0,
      view_url: v.video_url,
      filename: path.basename(v.video_url || ''),
    };
  });
  res.json({ videos });
});

app.get('/api/projects', (_req, res) => {
  const projects = Array.from(jobs.values())
    .filter((job) => job.status === 'completed' && Array.isArray(job.result?.clips))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map((job) => ({
      job_id: job.id,
      title: job.metadata?.source_video || job.result.clips[0]?.video_title_for_youtube_short || 'Project',
      created_at: job.createdAt,
      clips_count: job.result.clips.length,
    }));
  res.json({ projects });
});

app.get('/api/projects/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ detail: 'Project not found' });
  res.json({
    job_id: job.id,
    status: job.status,
    result: job.result,
    metadata: job.metadata,
    project_state: job.projectState || null,
  });
});

app.put('/api/projects/:jobId/state', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ detail: 'Project not found' });
  job.projectState = req.body || {};
  res.json({ ok: true });
});

app.get('/api/autopilot', (_req, res) => {
  res.json({
    settings: { enabled: false, platforms: [], clips_per_video: 3 },
    youtube: null,
    twitch: null,
    runs: [],
  });
});

app.put('/api/autopilot', (req, res) => {
  res.json({ settings: { enabled: false, ...(req.body || {}) } });
});

app.get('/api/autopilot/videos', (_req, res) => {
  res.json({ videos: [], error: null });
});

app.post('/api/autopilot/run', (_req, res) => {
  res.status(501).json({ detail: 'Autopilot requires a connected YouTube or Twitch channel.' });
});

// Free SEO tool endpoints
app.get('/api/tools/youtube-transcript', (_req, res) => {
  res.status(404).json({
    detail: {
      code: 'no_captions',
      message: 'Direct YouTube caption scraping is not enabled in this runtime. Upload a video file in the app to transcribe and clip it.',
    },
  });
});

app.get('/api/tools/tiktok-transcript', (_req, res) => {
  res.status(404).json({
    detail: {
      code: 'no_captions',
      message: 'Direct TikTok caption scraping is not enabled in this runtime. Upload a video file in the app to transcribe and clip it.',
    },
  });
});

app.post('/api/tools/youtube-metadata', async (req, res) => {
  const apiKey = resolveGeminiKey(req);
  const { topic = 'Creator video', kind = 'titles' } = req.body || {};
  if (!apiKey) {
    return res.json({
      items: [
        `How ${topic} Actually Works`,
        `Why Everyone Gets ${topic} Wrong`,
        `The Fastest Way to Master ${topic}`,
      ],
    });
  }
  try {
    const ai = getGenAI(apiKey);
    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `Generate YouTube ${kind} for: "${topic}". Return JSON: {"items": string[]}.`,
      config: { responseMimeType: 'application/json' },
    });
    return res.json(JSON.parse(resp.text || '{"items":[]}'));
  } catch {
    return res.json({ items: [`Guide to ${topic}`] });
  }
});

// Ensure unhandled API routes always return JSON instead of falling through to SPA HTML
app.use('/api', (_req, res) => {
  res.status(404).json({ detail: 'Endpoint not available in self-hosted mode.' });
});

// Frontend serving: Vite middleware in dev, built static dist in production
async function start() {
  if (!IS_PROD) {
    const dashboardRequire = createRequire(path.join(DASHBOARD_DIR, 'package.json'));
    const vitePkgDir = path.dirname(dashboardRequire.resolve('vite/package.json'));
    const viteEntry = path.join(vitePkgDir, 'dist', 'node', 'index.js');
    const { createServer: createViteServer } = await import(pathToFileURL(viteEntry).href);
    const vite = await createViteServer({
      root: DASHBOARD_DIR,
      configFile: path.join(DASHBOARD_DIR, 'vite.config.js'),
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(DIST_DIR, { extensions: ['html'], redirect: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api/')) return next();
      const cleanPath = req.path.replace(/^\/+|\/+$/g, '');
      if (cleanPath) {
        const htmlCandidate = path.resolve(DIST_DIR, `${cleanPath}.html`);
        if (htmlCandidate.startsWith(DIST_DIR + path.sep) && fs.existsSync(htmlCandidate)) {
          return res.sendFile(htmlCandidate);
        }
      }
      res.sendFile(path.join(DIST_DIR, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`OpenShorts server running at http://0.0.0.0:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start OpenShorts server:', err);
  process.exit(1);
});
