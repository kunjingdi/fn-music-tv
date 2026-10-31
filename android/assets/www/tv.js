/* ==========================================================================
   飞牛音乐 · TV 端逻辑
   --------------------------------------------------------------------------
   遥控器是唯一输入源，整套交互就是一个状态机：
     播放页  ← → 切歌 / ↑ 曲库 / ↓ 菜单 / OK 播放暂停
     曲库页  ← → ↑ ↓ 选歌（方向键"解锁"，不再切歌）/ OK 播放 / 返回 回到播放
     设置页  ↑ ↓ 选项目 / ← → 改数值 / OK 确定 / 返回 回到播放
   所有接口都走本机 127.0.0.1 的同源代理（Java 侧签名 + 转发），网页不碰密钥。
   ========================================================================== */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.prototype.slice.call(document.querySelectorAll(s));
const stage = $('#stage');
const audio = $('#audio');

/* ---------------- 画布缩放：1920×1080 等比铺满 ---------------- */
function fitStage() {
  var w = (document.documentElement && document.documentElement.clientWidth) || window.innerWidth || 0;
  var h = (document.documentElement && document.documentElement.clientHeight) || window.innerHeight || 0;
  if (!w) w = window.innerWidth || 1280;
  if (!h) h = window.innerHeight || 720;
  var s = Math.min(w / 1920, h / 1080);
  // 算出离谱值就干脆不缩放——宁可四边裁掉，也别整页缩成一个看不见的小点
  if (!isFinite(s) || s <= 0.08 || s > 6) s = 1;
  stage.style.transform = 'scale(' + s + ')';
  stage.style.left = Math.round((w - 1920 * s) / 2) + 'px';
  stage.style.top = Math.round((h - 1080 * s) / 2) + 'px';
  window.__fit = { vw: w, vh: h, s: Math.round(s * 1000) / 1000 };
}
window.addEventListener('resize', fitStage);
window.addEventListener('orientationchange', function () { setTimeout(fitStage, 120); });
fitStage();

/* ---------------- 全局状态 ---------------- */
const S = {
  page: 'player',
  session: { connected: false, username: '' },
  tabs: 'tracks',
  lib: { items: [], idx: 0, focus: 'list', cols: 3, drill: null, loading: false },
  menu: { idx: 0 },
  login: { idx: 0 },
  kb: { open: false, shift: false, r: 3, c: 0, field: '', lastKey: '', lastAt: 0 },
  queue: [],
  qi: -1,
  cur: null,
  lines: [],
  lineIdx: -1,
  mode: 'seq',          // seq | random | single
  skin: 'skin-brutal',
  theme: '',
  lyricScale: 1,
  idleTimer: 0,
  saveTimer: 0
};

const LOOKS = [
  { id: 'skin-brutal', name: '新粗野' },
  { id: 'skin-glass', name: '透明玻璃' },
  { id: 'skin-pixel', name: '8-BIT 像素' },
  { id: 'skin-neumorph', name: '新拟物' },
  { id: 'skin-clay', name: '黏土' },
  { id: 'skin-swiss', name: '瑞士极简' },
  { id: 'skin-lumen', name: '透明灯箱' }
];
const THEMES = [
  { id: '', name: '原配色' },
  { id: 'theme-violet', name: '暗紫' },
  { id: 'theme-emerald', name: '翠绿' }
];
const MODES = [
  { id: 'seq', name: '顺序播放' },
  { id: 'random', name: '随机播放' },
  { id: 'single', name: '单曲循环' }
];

/* ---------------- 小工具 ---------------- */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmt(ms) {
  if (!ms || isNaN(ms) || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  const m = s % 60;
  return Math.floor(s / 60) + ':' + (m < 10 ? '0' + m : m);
}
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function pad(n, len) { var t = '' + n; while (t.length < len) t = '0' + t; return t; }
function native() { return window.FnTV || null; }
function setPage(name) {
  S.page = name;
  $$('.page').forEach(function (el) { el.classList.remove('on'); });
  const map = { player: '#p-player', lib: '#p-lib', menu: '#p-menu', login: '#p-login' };
  const el = $(map[name] || '#p-player');
  if (el) el.classList.add('on');
  /* 波形只在播放页刷。在曲库翻页时别让它继续吃 CPU */
  try {
    if (name === 'player') { if (audio.paused) paintViz(); else vizStart(); }
    else vizStop();
  } catch (e) {}
  if (native() && native().page) native().page(name);
  try { if (typeof diagPost === 'function') diagPost(); } catch (e) {}
}

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.remove('on'); }, 1900);
}

/* ---------------- 接口 ---------------- */
async function api(path, opt) {
  const o = Object.assign({ headers: { Accept: 'application/json' } }, opt || {});
  const r = await fetch(path, o);
  if (r.status === 401 && S.session.connected) {
    S.session = { connected: false, username: '' };
    toast('登录已过期，请重新登录');
    toLogin();
    throw new Error('401');
  }
  const ct = r.headers.get('content-type') || '';
  if (ct.indexOf('json') >= 0) return r.json();
  return r;
}
function dataList(d, keys) {
  keys = keys || ['tracks', 'list', 'items', 'rows', 'albums', 'artists', 'playlists'];
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (let i = 0; i < keys.length; i++) if (Array.isArray(d[keys[i]])) return d[keys[i]];
  return [];
}
function normalizeTrack(t) {
  const album = (t.album && typeof t.album === 'object') ? t.album : {};
  const artists = Array.isArray(t.artists) ? t.artists : [];
  const sp = t.audioSpec || {};
  return {
    guid: t.guid || t.id || '',
    title: t.title || t.name || '未知曲目',
    artist: artists.map(function (a) { return a.name; }).filter(Boolean).join(' / ') || t.artist || '未知歌手',
    album: album.name || album.title || (typeof t.album === 'string' ? t.album : '') || '',
    coverId: t.coverId || album.coverId || '',
    duration: sp.duration || t.duration || 0,
    format: sp.extension || sp.format || t.format || '',
    /* 下面四项接口不一定给，取不到就留 0，显示时自动跳过 */
    bitrate: sp.bitRate || sp.bitrate || sp.bit_rate || t.bitRate || t.bitrate || 0,
    sampleRate: sp.sampleRate || sp.sample_rate || sp.sampleRateHz || t.sampleRate || 0,
    channels: sp.channels || sp.channel || t.channels || 0,
    size: sp.size || sp.fileSize || sp.file_size || t.size || t.fileSize || 0
  };
}
function coverUrl(id) { return id ? ('/api/p/static/cover?coverId=' + encodeURIComponent(id)) : ''; }

/* ==========================================================================
   外观
   ========================================================================== */
function applyLook() {
  document.body.className = (S.skin + ' ' + S.theme).trim();
  try {
    localStorage.setItem('tv-look', S.skin);
    localStorage.setItem('tv-theme', S.theme);
    localStorage.setItem('tv-lyric', String(S.lyricScale));
    localStorage.setItem('tv-mode', S.mode);
  } catch (e) {}
  document.documentElement.style.setProperty('--lyrick', String(S.lyricScale));
  try { refreshVizAccent(); } catch (e) {}
  const hint = $('#hint-mode');
  if (hint) hint.textContent = (MODES.find(function (m) { return m.id === S.mode; }) || MODES[0]).name;
}
function loadPrefs() {
  try {
    const lk = localStorage.getItem('tv-look');
    if (lk && LOOKS.some(function (x) { return x.id === lk; })) S.skin = lk;
    const th = localStorage.getItem('tv-theme');
    if (th !== null) S.theme = th;
    const ly = parseFloat(localStorage.getItem('tv-lyric') || '1');
    S.lyricScale = (ly >= 0.8 && ly <= 1.3) ? ly : 1;
    const md = localStorage.getItem('tv-mode');
    if (md && MODES.some(function (x) { return x.id === md; })) S.mode = md;
  } catch (e) {}
}

