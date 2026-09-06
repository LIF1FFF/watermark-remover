(function () {
  const $ = (s) => document.querySelector(s);
  const urlInput = $('#urlInput');
  const parseBtn = $('#parseBtn');
  const pasteBtn = $('#pasteBtn');
  const clearBtn = $('#clearBtn');
  const errorBox = $('#errorBox');
  const resultBox = $('#result');
  const platformsBox = $('#platforms');
  const toast = $('#toast');

  const PLATFORM_ICON = {
    douyin: '🎵', kuaishou: '⚡', xiaohongshu: '📕',
    weibo: '🌐', bilibili: '📺', direct: '🔗',
  };
  const PLATFORM_NAME = {
    douyin: '抖音', kuaishou: '快手', xiaohongshu: '小红书',
    weibo: '微博', bilibili: '哔哩哔哩', direct: '直链',
  };

  let toastTimer = null;
  function showToast(msg) {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.hidden = true), 2400);
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.hidden = false;
  }
  function hideError() {
    errorBox.hidden = true;
  }

  function safeName(title, ext) {
    let n = (title || 'video').replace(/[\\/:*?"<>|\n\r\t]/g, '').trim().slice(0, 40);
    if (!n) n = 'video';
    return n + '.' + ext;
  }

  // 加载平台列表
  fetch('/api/platforms')
    .then((r) => r.json())
    .then((res) => {
      if (res.ok) {
        platformsBox.innerHTML = res.data
          .map((p) => `<span class="chip">${PLATFORM_ICON[p.key] || '✨'} ${p.name}</span>`)
          .join('');
      }
    })
    .catch(() => {});

  // 输入时高亮对应平台
  urlInput.addEventListener('input', () => {
    const v = urlInput.value;
    const map = [
      [/douyin\.com|iesdouyin/i, 'douyin'],
      [/kuaishou\.com|gifshow/i, 'kuaishou'],
      [/xiaohongshu\.com|xhslink/i, 'xiaohongshu'],
      [/weibo\.com|weibo\.cn/i, 'weibo'],
      [/bilibili\.com|b23\.tv/i, 'bilibili'],
    ];
    const chips = platformsBox.querySelectorAll('.chip');
    let hit = '';
    for (const [re, key] of map) if (re.test(v)) { hit = key; break; }
    res = PLATFORM_NAME[hit] || '';
    chips.forEach((c) => {
      const name = c.textContent.trim().split(' ').pop();
      c.classList.toggle('active', !!hit && name === res);
    });
  });

  clearBtn.addEventListener('click', () => {
    urlInput.value = '';
    resultBox.hidden = true;
    hideError();
    urlInput.focus();
  });

  pasteBtn.addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        urlInput.value = text.trim();
        showToast('已粘贴');
      }
    } catch (e) {
      showToast('无法读取剪贴板，请手动粘贴');
      urlInput.focus();
    }
  });

  parseBtn.addEventListener('click', doParse);
  urlInput.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') doParse();
  });

  async function doParse() {
    const url = urlInput.value.trim();
    if (!url) {
      showError('请先粘贴视频链接');
      return;
    }
    hideError();
    resultBox.hidden = true;

    const spinner = parseBtn.querySelector('.spinner');
    const btnText = parseBtn.querySelector('.btn-text');
    spinner.hidden = false;
    btnText.textContent = '解析中…';
    parseBtn.disabled = true;

    try {
      const res = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '解析失败');
      render(json.data);
    } catch (e) {
      showError(e.message || '解析失败，请稍后重试');
    } finally {
      spinner.hidden = true;
      btnText.textContent = '解析去水印';
      parseBtn.disabled = false;
    }
  }

  function render(data) {
    const icon = PLATFORM_ICON[data.platform] || '✨';
    const pname = PLATFORM_NAME[data.platform] || data.platform;
    const isVideo = data.type === 'video' && data.videos && data.videos.length;
    const images = data.images || [];

    let mediaHtml = '';
    if (isVideo) {
      const src = '/api/download?inline=1&url=' + encodeURIComponent(data.videos[0]);
      mediaHtml = `<video class="preview-box" controls playsinline src="${src}"></video>`;
    } else if (images.length) {
      mediaHtml = `<div class="img-grid">${images
        .map((u) => `<img src="/api/image?url=${encodeURIComponent(u)}" onclick="window.open(this.src,'_blank')" loading="lazy">`)
        .join('')}</div>`;
    } else {
      mediaHtml = `<div class="err">未获取到可下载的媒体内容</div>`;
    }

    const dlButtons = [];
    if (isVideo) {
      dlButtons.push(
        `<button class="btn btn-download" data-dl="${encodeURIComponent(data.videos[0])}" data-name="${encodeURIComponent(safeName(data.title, 'mp4'))}">⬇ 下载无水印视频</button>`
      );
      dlButtons.push(
        `<a class="btn btn-ghost btn-short" href="${'/api/download?inline=1&url=' + encodeURIComponent(data.videos[0])}" target="_blank">🔗 新窗口打开</a>`
      );
    }
    if (images.length) {
      dlButtons.push(
        `<button class="btn btn-download" data-dl-all="${encodeURIComponent(JSON.stringify(images))}" data-name="${encodeURIComponent(safeName(data.title, 'jpg'))}">⬇ 下载全部原图 (${images.length})</button>`
      );
    }
    if (data.cover) {
      dlButtons.push(
        `<button class="btn btn-ghost btn-short" data-dl="${encodeURIComponent(data.cover)}" data-name="${encodeURIComponent(safeName(data.title, 'jpg'))}">🖼 封面</button>`
      );
    }

    const meta = [];
    if (data.author) meta.push(`👤 ${escapeHtml(data.author)}`);
    if (data.duration) meta.push(`⏱ ${data.duration}s`);
    if (data.cost) meta.push(`⚡ ${(data.cost / 1000).toFixed(1)}s`);

    resultBox.innerHTML = `
      <div class="res-head">
        ${data.cover ? `<img class="res-cover" src="/api/image?url=${encodeURIComponent(data.cover)}" onerror="this.style.display='none'">` : ''}
        <div class="res-meta">
          <div class="res-title"><span class="res-badge">${icon} ${pname}</span>${escapeHtml(data.title || '无标题')}</div>
          <div class="res-sub">${meta.join(' · ')}</div>
        </div>
      </div>
      <div class="res-body">
        ${mediaHtml}
        <div class="res-actions">${dlButtons.join('')}</div>
        ${data.note ? `<div class="url-row">${escapeHtml(data.note)}</div>` : ''}
        ${isVideo ? `<div class="url-row"><b>无水印地址：</b>${escapeHtml(data.videos[0])}</div>` : ''}
      </div>
    `;
    resultBox.hidden = false;

    // 绑定下载事件
    resultBox.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const u = btn.getAttribute('data-dl');
        const n = btn.getAttribute('data-name');
        window.location.href = `/api/download?url=${u}&name=${n}`;
        showToast('开始下载…');
      });
    });
    resultBox.querySelectorAll('[data-dl-all]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const list = JSON.parse(decodeURIComponent(btn.getAttribute('data-dl-all')));
        const base = decodeURIComponent(btn.getAttribute('data-name')).replace(/\.jpg$/, '');
        list.forEach((u, i) => {
          setTimeout(() => {
            const a = document.createElement('a');
            a.href = `/api/download?url=${encodeURIComponent(u)}&name=${encodeURIComponent(base + '_' + (i + 1) + '.jpg')}`;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            a.remove();
          }, i * 350);
        });
        showToast(`开始下载 ${list.length} 张图片`);
      });
    });

    resultBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 设置
  const modal = $('#settingsModal');
  const apiInput = $('#apiInput');
  $('#settingsBtn').addEventListener('click', () => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((res) => {
        if (res.ok) apiInput.value = res.config.thirdPartyApi || '';
      })
      .catch(() => {});
    modal.hidden = false;
  });
  $('#closeSettings').addEventListener('click', () => (modal.hidden = true));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  $('#saveConfig').addEventListener('click', () => {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thirdPartyApi: apiInput.value }),
    })
      .then((r) => r.json())
      .then(() => {
        showToast('设置已保存');
        modal.hidden = true;
      })
      .catch(() => showToast('保存失败'));
  });

  // 拖动/粘贴自动解析
  urlInput.addEventListener('paste', () => {
    setTimeout(() => {
      const v = urlInput.value.trim();
      if (/https?:\/\//.test(v)) doParse();
    }, 60);
  });
})();
