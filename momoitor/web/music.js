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
    if (!curEl || !nextEl) return;
    const pos = _lyricBase.pos + (Date.now() - _lyricBase.t) / 1000;
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
    curEl.scrollLeft = p * over;
}

/* 歌词动画循环（每帧 rAF）：
   - 文本：切句瞬间立即刷新（_lyricCurIdx 变化即更新），不再依赖 500ms 定时器，
     因此歌词切换及时。
   - 滚动：切句时立即把当前行 scrollLeft 归零（从行首开始），随后每帧由
     _scrollCurrentLine 向右平滑推进，实现单行长歌词的水平滚动。
   - 切句动画：不做向上/向下滚动过渡，直接替换文本（简单、省性能）。 */
let _lyricRaf = null;      // requestAnimationFrame 句柄

function _lyricAnimLoop() {
    _lyricRaf = requestAnimationFrame(_lyricAnimLoop);
    if (!_lyricActive) return;
    const prevEl = document.getElementById('h-lyric-prev');
    const curEl = document.getElementById('h-lyric-current');
    const nextEl = document.getElementById('h-lyric-next');
    if (!curEl || !nextEl) return;
    const pos = _lyricBase.pos + (Date.now() - _lyricBase.t) / 1000;
    const { cur, next, curIdx } = _findLyricAt(pos);
    if (curIdx !== _lyricCurIdx) {
        _lyricCurIdx = curIdx;
        const prev = curIdx > 0 ? _lyricLines[curIdx - 1] : null;
        _setLyricTexts(prevEl, curEl, nextEl, prev, cur, next);
        curEl.scrollLeft = 0;
    }
    if (!_lyricAnimEnabled) { if (curEl.scrollLeft) curEl.scrollLeft = 0; return; }
    _scrollCurrentLine(curEl, cur, next, pos);
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

/** Batch-update all cover images with the same source. */
function _updateCovers(cover) {
    const ids = ['h-music-cover'];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.src = cover || ''; el.style.display = cover ? '' : 'none'; }
    });
}

async function refreshMusic() {
    try {
        const m = await pywebview.api.get_music();
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
                section.classList.remove('not-playing');
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
                section.classList.add('not-playing');
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

/* Decide whether to show lyrics (playing + position available + configured
   + process in whitelist). Fetches lyrics once per track, then shows
   current/next lines over the controls. */
function handleLyrics(m) {
    const s = window._appSettings || {};
    const metingBase = s.meting_api_base || '';
    const inWhitelist = processInLyricsWhitelist(s.lyrics_process_whitelist, m && m.process_name);
    const lyricMode = !!(m && m.playing && m.position >= 0 && m.duration > 0 && metingBase && inWhitelist);
    if (!lyricMode) {
        if (_lyricActive) hideLyrics();
        return;
    }
    const key = (m.title || '') + '|' + (m.artist || '');
    if (_lyricKey === key) {
        // Same track already loaded — keep advancing
        if (_lyricActive) {
            _lyricBase = { pos: m.position || 0, t: Date.now() };
            renderLyrics();
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

/* ── Click MEM % to clean memory (sweep animation + count-down) ── */
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
            applyLoadColor('mem-pct', toVal);
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