/* ==========================================================================
   播放
   ========================================================================== */
let actx = null, analyser = null, freq = null, vizRaf = 0;

function initAudioGraph() {
  if (actx) return true;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    actx = new AC();
    const src = actx.createMediaElementSource(audio);
    analyser = actx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.78;
    src.connect(analyser);
    analyser.connect(actx.destination);
    freq = new Uint8Array(analyser.frequencyBinCount);
    return true;
  } catch (e) {
    actx = null;
    return false;
  }
}

/* ==========================================================================
   波形：全页唯一高频刷新的东西
   --------------------------------------------------------------------------
   软件渲染下没有 GPU 合成，一个元素动 = 整页重绘。所以这里做了四件事：
     1. 画布内部像素只 640×96（CSS 拉满全宽），像素量是 1080p 的 1/340
     2. 12fps（原来 18），暂停时彻底不刷，停在最后一帧不空转
     3. 不在播放页 / 页面不可见时连 rAF 都不排队
     4. 画布尺寸只设一次（重设 width 等于清空重建，很贵）
   ========================================================================== */
let vizAccent = '#ffe066';
function refreshVizAccent() {
  try {
    vizAccent = getComputedStyle(document.body).getPropertyValue('--accent').trim() || '#ffe066';
  } catch (e) { vizAccent = '#ffe066'; }
}

const VIZ_W = 1200, VIZ_H = 120, VIZ_BARS = 78, VIZ_GAP = 5, VIZ_FPS = 12;
let vizCv = null, vizCtx = null, vizPrev = null, vizGrad = null, vizGradKey = '';
let vizPhase = 0, vizLastT = 0;

function vizEnsure() {
  const cv = $('#viz');
  if (!cv) return false;
  if (vizCv === cv && vizCtx) return true;
  vizCv = cv;
  cv.width = VIZ_W;
  cv.height = VIZ_H;
  vizCtx = cv.getContext('2d');
  vizPrev = new Float32Array(VIZ_BARS);
  vizGrad = null; vizGradKey = '';
  return true;
}

function paintViz() {
  if (!vizEnsure()) return;
  const ctx = vizCtx, W = VIZ_W, H = VIZ_H;

  if (!vizGrad || vizGradKey !== vizAccent) {
    vizGradKey = vizAccent;
    vizGrad = ctx.createLinearGradient(0, 0, 0, H);
    vizGrad.addColorStop(0, 'rgba(255,255,255,0.08)');
    vizGrad.addColorStop(0.5, vizAccent);
    vizGrad.addColorStop(1, 'rgba(255,255,255,0.08)');
  }

  ctx.clearRect(0, 0, W, H);
  let data = null;
  if (analyser) { analyser.getByteFrequencyData(freq); data = freq; }
  vizPhase += 0.13;
  const mid = H / 2;
  const bw = (W - VIZ_GAP * (VIZ_BARS - 1)) / VIZ_BARS;
  const paused = audio.paused;

  ctx.fillStyle = vizGrad;
  ctx.globalAlpha = paused ? 0.5 : 0.95;
  for (let i = 0; i < VIZ_BARS; i++) {
    let v;
    if (paused) {
      v = 0.42 + 0.46 * Math.abs(Math.sin(i * 1.7 + 0.6));
    } else if (data) {
      const idx = Math.min(data.length - 1, Math.floor(Math.pow(i / VIZ_BARS, 1.9) * data.length * 0.92));
      v = Math.pow(data[idx] / 255, 0.85);
    } else {
      v = 0.22 + 0.2 * Math.sin(vizPhase + i * 0.35);
    }
    vizPrev[i] = Math.max(v, vizPrev[i] * 0.86);
    if (paused) vizPrev[i] = Math.min(vizPrev[i], 0.88);
    const h = Math.max(3, vizPrev[i] * mid * 0.86);
    ctx.fillRect(i * (bw + VIZ_GAP), mid - h, bw, h * 2);
  }
  ctx.globalAlpha = 1;
}

function vizStart() {
  if (vizRaf) return;
  vizLastT = 0;
  vizRaf = requestAnimationFrame(vizLoop);
}

function vizStop() {
  if (vizRaf) { cancelAnimationFrame(vizRaf); vizRaf = 0; }
}

function vizLoop(t) {
  if (S.page !== 'player' || document.hidden) { vizStop(); return; }
  vizRaf = requestAnimationFrame(vizLoop);
  if (audio.paused) return;
  /* 歌词搭这个 12fps 的顺风车：syncLyric 内部有「同一行就直接返回」的判断，
     绝大多数帧什么都不写，只有真换行那一下才动 DOM。 */
  syncLyric(audio.currentTime);
  if (t - vizLastT < 1000 / VIZ_FPS) return;
  vizLastT = t;
  paintViz();
}

/* 兼容老调用点：立刻画一帧；正在放就把循环拉起来 */
function drawViz() {
  refreshVizAccent();
  paintViz();
  if (!audio.paused) vizStart();
  else vizStop();
}

function currentIndexInQueue() {
  if (!S.cur) return -1;
  for (let i = 0; i < S.queue.length; i++) if (S.queue[i].guid === S.cur.guid) return i;
  return -1;
}


/* 封面当背景：先缩到 96x54 再缩到 48x27，两次降采样本身就是毛玻璃，
   比 filter:blur(60px) 便宜一个数量级——软件渲染扛不住那个。 */
let backdropKey = '';
function setBackdrop(src) {
  const bd = $('#backdrop');
  if (!bd) return;
  if (!src) {
    if (backdropKey !== '') { bd.style.backgroundImage = 'none'; backdropKey = ''; }
    return;
  }
  if (src === backdropKey) return;
  backdropKey = src;
  const img = new Image();
  img.onload = function () {
    try {
      /* 两次降采样就当毛玻璃用：比 filter:blur(60px) 便宜一个数量级 */
      const small = document.createElement('canvas');
      small.width = 96; small.height = 54;
      small.getContext('2d').drawImage(img, 0, 0, 96, 54);

      const tiny = document.createElement('canvas');
      tiny.width = 32; tiny.height = 18;
      tiny.getContext('2d').drawImage(small, 0, 0, 32, 18);
      bd.style.backgroundImage = 'url(' + tiny.toDataURL('image/jpeg', 0.7) + ')';

      /* 机身舞台要正方形，96×96 直接压成封面底色，放大后自然发糊 */
      const sq = document.createElement('canvas');
      sq.width = 96; sq.height = 96;
      sq.getContext('2d').drawImage(img, 0, 0, 96, 96);
      const stage = $('#pu-stage');
      if (stage) stage.style.backgroundImage = 'url(' + sq.toDataURL('image/jpeg', 0.72) + ')';
    } catch (e) {}
  };
  img.onerror = function () { backdropKey = ''; };
  img.src = src;
}

/* ==========================================================================
   机身屏幕上的技术参数（原来那儿是一排不会动的频谱柱）
   能拿到什么显示什么：格式 / 码率 / 采样率 / 声道 / 文件大小
   接口不给码率和大小的话，用 Range 请求探一次文件总长，反算平均码率
   ========================================================================== */
function fmtBytes(n) {
  if (!n) return '';
  const mb = n / 1048576;
  if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
  if (mb >= 1) return mb.toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}
