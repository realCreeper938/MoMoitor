/* Lyrics: 歌词显示与平滑滚动。
   整份歌词一次性渲染为纵向列表，视口固定两行高（当前句 + 下一句）；
   换句时列表通过 translateY 过渡把下一句平滑滚动进当前行位置，
   上一句同步滚出视口——即音乐 App 常见的歌词滚动效果。
   单行超长歌词仍由 scrollLeft 按播放进度做水平滚动。 */

/* Lyrics */
let _lyricLines = [];      // 当前曲目的歌词行 [{time, text}, ...]（可能已展开翻译）
let _lyricRawLines = [];   // 未展开的原始歌词行（翻译模式开启时由它生成 _lyricLines）
let _lyricKey = '';        // 当前已加载歌词的曲目标识 "title|artist"
let _lyricBase = { pos: 0, t: 0 };  // 轮询间隙内插值估算当前时间的基准
let _lyricTimer = null;    // 歌词平滑推进定时器
let _lyricActive = false;  // 是否处于歌词显示模式
let _lyricHover = false;   // 鼠标是否悬停在歌词上（悬停时显示播放控件）
let _lyricCurIdx = -1;     // 当前渲染句子的下标，用于检测换句
let _lyricEls = [];        // 歌词行 DOM 数组（与 _lyricLines 一一对应）
let _lyricBuiltRef = null; // 构建列表时对应的 _lyricLines 引用（变化即需重建）
let _lyricActiveEl = null; // 当前高亮（激活）的歌词行 DOM

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

/* 把形如 "原文 (翻译)" 的歌词行拆成 {original, translation}；不匹配返回 null */
function _splitLyricTranslation(text) {
    if (!text) return null;
    const m = text.match(/^(.*?)\s*[（(]([^（）()]*)[)）]\s*$/);
    if (m && m[1].trim() && m[2].trim()) {
        return { original: m[1].trim(), translation: m[2].trim() };
    }
    return null;
}

/* 重建歌词列表 DOM：整份歌词一次性渲染，换句只改高亮与滚动位置。
   无歌词时显示占位符 ♪。 */
function _rebuildLyricList() {
    const listEl = document.getElementById('h-lyric-list');
    if (!listEl) return;
    const lines = _lyricLines.length ? _lyricLines : [{ time: 0, text: '♪' }];
    listEl.textContent = '';
    const frag = document.createDocumentFragment();
    for (const l of lines) {
        const el = document.createElement('div');
        el.className = 'lyric-line';
        el.textContent = l.text;
        frag.appendChild(el);
    }
    listEl.appendChild(frag);
    _lyricEls = Array.from(listEl.children);
    _lyricActiveEl = null;
    _lyricBuiltRef = _lyricLines;
}

/* 把第 idx 句滚动到视口顶部（当前行位置）：下一句平滑滚入、上一句滚出。
   换句动画关闭或游戏模式下跳过过渡，直接定位（生硬但省性能）。 */
function _activateLyricLine(idx) {
    if (_lyricBuiltRef !== _lyricLines) _rebuildLyricList();
    const listEl = document.getElementById('h-lyric-list');
    if (!listEl || !_lyricEls.length) return;
    if (_lyricActiveEl) _lyricActiveEl.classList.remove('active');
    const i = Math.max(0, Math.min(idx, _lyricEls.length - 1));
    const el = _lyricEls[i];
    _lyricActiveEl = el;
    el.classList.add('active');
    el.scrollLeft = 0;   // 新行水平滚动从行首开始
    _lyricScrollStepT = 0;
    const instant = !_lyricSwitchAnimEnabled || (window.isGameModeActive && window.isGameModeActive());
    const y = 'translateY(' + (-el.offsetTop) + 'px)';
    if (instant) {
        listEl.style.transition = 'none';
        listEl.style.transform = y;
        void listEl.offsetWidth;
        listEl.style.transition = '';
    } else {
        listEl.style.transform = y;
    }
}

/* Render the current lyric line based on interpolated position.
   仅在歌词内容变化或换句时更新高亮与滚动；滚动细节由 rAF 循环负责。 */
function renderLyrics() {
    if (!_lyricActive) return;
    // 暂停时偏移量固定为 0：歌词停在当前行（预测/真实进度均适用）
    const pos = _lyricBase.pos + (_musicPlaying ? Date.now() - _lyricBase.t : 0) / 1000;
    const { curIdx } = _findLyricAt(pos);
    if (curIdx !== _lyricCurIdx || _lyricBuiltRef !== _lyricLines) {
        _lyricCurIdx = curIdx;
        _activateLyricLine(curIdx);
    }
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
    // 关闭时（或游戏模式下）按 ~500ms 步进直接跳动（生硬无动画，减少连续布局开销）。
    if (_lyricAnimEnabled && !(window.isGameModeActive && window.isGameModeActive())) {
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
   - 换句：_lyricCurIdx 变化（或歌词内容重建）即把新句滚动进当前行位置，
     纵向平滑滚动由 CSS transform 过渡完成，无需逐帧计算。
   - 水平：单行超长歌词每帧由 _scrollCurrentLine 向右平滑推进。 */
let _lyricRaf = null;      // requestAnimationFrame 句柄
let _lyricScrollStepT = 0; // 关闭平滑滚动时的步进时间戳（~500ms 一跳）

function _lyricAnimLoop() {
    _lyricRaf = requestAnimationFrame(_lyricAnimLoop);
    if (!_lyricActive) return;
    // 暂停时偏移量固定为 0：动画循环同样停在当前行
    const pos = _lyricBase.pos + (_musicPlaying ? Date.now() - _lyricBase.t : 0) / 1000;
    const { cur, next, curIdx } = _findLyricAt(pos);
    if (curIdx !== _lyricCurIdx || _lyricBuiltRef !== _lyricLines) {
        _lyricCurIdx = curIdx;
        _activateLyricLine(curIdx);
    }
    if (!_lyricActiveEl) return;
    // 翻译模式：当前行是翻译、下一行是同时间戳的原文。滚动只作用于当前行（翻译），
    // 进度边界取下一组翻译的时间，避免因同时间戳原文把 span 压成固定 2.5s。
    const paceNext = (_lyricAutoTranslate && cur && cur.trans === true && next && next.time === cur.time
        && curIdx + 2 < _lyricLines.length) ? _lyricLines[curIdx + 2] : next;
    _scrollCurrentLine(_lyricActiveEl, cur, paceNext, pos);
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
    _lyricActiveEl = null;
    applyLyricView();
    if (_lyricTimer) { clearInterval(_lyricTimer); _lyricTimer = null; }
    if (_lyricRaf) { cancelAnimationFrame(_lyricRaf); _lyricRaf = null; }
}

/* Toggle whether the mouse is over the lyrics — revealing/hiding controls. */
function setLyricHover(on) {
    _lyricHover = on;
    applyLyricView();
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
