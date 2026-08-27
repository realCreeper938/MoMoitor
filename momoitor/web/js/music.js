/* Music */
let _lastCover = '';
/* Lyrics */
let _lyricLines = [];      // 当前曲目的歌词行 [{time, text}, ...]（可能已展开翻译）
let _lyricRawLines = [];   // 未展开的原始歌词行（翻译模式开启时由它生成 _lyricLines）
let _lyricKey = '';        // 当前已加载歌词的曲目标识 "title|artist"
let _lyricBase = { pos: 0, t: 0 };  // 轮询间隙内插值估算当前时间的基准
let _lyricTimer = null;    // 歌词平滑推进定时器
let _lyricActive = false;  // 是否处于歌词显示模式
let _lyricHover = false;   // 鼠标是否悬停在歌词上（悬停时显示播放控件）
let _lyricCurIdx = -1;     // 当前渲染句子的下标，用于切换句子时重置水平滚动

/* Large-card progress bar */
let _musicBase = { pos: 0, t: 0 };    // 轮询间隙内插值估算当前进度的基准
let _musicDur = 0;                    // 当前曲目总时长（秒）
let _musicPlaying = true;             // 是否正在播放（暂停时不推进进度）
let _progressTimer = null;            // 进度条平滑推进定时器
let _seeking = false;                 // 用户正在拖动进度条（拖动时暂停自动刷新）

/* 格式化为 m:ss */
function fmtMusicTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m + ':' + String(s).padStart(2, '0');
}

/* Show/hide the seek bar + remaining time. Shown only when playback progress
   (duration) is actually available. */
function _setMusicProgressVisible(show) {
    const section = document.getElementById('music-section');
    if (section) section.classList.toggle('progress-active', !!show);
}

/* Update the seek bar + remaining time + hover tooltip from interpolated
   position. */
function updateMusicProgress() {
    const seek = document.getElementById('h-music-seek');
    const tip = document.getElementById('h-music-seek-tip');
    const left = document.getElementById('h-music-time-left');
    if (!seek) return;
    if (_seeking) return;
    const pos = _musicPlaying ? _musicBase.pos + (Date.now() - _musicBase.t) / 1000 : _musicBase.pos;
    seek.value = _musicDur > 0 ? Math.min(1000, Math.round(pos / _musicDur * 1000)) : 0;
    seek.style.setProperty('--seek-fill', (seek.value / 10) + '%');
    if (left) left.textContent = '-' + fmtMusicTime(_musicDur - pos);
    if (tip) {
        tip.textContent = fmtMusicTime(pos);
        tip.style.left = (seek.value / 10) + '%';
    }
}

/* 根据播放进度找到当前行 cur、下一行 next 与行下标 curIdx。
   翻译模式下，同一时间戳的「翻译 + 原文」成对处理：翻译是当前行、原文是下一行。 */
function _findLyricAt(pos) {
    let cur = null, next = null, curIdx = -1;
    for (let i = 0; i < _lyricLines.length; i++) {
        if (_lyricLines[i].time <= pos) { cur = _lyricLines[i]; curIdx = i; }
        else { next = _lyricLines[i]; break; }
    }
    if (_lyricAutoTranslate && cur && curIdx > 0 && _lyricLines[curIdx - 1].trans === true && _lyricLines[curIdx - 1].time === cur.time) {
        return { cur: _lyricLines[curIdx - 1], next: cur, curIdx: curIdx - 1 };
    }
    return { cur, next, curIdx };
}
/* 更新三段歌词文本（上一句 / 当前句 / 下一句） */
function _setLyricTexts(prevEl, curEl, nextEl, prev, cur, next) {
    if (prevEl) prevEl.textContent = (prev && prev.text) ? prev.text : '';
    curEl.textContent = (cur && cur.text) ? cur.text : '♪';
    nextEl.textContent = (next && next.text) ? next.text : '';
}

/* 把形如 "原文 (翻译)" 的歌词行拆成 {original, translation}；不匹配返回 null */
function _splitLyricTranslation(text) {
    if (!text) return null;
    const m = text.match(/^(.*?)\s*[（(]([^（）()]*)[)）]\s*$/);
    if (m && m[1].trim() && m[2].trim()) {
        return { original: m[1].trim(), translation: m[2].trim() };
    }
    return null;
}