function fmtHz(hz) {
  if (!hz) return '';
  const k = hz / 1000;
  return (Math.abs(k - Math.round(k)) < 0.05 ? Math.round(k) : k.toFixed(1)) + ' kHz';
}
function fmtKbps(v) {
  if (!v) return '';
  return v >= 1000 ? (v / 1000).toFixed(1) + ' Mbps' : Math.round(v) + ' kbps';
}

function paintMeta(t, sizeOverride) {
  const el = $('#pu-meta');
  if (!el) return;
  if (!t) { el.innerHTML = ''; return; }
  const size = sizeOverride || t.size || 0;
  let kbps = t.bitrate || 0;
  /* 没有码率就自己算：总字节 × 8 ÷ 时长 */
  if (!kbps && size && t.duration) {
    kbps = Math.round((size * 8) / (t.duration / 1000) / 1000);
  }
  const bits = [];
  const f = String(t.format || '').toUpperCase();
  if (f) bits.push('<b>' + f + '</b>');
  if (kbps) bits.push('<span>' + fmtKbps(kbps) + '</span>');
  if (t.sampleRate) bits.push('<span>' + fmtHz(t.sampleRate) + '</span>');
  if (size) bits.push('<span>' + fmtBytes(size) + '</span>');
  el.innerHTML = bits.join('<em>·</em>');
}

/* 只取 1 个字节，从 Content-Range 里读总长度。
   万一边上的 NAS 不认 Range、直接回 200 整首，拿到响应头就立刻 abort，
   绝不让它真把几十兆下下来。 */
function probeSize(url) {
  let ac = null;
  try { ac = new AbortController(); } catch (e) {}
  const opt = { headers: { Range: 'bytes=0-0' } };
  if (ac) opt.signal = ac.signal;
  return fetch(url, opt).then(function (r) {
    let n = 0;
    const cr = r.headers.get('Content-Range') || r.headers.get('content-range');
    if (cr) {
      const m = /\/(\d+)\s*$/.exec(cr);
      if (m) n = parseInt(m[1], 10) || 0;
    } else {
      const cl = r.headers.get('Content-Length') || r.headers.get('content-length');
      if (cl) n = parseInt(cl, 10) || 0;
    }
    try { if (ac) ac.abort(); } catch (e) {}
    return n;
  }).catch(function () { return 0; });
}

let metaProbeGuid = '';
function paintMetaLive(t, url) {
  paintMeta(t, 0);
  if (!t || t.size || !url) return;
  if (metaProbeGuid === t.guid) return;
  metaProbeGuid = t.guid;
  probeSize(url).then(function (n) {
    if (n > 0 && S.cur && S.cur.guid === t.guid) {
      t.size = n;
      paintMeta(t, n);
    }
  });
}

function updateUnit(t) {
  if (!t) return;
  $('#pu-title').textContent = t.title || '未知曲目';
  $('#pu-artist').textContent = (t.artist || '未知歌手') + (t.album ? ' · ' + t.album : '');
  const cu = coverUrl(t.coverId);
  const art = $('#cover');
  const unit = $('#punit');
  if (cu) {
    art.src = cu; art.style.visibility = 'visible';
    if (unit) unit.classList.remove('no-art');
  } else {
    art.removeAttribute('src'); art.style.visibility = 'hidden';
    if (unit) unit.classList.add('no-art');
    const stage = $('#pu-stage');
    if (stage) stage.style.backgroundImage = 'none';
  }
  paintMeta(t, 0);
  setBackdrop(cu);
}

async function playTrack(track, queue) {
  if (!track) return;
  if (queue) S.queue = queue.slice();
  S.cur = track;
  S.qi = currentIndexInQueue();

  $('#t-title').textContent = track.title || '未知曲目';
  $('#t-artist').textContent = (track.artist || '未知歌手') + (track.album ? ' · ' + track.album : '');
  const img = $('#cover');
  const cu = coverUrl(track.coverId);
  if (cu) { img.src = cu; img.style.visibility = 'visible'; } else { img.removeAttribute('src'); img.style.visibility = 'hidden'; }
  updateUnit(track);
  $('#tag-fmt').textContent = track.format ? String(track.format).toUpperCase() : '';
  $('#tag-idx').textContent = (S.qi >= 0 ? (S.qi + 1) : '-') + ' / ' + (S.queue.length || '-');
  $('#state-chip').textContent = '加载中…';
  $('#state-chip').classList.remove('playing');

  try {
    const streamUrl = '/api/p/track/stream?guid=' + encodeURIComponent(track.guid);
    audio.src = streamUrl;
    audio.currentTime = 0;
    if (initAudioGraph() && actx && actx.state === 'suspended') actx.resume();
    paintMetaLive(track, streamUrl);   /* 顺便探一下文件大小，几毫秒的事 */
    await audio.play();
  } catch (e) {
    toast('这首歌放不出来：' + (e && e.message ? e.message : '网络错误'));
  }
  loadLyric(track.guid);
  drawViz();
  markPlayingInLib();
}

function togglePlay() {
  if (!S.cur) { openLib(); return; }
  if (audio.paused) {
    audio.play().catch(function () {});
  } else {
    audio.pause();
  }
}

function step(dir) {
  if (!S.queue.length) { openLib(); return; }
  let i = currentIndexInQueue();
  if (i < 0) i = 0;
  if (S.mode === 'random' && S.queue.length > 1) {
    let n = i;
    while (n === i) n = Math.floor(Math.random() * S.queue.length);
    i = n;
  } else {
    i = (i + dir + S.queue.length) % S.queue.length;
  }
  playTrack(S.queue[i], null);
}

audio.addEventListener('play', function () {
  $('#state-chip').textContent = '正在播放';
  $('#state-chip').classList.add('playing');
  const led = $('#pu-led'); if (led) led.classList.add('on');
  const pl = $('#pu-play'); if (pl) pl.textContent = '❚❚';
  if (S.page === 'player') vizStart();
});
audio.addEventListener('pause', function () {
  $('#state-chip').textContent = '已暂停';
  $('#state-chip').classList.remove('playing');
  const led = $('#pu-led'); if (led) led.classList.remove('on');
  const pl = $('#pu-play'); if (pl) pl.textContent = '▶';
  vizStop();          /* 暂停就彻底停刷，只留一帧静态画面 */
  if (S.page === 'player') paintViz();
  saveProgress();
});
function refreshProgress() {
  const d = audio.duration;
  const c = audio.currentTime;
  $('#t-cur').textContent = fmt(c * 1000);
  $('#t-dur').textContent = fmt((d || 0) * 1000);
  const p = d ? (c / d) : 0;
  const pc = $('#pu-cur'), pd = $('#pu-dur'), pf = $('#pu-fill');
  if (pc) pc.textContent = fmt(c * 1000);
  if (pd) pd.textContent = fmt((d || 0) * 1000);
  if (pf) pf.style.width = Math.round(p * 100) + '%';
  $('#pfill').style.width = (p * 100).toFixed(2) + '%';
  syncLyric(c);
}

/* 长按左右键：连续 ±5 秒。原生层每 220ms 发一次（约 22 倍速） */
function seekBy(sec) {
  if (!S.cur) return;
  const d = audio.duration || 0;
  if (!d) return;
  let t = audio.currentTime + sec;
  t = Math.max(0, Math.min(d - 0.35, t));
  audio.currentTime = t;
  refreshProgress();
  seekHud(sec > 0, t, d);
}

function seekHud(fwd, t, d) {
  const hud = $('#hud');
  if (!hud) return;
  const pct = d ? Math.round((t / d) * 100) : 0;
  hud.innerHTML = '<div class="hico">' + (fwd ? '⏩' : '⏪') + '</div>' +
    '<div class="hbar"><i style="width:' + pct + '%"></i></div>' +
    '<div class="hnum">' + fmt(t * 1000) + '</div>';
  hud.classList.add('on');
  clearTimeout(window.__hudT);
  window.__hudT = setTimeout(function () { hud.classList.remove('on'); }, 1200);
}

