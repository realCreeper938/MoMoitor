/* Port scanning popup */
let _portsData = null; // cached port list
let _portsSearchTimer = null;

async function openPortsPopup() {
    const overlay = document.getElementById('ports-popup-overlay');
    const body = document.getElementById('ports-popup-body');
    const searchInput = document.getElementById('ports-search-input');
    if (!overlay || !body) return;

    overlay.style.display = 'flex';
    body.innerHTML = '<div class="ports-loading">' + t('ports-scanning') + '</div>';
    if (searchInput) { searchInput.value = ''; searchInput.style.display = 'block'; }

    try {
        const ports = await pywebview.api.get_listening_ports();
        _portsData = ports;
        renderPortsList(ports);
    } catch (e) {
        console.warn('openPortsPopup:', e);
        body.innerHTML = '<div class="ports-empty">' + t('ports-empty') + '</div>';
    }
}

function renderPortsList(ports) {
    const body = document.getElementById('ports-popup-body');
    if (!body) return;
    if (!ports || ports.length === 0) {
        body.innerHTML = '<div class="ports-empty">' + t('ports-empty') + '</div>';
        return;
    }
    // Build header row
    let html = '<div class="ports-header-row">'
        + '<span class="ports-hdr ports-hdr-proto">' + t('ports-proto') + '</span>'
        + '<span class="ports-hdr ports-hdr-pid">PID</span>'
        + '<span class="ports-hdr ports-hdr-name">' + t('ports-name') + '</span>'
        + '<span class="ports-hdr ports-hdr-addr">' + t('ports-addr') + '</span>'
        + '<span class="ports-hdr ports-hdr-port">' + t('ports-port') + '</span>'
        + '<span class="ports-hdr ports-hdr-action"></span>'
        + '</div>';
    ports.forEach(function(item) {
        const addrStr = item.address + ':' + item.port;
        html += '<div class="ports-item">'
            + '<span class="ports-item-proto">' + escapeHtml(item.protocol) + '</span>'
            + '<span class="ports-item-pid">' + item.pid + '</span>'
            + '<span class="ports-item-name" title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</span>'
            + '<span class="ports-item-addr">' + escapeHtml(addrStr) + '</span>'
            + '<span class="ports-item-port">' + item.port + '</span>'
            + '<span class="ports-item-actions">'
            + '<button class="ports-item-btn ports-item-kill" data-pid="' + item.pid + '">' + t('ports-kill') + '</button>'
            + '</span>'
            + '</div>';
    });
    body.innerHTML = html;

    // Attach kill button handlers
    body.querySelectorAll('.ports-item-kill').forEach(function(btn) {
        btn.addEventListener('click', async function(e) {
            const pid = parseInt(e.target.getAttribute('data-pid'));
            await killPortProcess(pid, e.target);
        });
    });
}

async function killPortProcess(pid, btnEl) {
    if (!btnEl) return;
    btnEl.disabled = true;
    btnEl.textContent = '...';
    try {
        const result = await pywebview.api.kill_process(pid);
        if (result && result.success) {
            btnEl.textContent = '✓';
            btnEl.classList.add('ports-kill-done');
        } else {
            btnEl.textContent = '✗';
            btnEl.title = (result && result.message) ? result.message : t('ports-kill-fail');
        }
    } catch (e) {
        btnEl.textContent = '✗';
        console.warn('kill_process:', e);
    }
    // Re-scan after a short delay
    setTimeout(async function() {
        try {
            const ports = await pywebview.api.get_listening_ports();
            _portsData = ports;
            renderPortsList(ports);
        } catch (e) { /* ignore */ }
    }, 1500);
}

// Search filter for ports
function filterPortsList(query) {
    if (!_portsData) return;
    const q = query.trim().toLowerCase();
    if (!q) {
        renderPortsList(_portsData);
        return;
    }
    const filtered = _portsData.filter(function(item) {
        return String(item.port).indexOf(q) !== -1
            || item.name.toLowerCase().indexOf(q) !== -1
            || item.protocol.toLowerCase().indexOf(q) !== -1
            || String(item.pid).indexOf(q) !== -1;
    });
    renderPortsList(filtered);
}

// Debounced search input handler
(function() {
    const searchInput = document.getElementById('ports-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', function() {
            if (_portsSearchTimer) clearTimeout(_portsSearchTimer);
            _portsSearchTimer = setTimeout(function() {
                filterPortsList(searchInput.value);
            }, 150);
        });
    }
})();

function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// Close port popup
document.getElementById('ports-popup-close')?.addEventListener('click', function() {
    document.getElementById('ports-popup-overlay').style.display = 'none';
});
document.getElementById('ports-popup-overlay')?.addEventListener('click', function(e) {
    if (e.target === this) this.style.display = 'none';
});

// Click IP to show listening ports
document.addEventListener('click', function(e) {
    var ipEl = e.target.closest('#sysinfo-ip');
    if (ipEl) {
        openPortsPopup();
    }
});

/* i18n 内嵌链接：桌面模式调后端开系统浏览器，server 模式直接新开标签页 */
document.addEventListener('click', function(e) {
    var link = e.target.closest('a.i18n-link');
    if (!link) return;
    e.preventDefault();
    var url = link.getAttribute('href');
    if (window.pywebview && window.pywebview.api && window.pywebview.api.openExternal) {
        window.pywebview.api.openExternal(url)
            .catch(function() { window.open(url, '_blank'); });
    } else {
        window.open(url, '_blank');
    }
});