/* Render the prev + current + next lyric lines based on interpolated position.
   仅刷新文本（歌词刚抓取完成等场景需要立即补一次）；滚动由 rAF 循环负责。 */
function renderLyrics() {
    if (!_lyricActive) return;
    const prevEl = document.getElementById('h-lyric-prev');
    const curEl = document.getElementById('h-lyric-current');
    const nextEl = document.getElementById('h-lyric-next');

    // 暂停时偏移量固定为 0：歌词停在当前行（预测/真实进度均适用）
    const pos = _lyricBase.pos + (_musicPlaying ? Date.now() - _lyricBase.t : 0) / 1000;
    const { cur, next, curIdx } = _findLyricAt(pos);
    const prev = curIdx > 0 ? _lyricLines[curIdx - 1] : null;
    _setLyricTexts(prevEl, curEl, nextEl, prev, cur, next);
}

/* 单行长歌词水平滚动：超出容器的部分按「当前句时长」（到下一句的时间）均匀
   滚完整行，由播放进度驱动 scrollLeft，滚动速度随句长自适应。 */
function _scrollCurrentLine(curEl, cur, next, pos) {
    if (!cur || !cur.text) { curEl.scrollLeft = 0; return; }
    const over = curEl.scrollWidth - curEl.clientWidth;
    if (over <= 0) { curEl.scrollLeft = 0; return; }
    const dur = (next ? next.time : pos + 4) - cur.time;  // 本句时长（秒）
    const span = Math.max(dur, 2.5);                       // 至少 2.5s 滚完
    const p = Math.min(Math.max((pos - cur.time) / span, 0), 1);
    const target = p * over;
    // 超长歌词始终跟随播放进度滚动；开启平滑时每帧缓动逼近，
    // 关闭时按 ~500ms 步进直接跳动（生硬无动画，减少连续布局开销）。
    if (_lyricAnimEnabled) {
        curEl.scrollLeft += (target - curEl.scrollLeft) * 0.12;
    } else {
        const now = Date.now();
        if (now - _lyricScrollStepT >= 500) {
            _lyricScrollStepT = now;
            curEl.scrollLeft = target;
        }
    }
}

/* 歌词动画循环（每帧 rAF）：
   - 文本：切句瞬间立即刷新（_lyricCurIdx 变化即更新），不再依赖 500ms 定时器，
     因此歌词切换及时。
   - 滚动：切句时立即把当前行 scrollLeft 归零（从行首开始），随后每帧由
     _scrollCurrentLine 向右平滑推进，实现单行长歌词的水平滚动。
   - 切句动画：不做向上/向下滚动过渡，直接替换文本（简单、省性能）。 */
let _lyricRaf = null;      // requestAnimationFrame 句柄
let _lyricScrollStepT = 0; // 关闭平滑滚动时的步进时间戳（~500ms 一跳）

function _lyricAnimLoop() {
    _lyricRaf = requestAnimationFrame(_lyricAnimLoop);
    if (!_lyricActive) return;
    const prevEl = document.getElementById('h-lyric-prev');
    const curEl = document.getElementById('h-lyric-current');
    const nextEl = document.getElementById('h-lyric-next');
    if (!curEl || !nextEl) return;
    // 暂停时偏移量固定为 0：动画循环同样停在当前行
    const pos = _lyricBase.pos + (_musicPlaying ? Date.now() - _lyricBase.t : 0) / 1000;
    const { cur, next, curIdx } = _findLyricAt(pos);
    if (curIdx !== _lyricCurIdx) {
        _lyricCurIdx = curIdx;
        const prev = curIdx > 0 ? _lyricLines[curIdx - 1] : null;
        _setLyricTexts(prevEl, curEl, nextEl, prev, cur, next);
        curEl.scrollLeft = 0;
        nextEl.scrollLeft = 0;
        _lyricScrollStepT = 0;
    }
    // 翻译模式：当前行是翻译、下一行是同时间戳的原文。滚动只作用于当前行（翻译），
    // 进度边界取下一组翻译的时间，避免因同时间戳原文把 span 压成固定 2.5s。
    const paceNext = (_lyricAutoTranslate && cur && cur.trans === true && next && next.time === cur.time
        && curIdx + 2 < _lyricLines.length) ? _lyricLines[curIdx + 2] : next;
    _scrollCurrentLine(curEl, cur, paceNext, pos);
}