/* timeupdate 一秒能来 4 次，每来一次就是一次整页重绘。
   进度条/时间本来就是按秒显示的，4Hz 纯属浪费——压到 1Hz。
   歌词更精细的同步交给波形主循环去做（它只在换行时才写 DOM）。 */
let _tickSec = -1;
audio.addEventListener('timeupdate', function () {
  const sec = Math.floor(audio.currentTime);
  if (sec === _tickSec) return;
  _tickSec = sec;
  refreshProgress();
  if (S.menu.idx === 4 && S.page === 'menu') renderMenu();
});
audio.addEventListener('ended', function () {
  if (S.mode === 'single') {
    audio.currentTime = 0;
    audio.play().catch(function () {});
    return;
  }
  step(1);
});
audio.addEventListener('error', function () {
  if (S.cur) {
    $('#state-chip').textContent = '播放失败';
    $('#state-chip').classList.remove('playing');
  }
});

audio.addEventListener('loadedmetadata', function () {
  if (S._resumeAt && S._resumeAt > 0) {
    try { audio.currentTime = S._resumeAt; } catch (e) {}
    S._resumeAt = 0;
    toast('已恢复上次播放位置');
  }
});

function saveProgress() {
  if (!S.cur || !audio.currentTime) return;
  const body = {
    guid: S.cur.guid, title: S.cur.title, artist: S.cur.artist,
    album: S.cur.album, coverId: S.cur.coverId, time: Math.floor(audio.currentTime)
  };
  try {
    fetch('/api/progress', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {}
}

/* ==========================================================================
   歌词
   ========================================================================== */
function pickLyric(list) {
  if (!list || !list.length) return '';
  for (let i = 0; i < list.length; i++) {
    const l = list[i] || {};
    const t = l.content || l.lyric || l.lrc || l.text;
    if (t) return t;
  }
  return '';
}
function parseLrc(raw) {
  if (!raw) return [];
  const out = [];
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const lines = String(raw).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ms = [];
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(line)) !== null) {
      const min = +m[1], sec = +m[2];
      const frac = m[3] ? (+m[3]).toString().padEnd(3, '0').slice(0, 3) : '0';
      ms.push(min * 60000 + sec * 1000 + (+frac));
    }
    if (!ms.length) continue;
    const text = line.replace(re, '').trim();
    for (let k = 0; k < ms.length; k++) out.push({ t: ms[k], text: text });
  }
  out.sort(function (a, b) { return a.t - b.t; });
  return out;
}

async function loadLyric(guid) {
  S.lines = [];
  S.lineIdx = -1;
  $('#ly-inner').innerHTML = '<div class="ly-none">歌词加载中…</div>';
  try {
    const r = await api('/api/p/lyric/list?trackGUID=' + encodeURIComponent(guid));
    const list = dataList(r.data);
    S.lines = parseLrc(pickLyric(list));
    renderLyric();
  } catch (e) {
    $('#ly-inner').innerHTML = '<div class="ly-none">歌词加载失败</div>';
  }
}

/* 歌词窗口：只挂 7 行 DOM，当前句固定在第 4 行（index 3）。
   原来把整首歌几十行都塞进 DOM，一层将近 9000px 高，软件渲染下滚动一次就掉帧。 */
const LY_WIN = 7, LY_MID = 3, LY_H = 88;

function renderLyric() {
  const box = $('#ly-inner');
  if (!S.lines.length) {
    box.innerHTML = '<div class="ly-none">暂无歌词</div>';
    box.style.transform = 'translateY(-42px)';
    setUnitLyric('');
    return;
  }
  let html = '';
  for (let k = 0; k < LY_WIN; k++) html += '<div class="ly-line"></div>';
  box.innerHTML = html;
  /* 固定位移：第 4 行（LY_MID）正好落在容器中线上，之后再也不改，省掉整层滚动 */
  box.style.transform = 'translateY(' + (-(LY_MID * LY_H + LY_H / 2)) + 'px)';
  S.lineIdx = -1;
  paintLyricWindow(-1);
  setUnitLyric('');
}

function paintLyricWindow(idx) {
  const box = $('#ly-inner');
  const els = box.children;
  if (!els || els.length !== LY_WIN) return;
  for (let k = 0; k < LY_WIN; k++) {
    const i = idx - LY_MID + k;
    const line = (i >= 0 && i < S.lines.length) ? S.lines[i] : null;
    const txt = line ? (line.text || '♪') : '';
    const el = els[k];
    if (el.textContent !== txt) el.textContent = txt;
    const cls = 'ly-line' + (line && k === LY_MID ? ' active' : '');
    if (el.className !== cls) el.className = cls;
  }
}

function syncLyric(sec) {
  if (!S.lines.length) return;
  const ms = sec * 1000;
  let idx = -1;
  for (let i = 0; i < S.lines.length; i++) {
    if (S.lines[i].t <= ms) idx = i; else break;
  }
  if (idx === S.lineIdx) return;
  S.lineIdx = idx;
  paintLyricWindow(idx);
  setUnitLyric(idx >= 0 && S.lines[idx] ? S.lines[idx].text : '');
}

/* 机身屏幕上的那一行歌词（压在封面上） */
let unitLy = '';
function setUnitLyric(txt) {
  const el = $('#pu-ly');
  if (!el) return;
  const v = (txt || '').trim();
  if (v === unitLy) return;
  unitLy = v;
  el.textContent = v;
  el.style.visibility = v ? 'visible' : 'hidden';
}

/* ==========================================================================
   曲库
   ========================================================================== */
const TAB_CFG = {
  tracks: { name: '歌曲', cols: 3, url: '/api/p/track/list?page=1&size=500', kind: 'track' },
  albums: { name: '专辑', cols: 4, url: '/api/p/album/list?page=1&size=200', kind: 'album' },
  artists: { name: '歌手', cols: 4, url: '/api/p/artist/list-all', kind: 'artist' },
  playlists: { name: '歌单', cols: 4, url: '/api/p/playlist/list', kind: 'playlist' },
  favorites: { name: '收藏', cols: 3, url: '/api/p/favorite-track/list?page=1&size=300', kind: 'track' }
};

async function openLib() {
  setPage('lib');
  hideHintsSoon();
  if (!S.lib.items.length || S.lib.drill) {
    S.lib.drill = null;
    await loadTab(S.tabs, true);
  } else {
    renderLib();
    focusLib();
  }
}

async function loadTab(tab, resetFocus) {
  S.tabs = tab;
  S.lib.drill = null;
  S.lib.loading = true;
  S.lib.items = [];
  S.lib.idx = 0;
  S.lib.focus = resetFocus ? 'tabs' : 'list';
  const cfg = TAB_CFG[tab];
  S.lib.cols = cfg.cols;
  $('#lib-count').textContent = '加载中…';
  $('#lib-grid').className = 'lib-grid ' + (cfg.cols === 4 ? 'cols4' : 'cols3');
  $('#lib-grid').innerHTML = '<div class="card"><div class="meta"><div class="t">加载中…</div></div></div>';
  syncTabs();
  try {
    const r = await api(cfg.url);
    const list = dataList(r.data);
    if (!list.length) {
      $('#lib-grid').innerHTML = '<div class="card"><div class="meta"><div class="t">这里还是空的</div><div class="s">先去飞牛音乐里扫一遍音乐文件夹</div></div></div>';
      $('#lib-count').textContent = '';
      S.lib.loading = false;
      return;
    }
    S.lib.items = list;
    S.lib.loading = false;
    renderLib();
    focusLib();
  } catch (e) {
    $('#lib-grid').innerHTML = '<div class="card"><div class="meta"><div class="t">加载失败</div><div class="s">' + esc(e.message) + '</div></div></div>';
    $('#lib-count').textContent = '';
    S.lib.loading = false;
  }
}

