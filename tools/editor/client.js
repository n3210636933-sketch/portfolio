/**
 * client.js — 编辑器在页面上的那部分（只在本地编辑器服务下才会被注入）
 *
 * 对访客来说这个文件根本不存在：正式上线的静态站里没有它。
 * 它的职责只有两个：把「可以改的地方」标出来，以及把你点的那一下发给本地服务去落盘。
 */
(function () {
  'use strict';

  var API = '/__editor/';
  var editing = false;
  var badge, pop, toastEl;

  /* ------------------------------------------------------------ 小工具 */
  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  }

  /**
   * 页面用 site.js 在运行时插入了联系弹窗（里面有 data-lang）和光标跟随缩略图
   * （里面有一个 img）。它们不在源码里，若不排除，序号就会和服务器对不上。
   */
  function excluded(el) {
    return !!(el.closest && el.closest('[data-editor-ui], dialog, .cursor-thumb, .to-top'));
  }

  /* 枚举规则必须与 editor-server.mjs 完全一致 */
  function slotsOf(kind) {
    var all;
    if (kind === 'img') all = document.querySelectorAll('img');
    else if (kind === 'plate') all = document.querySelectorAll('.plate');
    else all = document.querySelectorAll('[data-lang]');
    return Array.prototype.filter.call(all, function (el) {
      if (kind === 'text' && el === document.documentElement) return false;
      return !excluded(el);
    });
  }

  function currentFile() {
    return decodeURIComponent(location.pathname).replace(/^\/+/, '') || 'index.html';
  }

  function post(path, body, cb) {
    fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '保存失败');
        cb(null, j);
      })
      .catch(function (e) { cb(e); });
  }

  /* ------------------------------------------------------------ 提示条 */
  function toast(msg, kind) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ed-toast';
      toastEl.setAttribute('data-editor-ui', '');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.className = 'ed-toast is-shown' + (kind ? ' ed-toast--' + kind : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { toastEl.className = 'ed-toast'; }, kind === 'error' ? 6000 : 2600);
  }

  function hoverBadge(el, label) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'ed-badge';
      badge.setAttribute('data-editor-ui', '');
      document.body.appendChild(badge);
    }
    var r = el.getBoundingClientRect();
    badge.textContent = label;
    badge.style.left = Math.round(r.left + r.width / 2) + 'px';
    badge.style.top = Math.round(Math.max(8, r.top - 12)) + 'px';
    badge.classList.add('is-shown');
  }
  function hideBadge() { if (badge) badge.classList.remove('is-shown'); }

  /* ------------------------------------------------------------ 编辑模式 */
  function enterEdit() {
    editing = true;
    document.documentElement.classList.add('ed-on');
    document.querySelectorAll('[data-editor-ui]').forEach(function (n) {
      var b = n.querySelector('[data-ed-toggle]');
      if (b) { b.textContent = '完成编辑'; b.classList.add('is-active'); }
    });
    markAll();
    toast('已进入编辑模式：点图片换图，点文字改字');
  }

  function exitEdit() {
    editing = false;
    document.documentElement.classList.remove('ed-on');
    document.querySelectorAll('[data-editor-ui]').forEach(function (n) {
      var b = n.querySelector('[data-ed-toggle]');
      if (b) { b.textContent = '开始编辑'; b.classList.remove('is-active'); }
    });
    document.querySelectorAll('.ed-marked').forEach(function (n) { n.classList.remove('ed-marked'); });
    hideBadge();
    closePop();
    closeImagePop();
    // 点「完成编辑」通常就意味着「我改完了」，顺手把改动发布到线上
    publishNow();
  }

  function markAll() {
    ['img', 'plate', 'text'].forEach(function (kind) {
      slotsOf(kind).forEach(function (el) { el.classList.add('ed-marked'); });
    });
  }

  /* ------------------------------------------------------------ 悬停提示 */
  document.addEventListener('mouseover', function (e) {
    if (!editing) return;
    var t = e.target;
    if (!t.closest || t.closest('[data-editor-ui]')) return;
    var plate = t.closest('.plate');
    if (plate && !excluded(plate)) { hoverBadge(plate, '点击替换这张图'); return; }
    var img = t.closest('img');
    if (img && !excluded(img)) { hoverBadge(img, '点击替换这张图'); return; }
    var txt = t.closest('[data-lang]');
    if (txt && txt !== document.documentElement && !excluded(txt)) { hoverBadge(txt, '点击修改这段文字'); return; }
    hideBadge();
  }, true);

  /* ------------------------------------------------------------ 点击接管 */
  document.addEventListener('click', function (e) {
    if (!editing) return;
    var t = e.target;
    if (t.closest && t.closest('[data-editor-ui]')) return; // 工具栏自己处理

    var plate = t.closest('.plate');
    if (plate && !excluded(plate)) return handleImage(plate, 'plate', e);
    var img = t.closest('img');
    if (img && !excluded(img)) return handleImage(img, 'img', e);
    var txt = t.closest('[data-lang]');
    if (txt && txt !== document.documentElement && !excluded(txt)) return handleText(txt, e);
  }, true);

  /* ------------------------------------------------------------ 换图片 */
  /**
   * 点一张图之后不再直接弹「选文件」，而是先问一句：用你自己的图，还是让 AI 现生一张？
   * 两条路最后都走同一个 POST /__editor/image，所以「落盘 + 改引用 + 备份 + 发布」
   * 的规则完全一致，不会因为多了个 AI 入口就出现两套行为。
   */
  function handleImage(el, kind, e) {
    e.preventDefault();
    e.stopPropagation();
    openImagePop(el, kind);
  }

  function closeImagePop() { if (imgPop) { imgPop.remove(); imgPop = null; } closeAiPanel(); }

  function closeAiPanel() {
    if (aiPop) { aiPop.remove(); aiPop = null; }
    closeProgress();
  }

  function closeProgress() {
    if (progTimer) { clearInterval(progTimer); progTimer = null; }
    if (progEl) { progEl.remove(); progEl = null; }
  }

  function openImagePop(el, kind) {
    closePop();
    closeImagePop();

    imgPop = document.createElement('div');
    imgPop.className = 'ed-pop ed-pop--img';
    imgPop.setAttribute('data-editor-ui', '');
    imgPop.innerHTML =
      '<div class="ed-pop__head">换这张图</div>' +
      '<button type="button" class="ed-opt" data-ed-pick>' +
      '<span class="ed-opt__t">选一张本地图片</span>' +
      '<span class="ed-opt__d">从电脑里挑一张，立刻替换</span>' +
      '</button>' +
      '<button type="button" class="ed-opt ed-opt--ai" data-ed-ai>' +
      '<span class="ed-opt__t">✨ AI 生图</span>' +
      '<span class="ed-opt__d" data-ed-aistate>写提示词，让 Agnes 现场生成一张</span>' +
      '</button>' +
      '<div class="ed-pop__foot"><button type="button" class="ed-btn ed-btn--ghost" data-ed-cancel>取消</button></div>';

    document.body.appendChild(imgPop);
    positionPop(imgPop, el);

    imgPop.querySelector('[data-ed-cancel]').addEventListener('click', closeImagePop);
    imgPop.querySelector('[data-ed-pick]').addEventListener('click', function () {
      closeImagePop();
      pickLocalFile(el, kind);
    });
    imgPop.querySelector('[data-ed-ai]').addEventListener('click', function () {
      var btn = this;
      setAiState(btn, '正在检查生图服务…');
      aiReady(function (err, res) {
        if (err) { setAiState(btn, '查不到生图状态：' + err.message, true); return; }
        if (!res.ready) {
          setAiState(btn, '还没配置 API key：在网站目录跑一次 node tools/set-key.mjs sk-你的key', true);
          return;
        }
        imgPop.remove(); imgPop = null;
        openAiPanel(el, kind);
      });
    });
  }

  function setAiState(btn, text, bad) {
    var s = btn.querySelector('[data-ed-aistate]');
    if (!s) return;
    s.textContent = text;
    s.className = 'ed-opt__d' + (bad ? ' is-bad' : '');
  }

  /* ---------------------------------------------------------- 本地文件 */
  function pickLocalFile(el, kind) {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
    input.setAttribute('data-editor-ui', '');
    input.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(input);

    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        badge && (badge.textContent = '正在保存…');
        saveImageTo({ file: currentFile(), kind: kind, ordinal: slotsOf(kind).indexOf(el), dataUrl: reader.result, filename: file.name }, el, kind, function (err, res) {
          if (err) { toast('替换失败：' + err.message, 'error'); hideBadge(); return; }
          hideBadge();
          toast('已替换；文件已保存到 ' + res.image);
        });
      };
      reader.readAsDataURL(file);
    });

    input.click();
  }

  /** 把「换图」的请求发给本地服务，成功后立刻在当前页面上生效（不用刷新） */
  function saveImageTo(body, el, kind, cb) {
    if (kind === 'img') {
      body.expectedSrc = el.getAttribute('src') || '';
      body.expectedAlt = el.getAttribute('alt') || '';
    } else {
      body.expectedLabel = labelOf(el);
    }
    post('image', body, function (err, res) {
      if (err) { cb(err); return; }
      applyImageLocally(el, kind, res.image);
      cb(null, res);
    });
  }

  function applyImageLocally(el, kind, relImage) {
    var url = '/' + relImage;
    if (kind === 'img') {
      var pre = new Image();
      pre.onload = function () {
        if (pre.naturalWidth) {
          el.setAttribute('width', pre.naturalWidth);
          el.setAttribute('height', pre.naturalHeight);
        }
      };
      pre.src = url;
      el.setAttribute('src', url);
      el.removeAttribute('srcset');
      el.setAttribute('data-ed-made', relImage);
    } else {
      el.style.backgroundImage = "url('" + url + "')";
      el.style.backgroundSize = 'cover';
      el.style.backgroundPosition = 'center';
      el.classList.add('is-filled');
      el.setAttribute('data-ed-made', relImage);
    }
    madeBy[madeKey(el, kind)] = relImage;
  }

  function labelOf(plate) {
    var l = plate.querySelector('.plate__label');
    return l ? l.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /** 认元素用的小账本：只活在这次页面会话里，刷新就没了（源码才是真相） */
  var madeBy = {};
  function madeKey(el, kind) { return kind + ':' + slotsOf(kind).indexOf(el); }

  /* --------------------------------------------------------- AI 生图 */
  var imgPop = null, aiPop = null, progEl = null, progTimer = null, aiStatus = null;

  function aiReady(cb) {
    if (aiStatus) { cb(null, aiStatus); return; }
    fetch('/__editor/status').then(function (r) { return r.json(); }).then(function (j) {
      aiStatus = (j && j.ai) || { ready: false, keyFrom: null };
      cb(null, aiStatus);
    }).catch(function (e) { cb(e); });
  }

  function openAiPanel(el, kind) {
    closeImagePop();
    var box = el.getBoundingClientRect();
    var nw = el.naturalWidth || Math.round(box.width) || 0;
    var nh = el.naturalHeight || Math.round(box.height) || 0;
    var stored = madeBy[madeKey(el, kind)] || '';
    var hasPicture = !!(kind === 'img' && nw && nh) || !!stored;

    aiPop = document.createElement('div');
    aiPop.className = 'ed-pop ed-pop--ai';
    aiPop.setAttribute('data-editor-ui', '');

    var html = '<div class="ed-pop__head">✨ AI 生图 · Agnes 2.5 Flash</div>' +
      '<label class="ed-pop__row"><span>提示词（越具体越好）</span>' +
      '<textarea rows="4" data-ed-prompt placeholder="主体 + 场景 + 风格 + 光照 + 构图，例如：白酒瓶身特写，深色木质台面，侧逆光，极简构图，高细节"></textarea></label>';

    if (hasPicture) {
      html += '<label class="ed-check"><input type="checkbox" data-ed-img2img checked>' +
        '<span>参考当前这张图改（图生图）<em>保留原始构图和主体，只按提示词改造</em></span></label>';
    } else {
      html += '<p class="ed-pop__note">这个位置现在是占位图版，还没有真实图片，所以只能纯文生图。</p>';
    }

    html += '<div class="ed-pop__grid">' +
      '<label class="ed-pop__row"><span>宽高比</span><select data-ed-ratio></select></label>' +
      '<label class="ed-pop__row"><span>尺寸</span><select data-ed-size></select></label>' +
      '</div>' +
      '<p class="ed-pop__note" data-ed-px></p>' +
      '<div class="ed-pop__foot">' +
      '<button type="button" class="ed-btn ed-btn--ghost" data-ed-cancel>取消</button>' +
      '<button type="button" class="ed-btn ed-btn--primary" data-ed-go>生成</button>' +
      '</div>';
    aiPop.innerHTML = html;

    /* 宽高比默认跟这张图在页面上的样子一致 —— 这样生成的图正好填满原位置，不会被裁掉 */
    var ratios = [
      ['1:1', '1:1 方形'], ['4:3', '4:3 横'], ['3:4', '3:4 竖'], ['3:2', '3:2 横'],
      ['2:3', '2:3 竖'], ['16:9', '16:9 横幅'], ['9:16', '9:16 竖屏'], ['21:9', '21:9 超宽'],
    ];
    var sizes = [['1K', '1K · 最快'], ['2K', '2K · 推荐'], ['3K', '3K'], ['4K', '4K · 最慢']];
    var rs = aiPop.querySelector('[data-ed-ratio]');
    ratios.forEach(function (r) {
      var o = document.createElement('option');
      o.value = r[0]; o.textContent = r[1];
      rs.appendChild(o);
    });
    var ss = aiPop.querySelector('[data-ed-size]');
    sizes.forEach(function (s) {
      var o = document.createElement('option');
      o.value = s[0]; o.textContent = s[1];
      ss.appendChild(o);
    });
    rs.value = bestRatio(box.width || nw, box.height || nh);
    ss.value = '2K';

    var table = {
      '1:1': { '1K': '1024×1024', '2K': '2048×2048', '3K': '3072×3072', '4K': '4096×4096' },
      '3:4': { '1K': '864×1152', '2K': '1728×2304', '3K': '2592×3456', '4K': '3456×4608' },
      '4:3': { '1K': '1152×864', '2K': '2304×1728', '3K': '3456×2592', '4K': '4608×3456' },
      '16:9': { '1K': '1312×736', '2K': '2624×1472', '3K': '3936×2208', '4K': '5248×2944' },
      '9:16': { '1K': '736×1312', '2K': '1472×2624', '3K': '2208×3936', '4K': '2944×5248' },
      '2:3': { '1K': '832×1248', '2K': '1664×2496', '3K': '2496×3744', '4K': '3328×4992' },
      '3:2': { '1K': '1248×832', '2K': '2496×1664', '3K': '3744×2496', '4K': '4992×3328' },
      '21:9': { '1K': '1568×672', '2K': '3136×1344', '3K': '4704×2016', '4K': '6272×2688' },
    };
    var pxNote = aiPop.querySelector('[data-ed-px]');
    function refreshPx() {
      var dim = (table[rs.value] || {})[ss.value] || '';
      pxNote.textContent = '输出 ' + dim + '（官方 2.5 Flash 尺寸表）· 当前位置约 ' +
        Math.round(box.width || 0) + '×' + Math.round(box.height || 0);
    }
    rs.addEventListener('change', refreshPx);
    ss.addEventListener('change', refreshPx);
    refreshPx();

    document.body.appendChild(aiPop);
    positionPop(aiPop, el);
    aiPop.querySelector('[data-ed-prompt]').focus();

    aiPop.querySelector('[data-ed-cancel]').addEventListener('click', function () {
      aiPop.remove(); aiPop = null;
    });
    aiPop.querySelector('[data-ed-go]').addEventListener('click', function () {
      runGenerate({
        el: el, kind: kind,
        promptEl: aiPop.querySelector('[data-ed-prompt]'),
        img2imgEl: aiPop.querySelector('[data-ed-img2img]'),
        ratio: rs.value,
        size: ss.value,
        width: box.width || nw,
        height: box.height || nh,
        goBtn: this,
      });
    });
  }

  /** 从一堆官方比例里挑最贴近当前元素形状的那个 */
  function bestRatio(w, h) {
    if (!w || !h) return '1:1';
    var list = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'];
    var target = w / h, best = '1:1', bestErr = Infinity;
    list.forEach(function (r) {
      var p = r.split(':');
      var want = Number(p[0]) / Number(p[1]);
      var err = Math.abs(target - want) / want;
      if (err < bestErr) { bestErr = err; best = r; }
    });
    return best;
  }

  /** 把页面上的图缩成长边 1280 的 JPEG data URI：够模型用，也不会把请求体撑爆 */
  function sourceDataUrl(el, kind) {
    return new Promise(function (resolve, reject) {
      var url = (kind === 'img' && el.getAttribute('src')) || madeBy[madeKey(el, kind)] || '';
      if (!url || /^data:/i.test(url)) { resolve(url || ''); return; }
      var img = new Image();
      img.onload = function () {
        try {
          var max = 1280;
          var w = img.naturalWidth || max, h = img.naturalHeight || max;
          var k = Math.min(1, max / Math.max(w, h));
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * k));
          c.height = Math.max(1, Math.round(h * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          var out = c.toDataURL('image/jpeg', 0.86);
          if (out.length > 7 * 1024 * 1024) { reject(new Error('参考图压缩后还是太大')); return; }
          resolve(out);
        } catch (e) { reject(e); }
      };
      img.onerror = function () { resolve(''); };
      img.src = url;
    });
  }

  function runGenerate(o) {
    var prompt = String(o.promptEl.value || '').trim();
    if (!prompt) { toast('先写一句提示词吧', 'error'); o.promptEl.focus(); return; }

    var useSource = !!(o.img2imgEl && o.img2imgEl.checked);
    o.goBtn.disabled = true;
    o.goBtn.textContent = '生成中…';

    var started = Date.now();
    var slow = useSource ? '约 25 秒' : '约 9 秒';
    var kick = function () {
      progress('AI 正在生图（' + slow + '）', started);
    };

    var chain = useSource ? sourceDataUrl(o.el, o.kind).catch(function () { return ''; }) : Promise.resolve('');
    chain.then(function (src) {
      kick();
      var body = {
        file: currentFile(),
        kind: o.kind,
        ordinal: slotsOf(o.kind).indexOf(o.el),
        prompt: prompt,
        size: o.size,
        ratio: o.ratio,
        width: Math.round(o.width),
        height: Math.round(o.height),
      };
      if (useSource && src) body.sourceDataUrl = src;
      if (o.kind === 'img') {
        body.expectedSrc = o.el.getAttribute('src') || '';
        body.expectedAlt = o.el.getAttribute('alt') || '';
        body.expectedMade = madeBy[madeKey(o.el, o.kind)] || '';
      } else {
        body.expectedLabel = labelOf(o.el);
      }

      post('generate', body, function (err, res) {
        closeProgress();
        o.goBtn.disabled = false;
        o.goBtn.textContent = '生成';
        if (err) {
          toast('生成失败：' + err.message, 'error');
          return;
        }
        applyImageLocally(o.el, o.kind, res.image);
        closeAiPanel();
        toast('已生成 ' + res.width + '×' + res.height + '（' + (res.ms / 1000).toFixed(0) + '秒）→ ' + res.image);
      });
    });
  }

  function progress(text, started) {
    closeProgress();
    progEl = document.createElement('div');
    progEl.className = 'ed-progress';
    progEl.setAttribute('data-editor-ui', '');
    progEl.textContent = text;
    document.body.appendChild(progEl);
    progTimer = setInterval(function () {
      if (!progEl) return;
      progEl.textContent = text + ' · 已等 ' + Math.round((Date.now() - started) / 1000) + ' 秒';
    }, 1000);
  }

  /* ------------------------------------------------------------ 改文字 */
  /**
   * 只取元素「自己的」文字，不含子元素里的文字（与服务器 directText 一致）。
   * 状态标签内部有个装圆点的 <span>，可编辑的只有圆点之后的正文。
   */
  function visibleText(el) {
    var out = '';
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeName === 'BR') out += '\n';
      else if (n.nodeType === 1) { /* 子元素里的文字不参与编辑，跳过 */ }
    }
    return decodeEntities(out).replace(/[ \t]+/g, ' ').trim();
  }

  /** 在同一父元素里找另一种语言的对应文本，这样中英文可以一起改 */
  function findPair(el) {
    var lang = el.getAttribute('data-lang');
    var other = lang === 'zh' ? 'en' : 'zh';
    var p = el.parentElement;
    if (!p) return null;
    var kids = Array.prototype.slice.call(p.children);
    var idx = kids.indexOf(el);
    var best = null, bestDist = Infinity;
    kids.forEach(function (c) {
      if (c.getAttribute && c.getAttribute('data-lang') === other) {
        var d = Math.abs(kids.indexOf(c) - idx);
        if (d < bestDist) { bestDist = d; best = c; }
      }
    });
    return best;
  }

  function handleText(el, e) {
    e.preventDefault();
    e.stopPropagation();
    openPop(el);
  }

  function closePop() {
    if (pop) { pop.remove(); pop = null; }
  }

  function openPop(el) {
    closePop();
    var pair = findPair(el);
    var zh = el.getAttribute('data-lang') === 'zh' ? el : pair;
    var en = el.getAttribute('data-lang') === 'en' ? el : pair;

    pop = document.createElement('div');
    pop.className = 'ed-pop';
    pop.setAttribute('data-editor-ui', '');

    var html = '<div class="ed-pop__head">修改文字</div>';
    if (zh) {
      html += '<label class="ed-pop__row"><span>中文</span><textarea rows="3"></textarea></label>';
    }
    if (en) {
      html += '<label class="ed-pop__row"><span>English</span><textarea rows="3"></textarea></label>';
    }
    if (!pair) {
      html += '<p class="ed-pop__note">这段没有找到对应的另一种语言版本，只会修改当前语言。</p>';
    }
    html += '<div class="ed-pop__foot">' +
      '<button type="button" class="ed-btn ed-btn--ghost" data-ed-cancel>取消</button>' +
      '<button type="button" class="ed-btn ed-btn--primary" data-ed-save>保存</button>' +
      '</div>';
    pop.innerHTML = html;

    var areas = pop.querySelectorAll('textarea');
    var ai = 0;
    if (zh) areas[ai++].value = visibleText(zh);
    if (en) areas[ai++].value = visibleText(en);

    document.body.appendChild(pop);
    positionPop(pop, el);
    areas[0] && areas[0].focus();

    pop.querySelector('[data-ed-cancel]').addEventListener('click', closePop);
    pop.querySelector('[data-ed-save]').addEventListener('click', function () {
      var jobs = [];
      var k = 0;
      if (zh) jobs.push({ el: zh, expected: visibleText(zh), value: areas[k++].value });
      if (en) jobs.push({ el: en, expected: visibleText(en), value: areas[k++].value });

      var pending = jobs.filter(function (j) { return j.value !== j.expected; });
      if (!pending.length) { closePop(); return; }

      var done = 0;
      var failed = null;
      pending.forEach(function (j) {
        post('text', {
          file: currentFile(),
          ordinal: slotsOf('text').indexOf(j.el),
          expected: j.expected,
          value: j.value,
        }, function (err, res) {
          if (err) failed = err;
          else applyText(j.el, j.value);
          if (++done === pending.length) {
            closePop();
            if (failed) toast('保存失败：' + failed.message, 'error');
            else toast('已保存到文件');
          }
        });
      });
    });
  }

  /** 与服务器 replaceNodeText 一样的规则：有子元素时只替换末尾的纯文字 */
  function applyText(el, value) {
    var inner = el.innerHTML;
    var newHtml = inner.indexOf('<br') !== -1
      ? value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')
      : value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    if (!/<[a-zA-Z]/.test(inner)) {
      el.innerHTML = newHtml;
      return;
    }
    var last = el.lastChild;
    if (last && last.nodeType === 3) {
      last.nodeValue = value;
    } else {
      el.appendChild(document.createTextNode(value));
    }
  }

  /**
   * 面板一律用 fixed 定位贴在元素旁边，而不是绝对定位到文档流里。
   * 用 fixed 的好处：无论页面滚到哪、面板多高，它都不会跑到屏幕外面去。
   */
  function positionPop(node, anchor) {
    var r = anchor.getBoundingClientRect();
    var w = node.classList.contains('ed-pop--ai') ? 400
      : node.classList.contains('ed-pop--img') ? 300 : 340;
    var h = node.offsetHeight || 240;
    var left = Math.min(Math.max(12, r.left), Math.max(12, window.innerWidth - w - 12));
    var top = r.bottom + 10;
    if (top + h > window.innerHeight - 12) {
      top = Math.max(12, r.top - h - 10);
      if (top < 12) top = Math.max(12, Math.min(r.bottom + 10, window.innerHeight - h - 12));
    }
    node.style.width = Math.min(w, window.innerWidth - 24) + 'px';
    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
  }

  /* ------------------------------------------------------- 发布到线上 */
  var publishBusy = false;

  function setPublishState(text, kind) {
    var el = document.querySelector('[data-ed-pubstate]');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'ed-pubstate' + (kind ? ' ed-pubstate--' + kind : '');
  }

  function publishNow() {
    if (publishBusy) return;
    publishBusy = true;
    setPublishState('正在发布…');
    post('publish', {}, function (err, res) {
      publishBusy = false;
      if (err) {
        setPublishState('发布失败', 'error');
        toast('发布失败：' + err.message + '（改动已存在本地，未丢失）', 'error');
        return;
      }
      if (!res.changed) { setPublishState('线上已是最新'); toast(res.message); return; }
      setPublishState('已发布 ' + (res.commit || ''), 'ok');
      toast(res.message);
    });
  }

  /* ------------------------------------------------------------ 工具栏 */
  function buildToolbar() {
    var bar = document.createElement('div');
    bar.className = 'ed-toolbar';
    bar.setAttribute('data-editor-ui', '');
    bar.innerHTML =
      '<span class="ed-pubstate" data-ed-pubstate></span>' +
      '<div class="ed-toolbar__hint">本地编辑器</div>' +
      '<button type="button" class="ed-btn ed-btn--primary" data-ed-toggle>开始编辑</button>' +
      '<button type="button" class="ed-btn ed-btn--ghost" data-ed-undo>撤销上一步</button>' +
      '<button type="button" class="ed-btn ed-btn--ghost" data-ed-publish>发布上线</button>';
    document.body.appendChild(bar);

    bar.querySelector('[data-ed-toggle]').addEventListener('click', function () {
      editing ? exitEdit() : enterEdit();
    });

    bar.querySelector('[data-ed-undo]').addEventListener('click', function () {
      if (!confirm('撤销最近一次保存，把这个文件恢复到上一次修改之前？')) return;
      post('undo', { file: currentFile() }, function (err, res) {
        if (err) { toast('撤销失败：' + err.message, 'error'); return; }
        toast('已撤销，正在刷新…');
        setTimeout(function () { location.reload(); }, 700);
      });
    });

    bar.querySelector('[data-ed-publish]').addEventListener('click', function () {
      if (publishBusy) { toast('正在发布，请稍候…'); return; }
      publishNow();
    });
  }

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closePop(); closeImagePop(); if (aiPop) { aiPop.remove(); aiPop = null; } }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildToolbar);
  } else {
    buildToolbar();
  }
})();