/* Apply current view: controls shown either when not in lyric mode, or when
   the mouse is hovering over the card (so users can control playback).
   When hovering, lyrics are hidden; otherwise lyrics are shown. */
function applyLyricView() {
    const controls = document.getElementById('h-music-controls');
    const lyrics = document.getElementById('h-music-lyrics');
    if (!controls || !lyrics) return;
    if (_lyricActive && !_lyricHover) {
        controls.style.display = 'none';
        lyrics.style.display = 'flex';
    } else {
        controls.style.display = '';
        lyrics.style.display = 'none';
    }
}

/* Enter lyrics mode: show lyric lines, start the lyric timer + smooth scroll
   loop. Controls are hidden until the mouse hovers over the lyrics. */
function showLyrics(m) {
    _lyricActive = true;
    _lyricBase = { pos: m.position || 0, t: Date.now() };
    _lyricCurIdx = -1;   // 强制重置，保证重新进入时水平滚动从 0 开始
    applyLyricView();
    if (!_lyricTimer) {
        _lyricTimer = setInterval(renderLyrics, 500);
    }
    if (!_lyricRaf) {
        _lyricRaf = requestAnimationFrame(_lyricAnimLoop);
    }
    renderLyrics();
}

/* Exit lyrics mode: restore controls, stop the lyric timer and scroll loop. */
function hideLyrics() {
    _lyricActive = false;
    _lyricHover = false;
    _lyricCurIdx = -1;
    applyLyricView();
    if (_lyricTimer) { clearInterval(_lyricTimer); _lyricTimer = null; }
    if (_lyricRaf) { cancelAnimationFrame(_lyricRaf); _lyricRaf = null; }
    const curEl = document.getElementById('h-lyric-current');
    if (curEl) {
        curEl.scrollLeft = 0;
        curEl.style.transition = '';
        curEl.style.opacity = '';
        curEl.style.transform = '';
    }
}

/* Toggle whether the mouse is over the lyrics — revealing/hiding controls. */
function setLyricHover(on) {
    _lyricHover = on;
    applyLyricView();
}

/** Batch-update all cover images with the same source. When there is no cover,
 *  show the gray music-icon placeholder inside the cover box. */
function _updateCovers(cover) {
    const ids = ['h-music-cover'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.src = cover || ''; el.style.display = cover ? '' : 'none'; }
    });
    const ph = document.getElementById('h-music-cover-ph');
    if (ph) ph.style.display = cover ? 'none' : '';
    _applyCoverAccent(cover);
}

/* Sample the cover's dominant color and expose it as --music-accent so the
   large card can paint a subtle glow from the top-right / bottom-right corners. */
function _applyCoverAccent(cover) {
    const section = document.getElementById('music-section');
    if (!section) return;
    if (!cover) { section.style.removeProperty('--music-accent'); return; }
    const img = new Image();
    img.onload = () => {
        try {
            const size = 48;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, size, size);
            const data = ctx.getImageData(0, 0, size, size).data;
            let r = 0, g = 0, b = 0, n = 0;
            for (let i = 0; i < data.length; i += 4) {
                r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
            }
            r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
            // Lift dark/desaturated averages so the glow reads on the dark theme.
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const mix = lum < 70 ? 0.35 : 0.15;
            const boost = (c) => Math.round(c + (255 - c) * mix);
            section.style.setProperty('--music-accent', `rgb(${boost(r)}, ${boost(g)}, ${boost(b)})`);
        } catch (e) { /* tainted canvas or unsupported — leave glow off */ }
    };
    img.onerror = () => section.style.removeProperty('--music-accent');
    img.src = cover;
}

/* 多 SMTC 会话切换按钮：仅当存在多个会话时显示（multi/has-multi 类），
   按钮文案为「当前序号/总数」，tooltip 列出全部来源并标记当前项。 */