function renderLib() {
  const cfg = TAB_CFG[S.tabs];
  const box = $('#lib-grid');
  box.className = 'lib-grid ' + (cfg.cols === 4 ? 'cols4' : 'cols3');
  const items = S.lib.items;
  if (cfg.kind === 'track') {
    box.innerHTML = items.map(function (raw, i) {
      const t = normalizeTrack(raw);
      const c = coverUrl(t.coverId);
      const playing = S.cur && S.cur.guid === t.guid;
      return '<div class="card' + (playing ? ' playing' : '') + '" data-i="' + i + '">' +
        (c ? '<img class="cov" loading="lazy" src="' + c + '"/>' : '<div class="cov">♪</div>') +
        '<div class="meta"><div class="t">' + esc(t.title) + '</div>' +
        '<div class="s">' + esc(t.artist) + (t.album ? ' · ' + esc(t.album) : '') + '</div></div>' +
        '<div class="dur">' + fmt(t.duration) + '</div></div>';
    }).join('');
  } else {
    box.innerHTML = items.map(function (raw, i) {
      const name = raw.name || raw.title || '未命名';
      const sub = cfg.kind === 'album'
        ? ((raw.artists || []).map(function (a) { return a.name; }).join('/') || raw.artist || '')
        : (cfg.kind === 'playlist' ? (raw.trackCount ? raw.trackCount + ' 首' : '') : '');
      const cid = raw.coverId || (raw.album && raw.album.coverId) || '';
      const c = coverUrl(cid);
      return '<div class="tile" data-i="' + i + '"><div class="ar">' +
        (c ? '<img loading="lazy" src="' + c + '"/>' : '♪') +
        '</div><div class="t">' + esc(name) + '</div><div class="s">' + esc(sub) + '</div></div>';
    }).join('');
  }
  $('#lib-count').textContent = items.length + ' 项';
  $('#lib-grid').className = box.className;
  paintFocus();
}

function paintFocus() {
  const kids = $('#lib-grid').children;
  for (let i = 0; i < kids.length; i++) {
    kids[i].classList.toggle('focus', S.lib.focus === 'list' && i === S.lib.idx);
  }
  $$('#lib-tabs .tab').forEach(function (el, i) {
    el.classList.toggle('focus', S.lib.focus === 'tabs' && el.dataset.tab === S.tabs);
    el.classList.toggle('on', el.dataset.tab === S.tabs);
  });
  $('#lib-pos').textContent = S.lib.items.length
    ? ((S.lib.focus === 'list' ? (S.lib.idx + 1) : '–') + ' / ' + S.lib.items.length)
    : '';
}

function focusLib() {
  paintFocus();
  if (S.lib.focus !== 'list') return;
  const el = $('#lib-grid').children[S.lib.idx];
  if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function markPlayingInLib() {
  if (S.page === 'lib' && TAB_CFG[S.tabs].kind === 'track') renderLib();
}

async function openDrill(kind, raw) {
  const guid = raw.guid || raw.albumGUID || raw.artistGUID || raw.playlistGUID || raw.id;
  const name = raw.name || raw.title || '未命名';
  let url = '';
  if (kind === 'album') url = '/api/p/track/album-detail/list?albumGUID=' + encodeURIComponent(guid) + '&page=1&size=300';
  else if (kind === 'artist') url = '/api/p/track/artist-detail/list?artistGUID=' + encodeURIComponent(guid) + '&page=1&size=300';
  else if (kind === 'playlist') url = '/api/p/track/playlist-detail/list?playlistGUID=' + encodeURIComponent(guid) + '&page=1&size=300';
  if (!url) return;
  S.lib.loading = true;
  $('#lib-count').textContent = '加载中…';
  try {
    const r = await api(url);
    const list = dataList(r.data);
    S.lib.drill = { kind: kind, name: name };
    S.lib.items = list;
    S.lib.idx = 0;
    S.lib.focus = 'list';
    S.lib.cols = 3;
    if (!list.length) { toast('这里没有歌'); }
    renderLib();
    $('#lib-count').textContent = name + ' · ' + list.length + ' 首';
    focusLib();
  } catch (e) {
    toast('加载失败');
  }
  S.lib.loading = false;
}

function syncTabs() {
  $$('#lib-tabs .tab').forEach(function (el) {
    el.classList.toggle('on', el.dataset.tab === S.tabs);
  });
  paintFocus();
}

$$('#lib-tabs .tab').forEach(function (el) {
  el.addEventListener('click', function () { loadTab(el.dataset.tab, true); });
});

/* ==========================================================================
   设置页
   ========================================================================== */
const MENU = [
  { key: '外观皮肤', type: 'look' },
  { key: '配色', type: 'theme' },
  { key: '歌词字号', type: 'lyric' },
  { key: '播放模式', type: 'mode' },
  { key: '播放进度', type: 'seek' },
  { key: '音量', type: 'vol' },
  { key: '重新连接服务器', type: 'reconnect' },
  { key: '退出登录', type: 'logout' },
  { key: '关于', type: 'about' }
];

function openMenu() {
  setPage('menu');
  hideHintsSoon();
  S.menu.idx = 0;
  renderMenu();
}

function renderMenu() {
  const box = $('#menu-list');
  box.innerHTML = MENU.map(function (m, i) {
    let v = '';
    if (m.type === 'look' || m.type === 'theme' || m.type === 'mode') {
      const arr = m.type === 'look' ? LOOKS : (m.type === 'theme' ? THEMES : MODES);
      const cur = m.type === 'look' ? S.skin : (m.type === 'theme' ? S.theme : S.mode);
      v = arr.map(function (o) {
        return '<span class="opt' + (o.id === cur ? ' on' : '') + '">' + o.name + '</span>';
      }).join('');
    } else if (m.type === 'lyric') {
      const cur = S.lyricScale;
      v = [['小', 0.86], ['中', 1], ['大', 1.16]].map(function (o) {
        return '<span class="opt' + (Math.abs(o[1] - cur) < 0.01 ? ' on' : '') + '">' + o[0] + '</span>';
      }).join('');
    } else if (m.type === 'seek') {
      v = '<span class="opt on">' + fmt(audio.currentTime * 1000) + ' / ' + fmt((audio.duration || 0) * 1000) + '</span>';
    } else if (m.type === 'vol') {
      v = '<span class="opt on">' + Math.round(audio.volume * 100) + '%</span>';
    } else if (m.type === 'reconnect') {
      v = '<span class="opt">' + (S.session.connected ? '已连接 ' + esc(S.session.username || '') : '未连接') + '</span>';
    } else if (m.type === 'logout') {
      v = '<span class="opt">清空本机凭据</span>';
    } else if (m.type === 'about') {
      v = '<span class="opt">飞牛音乐 TV · 1.1.1</span>';
    }
    return '<div class="mrow' + (i === S.menu.idx ? ' focus' : '') + '" data-i="' + i + '">' +
      '<div class="k">' + m.key + '</div><div class="v">' + v + '</div></div>';
  }).join('');
}

function menuAdjust(dir) {
  const m = MENU[S.menu.idx];
  if (!m) return;
  if (m.type === 'look') {
    const i = LOOKS.findIndex(function (x) { return x.id === S.skin; });
    S.skin = LOOKS[(i + dir + LOOKS.length) % LOOKS.length].id;
    applyLook();
  } else if (m.type === 'theme') {
    const i = THEMES.findIndex(function (x) { return x.id === S.theme; });
    S.theme = THEMES[(i + dir + THEMES.length) % THEMES.length].id;
    applyLook();
  } else if (m.type === 'mode') {
    const i = MODES.findIndex(function (x) { return x.id === S.mode; });
    S.mode = MODES[(i + dir + MODES.length) % MODES.length].id;
    applyLook();
  } else if (m.type === 'lyric') {
    const arr = [0.86, 1, 1.16];
    let i = 1;
    for (let k = 0; k < arr.length; k++) if (Math.abs(arr[k] - S.lyricScale) < 0.01) i = k;
    i = Math.max(0, Math.min(arr.length - 1, i + dir));
    S.lyricScale = arr[i];
    applyLook();
  } else if (m.type === 'seek') {
    if (!S.cur) { toast('先放一首歌'); return; }
    audio.currentTime = Math.max(0, Math.min((audio.duration || 0), audio.currentTime + dir * 10));
  } else if (m.type === 'vol') {
    audio.volume = Math.max(0, Math.min(1, audio.volume + dir * 0.1));
    if (native() && native().volume) native().volume(Math.round(audio.volume * 100));
  }
  renderMenu();
}

function menuActivate() {
  const m = MENU[S.menu.idx];
  if (!m) return;
  if (m.type === 'reconnect') {
    toast('正在重连…');
    fetch('/api/session').then(function (r) { return r.json(); }).then(function (j) {
      S.session.connected = !!j.connected;
      toast(j.connected ? '已连接' : '未连接，去登录页重新登录');
      renderMenu();
    });
  } else if (m.type === 'logout') {
    fetch('/api/logout', { method: 'POST' }).then(function () {
      S.session = { connected: false, username: '' };
      toast('已退出登录');
      toLogin();
    });
  } else if (m.type === 'about') {
    toast('飞牛音乐 TV 1.1.1 · 为电视遥控器重做的一套界面');
  }
}

/* ==========================================================================
   登录
   ========================================================================== */
const LOGIN_FIELDS = ['base', 'user', 'pass', 'go'];
const form = { base: '', user: '', pass: '' };

function toLogin() {
  setPage('login');
  paintLogin();
}

function paintLogin() {
  $('#v-base').textContent = form.base || '按 OK 输入飞牛地址';
  $('#v-user').textContent = form.user;
  $('#v-pass').textContent = form.pass ? new Array(form.pass.length + 1).join('•') : '';
  $$('#p-login .fld').forEach(function (el, i) {
    el.classList.toggle('focus', i === S.login.idx);
  });
}

function loginKey(name) {
  if (name === 'up') { S.login.idx = (S.login.idx + LOGIN_FIELDS.length - 1) % LOGIN_FIELDS.length; paintLogin(); return; }
  if (name === 'down') { S.login.idx = (S.login.idx + 1) % LOGIN_FIELDS.length; paintLogin(); return; }
  if (name === 'ok') {
    const f = LOGIN_FIELDS[S.login.idx];
    if (f === 'go') { doConnect(); return; }
    openKeyboard(f);
    return;
  }
  if (name === 'back' && !S.kb.open) {
    if (native() && native().exit) native().exit();
  }
}

async function doConnect() {
  const err = $('#login-err');
  err.textContent = '';
  if (!form.base || !form.user || !form.pass) { err.textContent = '地址、账号、密码都要填'; return; }
  $('#v-go').textContent = '连接中…';
  try {
    const r = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base: form.base, username: form.user, password: form.pass, remember: true })
    });
    const j = await r.json();
    if (j && j.code === 0) {
      S.session = { connected: true, username: (j.data && j.data.username) || form.user };
      $('#v-go').textContent = '连接并登录';
      goPlayer();
      toast('登录成功');
    } else {
      err.textContent = (j && j.msg) ? j.msg : '登录失败';
      $('#v-go').textContent = '连接并登录';
    }
  } catch (e) {
    err.textContent = '请求出错：' + e.message;
    $('#v-go').textContent = '连接并登录';
  }
}