function updateMusicSwitch(m) {
    const btn = document.getElementById('h-music-switch');
    const section = document.getElementById('music-section');
    if (!btn || !section) return;
    const count = m.session_count || 0;
    const multi = count > 1;
    btn.classList.toggle('multi', multi);
    section.classList.toggle('has-multi', multi);
    if (!multi) { btn.title = ''; return; }
    const countEl = document.getElementById('h-music-switch-count');
    if (countEl) countEl.textContent = ((m.session_index || 0) + 1) + '/' + count;
    const names = m.session_names || [];
    const lines = names.map((n, i) => (i === m.session_index ? '› ' : '· ') + (n || '-'));
    btn.title = t('music-switch-source') + '\n' + lines.join('\n');
}

async function refreshMusic() {
    try {
        const m = await pywebview.api.get_music();
        updateMusicSwitch(m);
        const section = document.getElementById('music-section');
        const toggleBtn = document.getElementById('h-music-toggle');

        if (m.available && (m.playing || m.title)) {
            _musicPlaying = !!m.playing;
            setText('h-music-title', m.title || '--');
            setText('h-music-artist', m.artist || '--');
            const procEl = document.getElementById('h-music-process');
            if (procEl) procEl.textContent = m.process_name || '';
            // Feed the progress bar: interpolate from position between polls.
            if (m.duration > 0) {
                _musicBase = { pos: m.position || 0, t: Date.now() };
                _musicDur = m.duration;
                if (!_progressTimer) _progressTimer = setInterval(updateMusicProgress, 500);
                updateMusicProgress();
            }
            _setMusicProgressVisible(m.duration > 0);
            if (m.cover) {
                if (_lastCover !== m.cover) {
                    _lastCover = m.cover;
                    _updateCovers(m.cover);
                }
            } else {
                _lastCover = '';
                _updateCovers('');
            }
            if (section) {
                section.style.display = _sectionVisible('music-section') ? 'flex' : 'none';
                section.classList.toggle('paused', !m.playing);
            }
        } else {
            // No music playing: keep the section visible (visibility is controlled
            // by the feature toggle) but show a "not playing" placeholder.
            _lastCover = '';
            _updateCovers('');
            setText('h-music-title', t('music-not-playing'));
            setText('h-music-artist', '');
            const procEl = document.getElementById('h-music-process');
            if (procEl) procEl.textContent = '';
            if (section) {
                section.classList.add('paused');
            }
            if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; }
            _musicDur = 0;
            _musicPlaying = false;
            _musicBase = { pos: 0, t: Date.now() };
            _setMusicProgressVisible(false);
            updateMusicProgress();
        }
        if (toggleBtn) {
            // Pause (⏸) while playing, Play (⏵) while paused
            toggleBtn.textContent = m.playing ? '⏸' : '⏵';
        }
        handleLyrics(m);
    } catch (e) { console.warn('refreshMusic:', e && e.message ? e.message : String(e), e); }
}

/* Decide whether to show lyrics (track present + position source usable +
   configured + process in whitelist). Position is usable either from the
   player's timeline (duration > 0) or, when 歌词预测 is enabled, from the
   backend's elapsed-time estimate (position_estimated === true).
   Paused: keep lyrics visible but frozen — baseline is only advanced while
   playing, so lines stop at the current one until playback resumes. */
function handleLyrics(m) {
    const s = window._appSettings || {};
    const inWhitelist = processInLyricsWhitelist((s.lyrics || {}).process_whitelist, m && m.process_name);
    const hasTrack = !!(m && (m.title || m.artist));
    // 暂停时 m.playing 为 false，但曲目信息仍在 → 保持歌词显示且冻结
    const posUsable = !!(m && (m.duration > 0 || ((s.lyrics || {}).estimated_position && m.position_estimated)));
    const lyricMode = !!(hasTrack && lyricsSourceConfigured() && inWhitelist && posUsable);
    if (!lyricMode) {
        if (_lyricActive) hideLyrics();
        return;
    }
    const key = (m.title || '') + '|' + (m.artist || '');
    if (_lyricKey === key) {
        // Same track already loaded — keep advancing while playing
        if (_lyricActive) {
            if (_musicPlaying) {
                _lyricBase = { pos: m.position || 0, t: Date.now() };
                renderLyrics();
            }
            // paused: 不重置基线也不推进，歌词停在当前行
        } else {
            showLyrics(m);
        }
        return;
    }
    // New track — show placeholder immediately, then fetch once
    _lyricKey = key;
    _lyricRawLines = [];
    _lyricLines = [];
    showLyrics(m);
    pywebview.api.get_lyrics(m.title, m.artist).then((res) => {
        _lyricRawLines = (res && res.lines) || [];
        _applyLyricTransform();
        if (_lyricActive) renderLyrics();
    }).catch(() => {
        _lyricRawLines = [];
        _lyricLines = [];
        if (_lyricActive) renderLyrics();
    });
}

/* 判断当前歌词数据源是否可用。Meting 需配置地址；LrcApi 恒可用（有默认公开 API）。 */
function lyricsSourceConfigured() {
    const s = window._appSettings || {};
    const ly = s.lyrics || {};
    const source = ly.source || 'meting';
    if (source === 'lrcapi') return true;
    return !!((s.music || {}).meting_api_base || '').trim();
}

/* 判断进程名是否在歌词白名单内。白名单逗号分隔，大小写不敏感、支持子串匹配
   （如 "potplayer" 能匹配 "potplayer64"）。留空表示不限制任何进程。 */
function processInLyricsWhitelist(whitelist, processName) {
    const pn = (processName || '').toLowerCase();
    const list = String(whitelist || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
    if (!list.length) return true;       // 未配置白名单 → 不限制
    if (!pn) return false;
    return list.some(w => pn.includes(w) || w.includes(pn));
}

/* Wire hover on the whole music area: hovering anywhere over it reveals
   playback controls (when in lyric mode). Binding on the persistent container
   avoids a flicker loop that would occur if the hidden lyrics element
   disappeared from under the cursor. */
function bindLyricHover() {
    const section = document.getElementById('music-section');
    if (!section) return;
    section.addEventListener('mouseenter', () => setLyricHover(true));
    section.addEventListener('mouseleave', () => setLyricHover(false));
}

/* Spawn a ripple from the pointer position on a music control button */
function spawnCtrlRipple(btn, event) {
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    const cx = (event && event.clientX != null) ? event.clientX : rect.left + rect.width / 2;
    const cy = (event && event.clientY != null) ? event.clientY : rect.top + rect.height / 2;
    const ripple = document.createElement('span');
    ripple.className = 'ctrl-ripple';
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (cx - rect.left - size / 2) + 'px';
    ripple.style.top = (cy - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
}

// Click MEM % to clean memory (sweep animation + count-down)
let _memCleanPending = false;
let _lastCleanAt = 0;
let _memCleanRestoreTimer = null;
let _memInfoOrig = null;  // pristine info-line HTML, captured once at init

/** Count the big MEM % from its current display value to the cleaned value. */
function animateMemPct(fromVal, toVal) {
    const el = document.getElementById('mem-pct');
    if (!el) return;
    const start = performance.now();
    const dur = 650;
    const step = (now) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);  // ease-out cubic
        el.textContent = Math.round(fromVal + (toVal - fromVal) * eased);
        if (t < 1) {
            requestAnimationFrame(step);
        } else {
            applyLoadColor('mem-pct');
        }
    };
    requestAnimationFrame(step);
}

/** Format a byte count as MB or GB for the cleaned-amount line. */
function fmtFreed(bytes) {
    if (!bytes || bytes <= 0) return '0 MB';
    if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    return Math.round(bytes / (1024 * 1024)) + ' MB';
}

/** Restart the info-line swap animation on an element. */
function animInfoSwap(el) {
    el.classList.remove('info-swap');
    void el.offsetWidth;
    el.classList.add('info-swap');
}