/* ==========================================================================
   屏幕键盘
   ========================================================================== */
/* 三层键盘：标点在顶、数字在中、字母在下。
   整块只渲染一次，按键只切 focus 的 class——
   原来每按一下都重建 40 个节点，那才是"按一下卡一下"的真凶。 */
const KB_ROWS = [
  { g: '标点', keys: ['.', '_', '-', '@', ':', '/', '?', '#', ',', ';'] },
  { keys: ["'", '"', '+', '=', '!', '*', '(', ')', '&', '%'] },
  { g: '数字', keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] },
  { g: '字母', keys: ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'] },
  { keys: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'] },
  { keys: ['z', 'x', 'c', 'v', 'b', 'n', 'm'] },
  { g: '操作', keys: [{ fn: '空格' }, { fn: '退格' }, { fn: '清空' }, { fn: '小写' }, { fn: '完成' }] }
];
let kbEls = [];
let kbBuilt = false;

function openKeyboard(field) {
  S.kb.open = true;
  S.kb.field = field;
  S.kb.shift = false;
  S.kb.lastKey = '';
  S.kb.lastAt = 0;
  $('#kb').classList.add('on');
  $('#kb-title').textContent = ({ base: '输入 NAS 地址', user: '输入账号', pass: '输入密码' })[field] || '输入';
  buildKeyboard();
  S.kb.r = 3; S.kb.c = 0;   // 默认落在字母第一行
  kbFocus();
  kbPreview();
}

function closeKeyboard() {
  S.kb.open = false;
  $('#kb').classList.remove('on');
  paintLogin();
}

function buildKeyboard() {
  if (kbBuilt) return;
  const grid = $('#kb-grid');
  let html = '';
  KB_ROWS.forEach(function (row, ri) {
    if (row.g) html += '<div class="kb-g">' + row.g + '</div>';
    html += '<div class="kb-row">';
    row.keys.forEach(function (k, ci) {
      const isFn = k && typeof k === 'object' && k.fn;
      const label = isFn ? k.fn : k;
      const cls = 'key' + (isFn ? ' fn' : '') + (isFn && k.fn === '完成' ? ' primary' : '');
      html += '<div class="' + cls + '" data-r="' + ri + '" data-c="' + ci + '">' + esc(label) + '</div>';
    });
    html += '</div>';
  });
  grid.innerHTML = html;
  kbEls = [];
  for (let r = 0; r < KB_ROWS.length; r++) {
    kbEls.push(Array.prototype.slice.call(grid.querySelectorAll('[data-r="' + r + '"]')));
  }
  kbBuilt = true;
}

function kbFocus() {
  for (let r = 0; r < kbEls.length; r++) {
    for (let c = 0; c < kbEls[r].length; c++) {
      const on = (r === S.kb.r && c === S.kb.c);
      if (kbEls[r][c].classList.contains('focus') !== on) {
        kbEls[r][c].classList.toggle('focus', on);
      }
    }
  }
  const sk = kbEls[6] && kbEls[6][3];
  if (sk) sk.textContent = S.kb.shift ? '大写' : '小写';
}

function kbPreview() {
  const v = form[S.kb.field] || '';
  $('#kb-preview').textContent = v + (S.kb.shift ? '_' : '|');
}

function currentKbField() { return S.kb.field; }

function kbInput(name) {
  if (!kbBuilt) buildKeyboard();
  const rows = KB_ROWS;
  let r = S.kb.r, c = S.kb.c;

  if (name === 'left' || name === 'right' || name === 'up' || name === 'down') {
    if (name === 'left') c = Math.max(0, c - 1);
    if (name === 'right') c = Math.min(rows[r].keys.length - 1, c + 1);
    if (name === 'up') r = Math.max(0, r - 1);
    if (name === 'down') r = Math.min(rows.length - 1, r + 1);
    if (r !== S.kb.r) c = Math.min(c, rows[r].keys.length - 1);   // 每行列数不一样
    S.kb.r = r; S.kb.c = c;
    kbFocus();
    return;
  }
  if (name === 'back') { closeKeyboard(); return; }
  if (name !== 'ok') return;

  const k = rows[S.kb.r].keys[S.kb.c];
  const f = currentKbField();
  const cur = form[f] || '';

  if (k && typeof k === 'object' && k.fn) {
    if (k.fn === '空格') form[f] = cur + ' ';
    else if (k.fn === '退格') form[f] = cur.slice(0, -1);
    else if (k.fn === '清空') form[f] = '';
    else if (k.fn === '小写' || k.fn === '大写') S.kb.shift = !S.kb.shift;
    else if (k.fn === '完成') { closeKeyboard(); return; }
    S.kb.lastKey = '';
  } else {
    const ch = String(k);
    if (/^[a-zA-Z]$/.test(ch)) {
      const lower = ch.toLowerCase();
      const now = Date.now();
      if (S.kb.shift) {
        form[f] = cur + lower.toUpperCase();      // 锁了大写：一路大写
        S.kb.lastKey = '';
      } else if (S.kb.lastKey === lower && now - S.kb.lastAt < 700) {
        form[f] = cur.slice(0, -1) + lower.toUpperCase();   // 连按第二下：同一个键变大写
        S.kb.lastKey = '';
      } else {
        form[f] = cur + lower;
        S.kb.lastKey = lower;
      }
      S.kb.lastAt = now;
    } else {
      form[f] = cur + ch;
      S.kb.lastKey = '';
    }
  }
  kbFocus();
  kbPreview();
}

/* ==========================================================================
   遥控器入口
   ========================================================================== */
function playerKey(name) {
  if (name === 'left') { step(-1); return; }
  if (name === 'right') { step(1); return; }
  if (name === 'seek-back') { seekBy(-5); return; }
  if (name === 'seek-fwd') { seekBy(5); return; }
  if (name === 'prev') { step(-1); return; }
  if (name === 'next') { step(1); return; }
  if (name === 'ok') { togglePlay(); return; }
  if (name === 'up') { openLib(); return; }
  if (name === 'down' || name === 'menu') { openMenu(); return; }
}

function libKey(name) {
  const cfg = TAB_CFG[S.tabs];
  const cols = S.lib.cols || cfg.cols;
  const n = S.lib.items.length;

  if (name === 'back') {
    if (S.lib.drill) { S.lib.drill = null; loadTab(S.tabs, false); return; }
    setPage('player');
    return;
  }
  if (name === 'menu') { openMenu(); return; }

  if (S.lib.focus === 'tabs') {
    if (name === 'left' || name === 'right') {
      const ids = Object.keys(TAB_CFG);
      let i = ids.indexOf(S.tabs);
      i = (i + (name === 'left' ? -1 : 1) + ids.length) % ids.length;
      loadTab(ids[i], false);
      return;
    }
    if (name === 'down' || name === 'ok') {
      if (!n) return;
      S.lib.focus = 'list';
      S.lib.idx = 0;
      focusLib();
      return;
    }
    if (name === 'up') return;
    return;
  }

  // 列表内：方向键"解锁"，只做选择
  if (name === 'left') {
    if (S.lib.idx % cols === 0) return;
    S.lib.idx--;
  } else if (name === 'right') {
    if (S.lib.idx % cols === cols - 1 || S.lib.idx >= n - 1) return;
    S.lib.idx++;
  } else if (name === 'up') {
    if (S.lib.idx < cols) { S.lib.focus = 'tabs'; S.lib.idx = Math.min(S.lib.idx, Math.max(0, n - 1)); paintFocus(); return; }
    S.lib.idx -= cols;
  } else if (name === 'down') {
    if (S.lib.idx + cols >= n) return;
    S.lib.idx += cols;
  } else if (name === 'ok') {
    const raw = S.lib.items[S.lib.idx];
    if (!raw) return;
    if (cfg.kind === 'track') {
      const list = S.lib.items.map(normalizeTrack);
      playTrack(list[S.lib.idx], list);
      setPage('player');
    } else {
      openDrill(cfg.kind, raw);
    }
    return;
  } else if (name === 'next' || name === 'prev') {
    step(name === 'next' ? 1 : -1);
    return;
  }
  focusLib();
}

function menuKey(name) {
  if (name === 'back') { setPage('player'); return; }
  if (name === 'up') { S.menu.idx = (S.menu.idx + MENU.length - 1) % MENU.length; renderMenu(); return; }
  if (name === 'down') { S.menu.idx = (S.menu.idx + 1) % MENU.length; renderMenu(); return; }
  if (name === 'left') { menuAdjust(-1); return; }
  if (name === 'right') { menuAdjust(1); return; }
  if (name === 'ok') { menuActivate(); return; }
  if (name === 'menu') { setPage('player'); return; }
}

function showHints() {
  $$('.hintbar').forEach(function (el) { el.classList.remove('hide'); });
  clearTimeout(S.idleTimer);
  hideHintsSoon();
}
function hideHintsSoon() {
  clearTimeout(S.idleTimer);
  S.idleTimer = setTimeout(function () {
    if (S.page === 'player' || S.page === 'lib') {
      $$('.hintbar').forEach(function (el) { el.classList.add('hide'); });
    }
  }, 7000);
}

window.TV = {
  key: function (name) {
    if (name === 'diag') { nativeProbe(); toggleDiag(); return; }
    var sbox = $('#sanity');
    if (sbox && sbox.className.indexOf('on') >= 0) {
      if (name === 'back') hideDiag();
      return;
    }
    showHints();
    if (S.kb.open) { kbInput(name); return; }
    if (S.page === 'login') { loginKey(name); return; }
    if (S.page === 'lib') { libKey(name); return; }
    if (S.page === 'menu') { menuKey(name); return; }
    playerKey(name);
  },
  vol: function (cur, max) {
    const hud = $('#hud');
    hud.innerHTML = '<div class="hico">🔊</div><div class="hbar"><i style="width:' +
      Math.round((cur / max) * 100) + '%"></i></div><div class="hnum">' +
      Math.round((cur / max) * 100) + '</div>';
    hud.classList.add('on');
    clearTimeout(window.__hudT);
    window.__hudT = setTimeout(function () { hud.classList.remove('on'); }, 1500);
  },
  toast: toast,
  beforeExit: function () { saveProgress(); }
};

/* 键盘（USB 键盘 / 调试用）也走同一套状态机 */
window.addEventListener('keydown', function (e) {
  const map = {
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    Enter: 'ok', ' ': 'ok', Escape: 'back', Backspace: 'back'
  };
  if (map[e.key]) { e.preventDefault(); window.TV.key(map[e.key]); }
});

/* ==========================================================================
   自检 / 诊断
   --------------------------------------------------------------------------
   电视上既没有 DevTools 也没开 adb，出问题只能靠页面自己交代"我看到了什么"：
     ① 全屏绿字（启动显示 10 秒，按遥控器「菜单 / 信息」键随时再叫出来）
     ② POST 到本机 /diag；同一个数据也从局域网端口吐出来，
        电脑上 curl http://<电视IP>:8646/diag 就能直接看到，不用在电视上敲字
   ========================================================================== */
var DIAG = { err: [] };
window.onerror = function (msg, url, line, col) {
  DIAG.err.push(String(msg) + ' @' + line + ':' + col);
  if (DIAG.err.length > 6) DIAG.err.shift();
  return false;
};
window.addEventListener('unhandledrejection', function (e) {
  DIAG.err.push('promise: ' + ((e && e.reason && e.reason.message) || e.reason || '?'));
});

function diagInfo() {
  var ua = navigator.userAgent || '';
  var m = ua.match(/Chrome\/(\d+)/);
  var imgs = 0, ok = 0;
  $$('img').forEach(function (im) { imgs++; if (im.complete && im.naturalWidth > 0) ok++; });
  var canvasOk = 0;
  try {
    var c = $('#viz');
    if (c && c.getContext) {
      var g = c.getContext('2d');
      g.fillStyle = '#ff0000';
      g.fillRect(0, 0, 2, 2);
      var px = g.getImageData(0, 0, 1, 1).data;
      canvasOk = (px[0] > 200 && px[3] > 200) ? 1 : 0;
    }
  } catch (e) { canvasOk = -1; }
  var rect = { width: 0, height: 0, left: 0, top: 0 };
  try { rect = stage.getBoundingClientRect(); } catch (e) {}
  var cs = null, st = null;
  try { cs = window.getComputedStyle(document.body); } catch (e) {}
  try { st = window.getComputedStyle(stage); } catch (e) {}
  // CSS 自定义属性到底认不认：设一个变量再读回来，最直接
  var cssvar = 'N';
  try {
    var de = document.documentElement;
    de.style.setProperty('--probe', '#123456');
    var pv = window.getComputedStyle(de).getPropertyValue('--probe');
    cssvar = (pv && pv.replace(/\s/g, '').length) ? 'Y' : 'N';
    de.style.removeProperty('--probe');
  } catch (e) { cssvar = 'E'; }
  var vis = '';
  try {
    vis = (cs ? cs.opacity : '') + '/' + (cs ? cs.visibility : '') + '/' + (cs ? cs.display : '');
  } catch (e) {}
  return {
    build: 'fntv-1.0.8',
    cssvar: cssvar,
    vis: vis,
    chrome: m ? parseInt(m[1], 10) : 0,
    ua: ua.slice(0, 160),
    win: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0),
    client: (document.documentElement.clientWidth || 0) + 'x' + (document.documentElement.clientHeight || 0),
    screen: (screen.width || 0) + 'x' + (screen.height || 0),
    dpr: window.devicePixelRatio || 1,
    fit: window.__fit || null,
    stage: Math.round(rect.width) + 'x' + Math.round(rect.height) + '@' + Math.round(rect.left) + ',' + Math.round(rect.top),
    bodyBg: cs ? cs.backgroundColor : '',
    stageBg: st ? String(st.backgroundImage || '').slice(0, 46) : '',
    font: cs ? String(cs.fontFamily || '').slice(0, 46) : '',
    page: S.page,
    login: S.session.connected ? 1 : 0,
    queue: S.queue.length,
    lib: S.lib.items.length,
    imgs: ok + '/' + imgs,
    canvas: canvasOk,
    err: DIAG.err.join(' | ')
  };
}