/** Swap the MEM info lines to "已清理 / <amount>" for 5s, then restore them. */
function showMemCleaned(freedBytes, deep) {
    const lines = document.querySelectorAll('#mem-section .box-content .info-line');
    if (lines.length < 2) return;
    if (_memCleanRestoreTimer) { clearTimeout(_memCleanRestoreTimer); _memCleanRestoreTimer = null; }
    const label = deep ? t('mem-cleaned-deep') : t('mem-cleaned');
    lines[0].innerHTML = `<span class="mono mem-clean-status">${label}</span>`;
    lines[1].innerHTML = `<span class="mono mem-clean-status">${fmtFreed(freedBytes)}</span>`;
    animInfoSwap(lines[0]);
    animInfoSwap(lines[1]);
    _memCleanRestoreTimer = setTimeout(() => {
        if (_memInfoOrig) {
            lines[0].innerHTML = _memInfoOrig[0];
            lines[1].innerHTML = _memInfoOrig[1];
            animInfoSwap(lines[0]);
            animInfoSwap(lines[1]);
        }
        _memCleanRestoreTimer = null;
    }, 5000);
}

function initMemCleanClick() {
    const el = document.getElementById('mem-pct');
    if (!el) return;
    el.title = t('mem-clean-hint');
    // Snapshot the original info lines once (re-clicking mid-display must
    // restore the real sensor lines, not the current "已清理" text)
    const lines = document.querySelectorAll('#mem-section .box-content .info-line');
    if (lines.length >= 2) _memInfoOrig = [lines[0].innerHTML, lines[1].innerHTML];
    el.addEventListener('click', async () => {
        const section = document.getElementById('mem-section');
        if (!section) return;
        // Re-click within 3s → deeper cleanup
        const deep = (Date.now() - _lastCleanAt) < 3000;
        // Restart the sweep/pulse/glow animation on every click
        section.classList.remove('cleaning');
        void section.offsetWidth;
        section.classList.add('cleaning');
        setTimeout(() => section.classList.remove('cleaning'), 950);
        try {
            const r = await pywebview.api.clean_memory(deep);
            if (r && r.ok) {
                _lastCleanAt = Date.now();
                _memCleanPending = true;
                showMemCleaned(r.freed_bytes || 0, deep);
            }
        } catch (e) { console.warn('clean_memory:', e); }
    });
}
initMemCleanClick();

/* ================= 音乐频谱可视化 =================
   后端 WASAPI 回环捕获 + FFT，经 evaluate_js 推送柱值到 window.__spectrum；
   这里做插值补间与 canvas 绘制。位置/颜色/平滑度/柱数均由 music.spectrum_* 设置驱动，
   改动即时生效（settings.js 会同步写入 window._appSettings）。 */

const SPEC_STALE_MS = 450;   // 超时未收到推送则视为停止，柱值向 0 淡出
const SPEC_LERP_MIN = 0.03;  // 平滑度 100% 时的最低插值系数，保证柱值仍会缓慢趋近目标
const SPEC_POS = ['bottom', 'top', 'left', 'right'];
const SPEC_COLORS = ['gradient', 'theme', 'cover'];
const SPEC_STYLES = ['bars', 'wave'];

const _spec = { canvas: null, ctx: null, cur: [], target: [], lastAt: 0, raf: 0 };
let _coverColor = null;   // 封面取色缓存 [r,g,b]
let _coverSrc = '';

/** 后端推送入口：bands 为 0..1 的柱值数组；空数组表示捕获已停止。 */
window.__spectrum = function (bands) {
    const section = document.getElementById('music-section');
    if (!section || section.style.display === 'none') return;
    if (!Array.isArray(bands) || bands.length === 0) {
        _spec.target = [];
        return;
    }
    _spec.target = bands.map(Number);
    _spec.lastAt = performance.now();
    if (!_spec.raf) _spec.raf = requestAnimationFrame(specFrame);
};

function specCfg() {
    const m = ((window._appSettings || {}).music || {});
    const pos = SPEC_POS.includes(m.spectrum_position) ? m.spectrum_position : 'bottom';
    const color = SPEC_COLORS.includes(m.spectrum_color) ? m.spectrum_color : 'gradient';
    const style = SPEC_STYLES.includes(m.spectrum_style) ? m.spectrum_style : 'bars';
    // 平滑度 0~100 映射为每帧插值系数：65%（默认）即原 0.35，100% 时钳到下限避免柱值冻结
    const raw = Number(m.spectrum_smooth);
    const smooth = Math.min(100, Math.max(0, Number.isFinite(raw) ? raw : 65));
    const lerp = Math.max(SPEC_LERP_MIN, 1 - smooth / 100);
    return { pos, color, style, lerp };
}

/* 从音乐封面提取主色（饱和度加权平均）。跨域图片会抛异常，返回 null 走回退色。 */
function specCoverColor() {
    const img = document.getElementById('h-music-cover');
    if (!img || !img.src || img.style.display === 'none') return null;
    if (_coverSrc === img.src && _coverColor) return _coverColor;
    try {
        const c = document.createElement('canvas');
        c.width = c.height = 24;
        const cx = c.getContext('2d', { willReadFrequently: true });
        cx.drawImage(img, 0, 0, 24, 24);
        const d = cx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, wsum = 0;
        for (let i = 0; i < d.length; i += 4) {
            const mx = Math.max(d[i], d[i + 1], d[i + 2]);
            const mn = Math.min(d[i], d[i + 1], d[i + 2]);
            const wgt = (mx - mn) * 1.5 + (mx + mn) * 0.15 + 8; // 饱和度加权，避免暗边主导
            r += d[i] * wgt; g += d[i + 1] * wgt; b += d[i + 2] * wgt; wsum += wgt;
        }
        if (!wsum) return null;
        _coverColor = [Math.round(r / wsum), Math.round(g / wsum), Math.round(b / wsum)];
        _coverSrc = img.src;
    } catch (e) {
        return null; // 画布被跨域污染等情况
    }
    return _coverColor;
}

function specThemeColor() {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(v);
    if (!m) return [255, 255, 255];
    const h = parseInt(m[1], 16);
    return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
}