function diagText() {
  var d = diagInfo();
  var L = [];
  L.push('飞牛音乐TV  ' + d.build + '   Chrome/' + d.chrome);
  L.push('页面 ' + d.page + '  登录 ' + d.login + '  队列 ' + d.queue + '  曲库 ' + d.lib);
  L.push('window ' + d.win + '  client ' + d.client + '  screen ' + d.screen + '  dpr ' + d.dpr);
  L.push('缩放 ' + JSON.stringify(d.fit));
  L.push('舞台 ' + d.stage);
  L.push('底色 ' + d.bodyBg + '  背景 ' + d.stageBg);
  L.push('字体 ' + d.font);
  L.push('图片 ' + d.imgs + '  canvas ' + d.canvas);
  if (d.err) L.push('错误 ' + d.err);
  L.push('按「菜单」键关闭 / 再按一次还能看');
  return L.join('\n');
}

var diagTimer = 0;
function showDiag(ms) {
  var box = $('#sanity');
  if (!box) return;
  box.textContent = diagText();
  box.className = 'on';
  clearTimeout(diagTimer);
  if (ms) diagTimer = setTimeout(hideDiag, ms);
  diagPost();
}
function hideDiag() {
  var box = $('#sanity');
  if (box) box.className = '';
}
function toggleDiag() {
  var box = $('#sanity');
  if (!box) return;
  if (box.className.indexOf('on') >= 0) hideDiag(); else showDiag(0);
}
/* 把自检结果送到原生层显示。网页这层要是画不出来，这条就是唯一的证据。 */
function nativeProbe() {
  try {
    var n = native();
    if (!n || !n.probe) return;
    var d = diagInfo();
    d.tip = '按菜单键收起';
    n.probe(JSON.stringify(d, null, 0));
  } catch (e) {}
}
window.__nativeProbe = nativeProbe;