function specBarRGB(colorMode, idx, total) {
    if (colorMode === 'gradient') {
        const hue = 205 + (idx / Math.max(1, total - 1)) * 280; // 蓝→紫→粉的多彩扫掠
        return `hsla(${hue.toFixed(0)},75%,60%,`;
    }
    const rgb = colorMode === 'cover' ? (specCoverColor() || specThemeColor()) : specThemeColor();
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},`;
}

function specEnsureCanvas() {
    if (_spec.canvas) return true;
    const canvas = document.getElementById('music-spectrum');
    if (!canvas) return false;
    _spec.canvas = canvas;
    _spec.ctx = canvas.getContext('2d');
    return true;
}

function specDraw(cfg) {
    const { ctx } = _spec;
    const canvas = _spec.canvas;
    const sec = canvas.parentElement;
    const dpr = window.devicePixelRatio || 1;
    const w = sec.clientWidth, h = sec.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const n = _spec.cur.length;
    if (!n) return;
    if (cfg.style === 'wave') {
        specDrawWave(cfg, w, h, n);
        return;
    }

    const horizontal = cfg.pos === 'left' || cfg.pos === 'right';
    const span = horizontal ? h : w;
    const thick = horizontal ? w : h;
    const gap = 3;
    const bw = (span - gap * (n - 1)) / n;

    for (let i = 0; i < n; i++) {
        const v = Math.min(1, _spec.cur[i] || 0);
        if (v < 0.01) continue;
        const len = v * thick;
        const off = i * (bw + gap);
        const colorPrefix = specBarRGB(cfg.color, i, n);
        const grad = horizontal
            ? ctx.createLinearGradient(cfg.pos === 'left' ? len : w - len, 0, cfg.pos === 'left' ? 0 : w, 0)
            : ctx.createLinearGradient(0, cfg.pos === 'top' ? len : h - len, 0, cfg.pos === 'top' ? 0 : h);
        grad.addColorStop(0, colorPrefix + '0.26)');
        grad.addColorStop(1, colorPrefix + '0.05)');
        ctx.fillStyle = grad;

        let x, y, wd, ht;
        if (cfg.pos === 'bottom')      { x = off; y = h - len; wd = bw; ht = len; }
        else if (cfg.pos === 'top')    { x = off; y = 0; wd = bw; ht = len; }
        else if (cfg.pos === 'left')   { x = 0; y = off; wd = len; ht = bw; }
        else                           { x = w - len; y = off; wd = len; ht = bw; }

        if (ctx.roundRect) {
            ctx.beginPath();
            ctx.roundRect(x, y, wd, ht, Math.min(2, Math.min(wd, ht) / 2));
            ctx.fill();
        } else {
            ctx.fillRect(x, y, wd, ht);
        }
    }
}

/* 渐变波形样式：柱值作为采样点，中点二次贝塞尔平滑成连续曲线，
   从卡片边缘（按频谱位置）向内填充渐变。 */
function specDrawWave(cfg, w, h, n) {
    const { ctx } = _spec;
    const horizontal = cfg.pos === 'left' || cfg.pos === 'right';
    const span = horizontal ? h : w;
    const thick = horizontal ? w : h;

    // 采样点：与柱状模式相同的中心位置与长度映射
    const step = span / n;
    const pts = [];
    for (let i = 0; i < n; i++) {
        const v = Math.min(1, _spec.cur[i] || 0);
        const len = Math.max(2, v * thick);
        const c = i * step + step / 2;
        if (cfg.pos === 'bottom')      pts.push([c, h - len]);
        else if (cfg.pos === 'top')    pts.push([c, len]);
        else if (cfg.pos === 'left')   pts.push([len, c]);
        else                           pts.push([w - len, c]);
    }

    // 填充色：theme/cover 单色；gradient 沿跨度轴做色相扫掠，与柱状观感一致
    const grad = horizontal
        ? ctx.createLinearGradient(0, 0, 0, h)
        : ctx.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i < n; i++) {
        grad.addColorStop(n === 1 ? 0 : i / (n - 1), specBarRGB(cfg.color, i, n) + '1)');
    }
    // 淡出方向：从基线向外加深（外缘最亮）。offset 0 在外缘、offset 1 在基线。
    let fade;
    if (cfg.pos === 'bottom')      fade = ctx.createLinearGradient(0, h - thick * 0.9, 0, h);
    else if (cfg.pos === 'top')    fade = ctx.createLinearGradient(0, thick * 0.9, 0, 0);
    else if (cfg.pos === 'left')   fade = ctx.createLinearGradient(thick * 0.9, 0, 0, 0);
    else                           fade = ctx.createLinearGradient(w - thick * 0.9, 0, w, 0);
    fade.addColorStop(0, 'rgba(0,0,0,1)');
    fade.addColorStop(1, 'rgba(0,0,0,0.3)');

    ctx.beginPath();
    // 基线起点
    if (cfg.pos === 'bottom')      ctx.moveTo(pts[0][0], h);
    else if (cfg.pos === 'top')    ctx.moveTo(pts[0][0], 0);
    else if (cfg.pos === 'left')   ctx.moveTo(0, pts[0][1]);
    else                           ctx.moveTo(w, pts[0][1]);

    // 中点平滑：quadraticCurveTo 控制点为当前点、终点为中点
    ctx.lineTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < n - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
    }
    ctx.lineTo(pts[n - 1][0], pts[n - 1][1]);

    // 基线终点并闭合
    if (cfg.pos === 'bottom')      { ctx.lineTo(w, h); }
    else if (cfg.pos === 'top')    { ctx.lineTo(w, 0); }
    else if (cfg.pos === 'left')   { ctx.lineTo(0, h); }
    else                           { ctx.lineTo(w, h); }
    ctx.closePath();

    // 叠合：色相/主题填充 + 外缘亮边，再用淡出层统一压暗靠基线一侧
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = specBarRGB(cfg.color, n - 1, n) + '0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = fade;
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
}

function specFrame() {
    _spec.raf = 0;
    if (!specEnsureCanvas()) return;
    const cfg = specCfg();
    const fresh = performance.now() - _spec.lastAt < SPEC_STALE_MS;
    const n = fresh ? Math.max(_spec.target.length, 1) : _spec.cur.length;
    if (_spec.cur.length !== n) _spec.cur.length = n;
    let alive = false;
    for (let i = 0; i < n; i++) {
        const t = fresh ? (_spec.target[i] || 0) : 0;
        const c = _spec.cur[i] || 0;
        const v = c + (t - c) * cfg.lerp;
        _spec.cur[i] = v;
        if (v > 0.005) alive = true;
    }
    specDraw(cfg);
    if (!alive && !fresh) {
        _spec.canvas.classList.remove('on');
        _spec.cur = [];
        _spec.target = [];
        return;
    }
    if (alive) _spec.canvas.classList.add('on');
    _spec.raf = requestAnimationFrame(specFrame);
}