function diagPost() {
  try {
    fetch('/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diagInfo())
    }).catch(function () {});
  } catch (e) {}
}

/* ==========================================================================
   启动
   ========================================================================== */
async function boot() {
  // 告诉原生层"JS 跑起来了"，它会把那条原生状态条改字
  try { if (native() && native().ready) native().ready(); } catch (e) {}
  loadPrefs();
  applyLook();
  drawViz();
  tickClock();
  setInterval(tickClock, 20000);
  // 有的电视首帧拿到的 innerWidth/Height 是错的，过一会儿再量一次
  setTimeout(fitStage, 400);
  setTimeout(fitStage, 1600);
  setTimeout(fitStage, 3000);

  // 不再自动盖住界面：自检结果直接送到原生层显示（菜单键可调出）
  setTimeout(nativeProbe, 1800);
  setTimeout(nativeProbe, 5000);
  setInterval(diagPost, 30000);

  let j = {};
  try { j = await (await fetch('/api/session')).json(); } catch (e) {}
  form.base = j.savedBase || form.base;
  form.user = j.savedUser || '';
  S.session.connected = !!j.connected;
  S.session.username = j.username || j.savedUser || '';

  if (S.session.connected) {
    goPlayer();
    if (j.lastTrack && j.lastTrack.guid) restoreLast(j.lastTrack);
  } else if (j.hasSaved) {
    // 存了密码但这次没连上：给登录页，密码留空让他重输
    toLogin();
  } else {
    toLogin();
  }
  setTimeout(hideHintsSoon, 200);
  setTimeout(diagPost, 1200);
}

function tickClock() {
  const d = new Date();
  const s = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  $('#clock').textContent = s;
  $('#clock2').textContent = s;
}

async function goPlayer() {
  setPage('player');
  if (!S.queue.length) {
    try {
      const r = await api('/api/p/track/list?page=1&size=500');
      S.queue = dataList(r.data).map(normalizeTrack);
      $('#tag-idx').textContent = '— / ' + (S.queue.length || '—');
    } catch (e) {}
  }
}

function restoreLast(t) {
  S.cur = normalizeTrack(t);
  S.cur.duration = 0;
  $('#t-title').textContent = S.cur.title || '上次播放';
  $('#t-artist').textContent = (S.cur.artist || '') + (S.cur.album ? ' · ' + S.cur.album : '');
  updateUnit(S.cur);
  S._resumeAt = t.time || 0;
  audio.src = '/api/p/track/stream?guid=' + encodeURIComponent(S.cur.guid);
  loadLyric(S.cur.guid);
  drawViz();
}

setInterval(function () {
  if (!audio.paused && S.cur) saveProgress();
}, 10000);

window.addEventListener('beforeunload', saveProgress);
boot();
