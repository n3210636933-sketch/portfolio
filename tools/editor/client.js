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
  function handleImage(el, kind, e) {
    e.preventDefault();
    e.stopPropagation();

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
        var list = slotsOf(kind);
        var ordinal = list.indexOf(el);
        var body = {
          file: currentFile(),
          kind: kind,
          ordinal: ordinal,
          dataUrl: reader.result,
          filename: file.name,
        };
        if (kind === 'img') body.expectedSrc = el.getAttribute('src') || '';
        else body.expectedLabel = labelOf(el);

        badge && (badge.textContent = '正在保存…');
        post('image', body, function (err, res) {
          if (err) { toast('替换失败：' + err.message, 'error'); hideBadge(); return; }
          // 立刻在当前页面上生效，不用刷新
          var url = '/' + res.image;
          if (kind === 'img') {
            el.setAttribute('src', url);
          } else {
            el.style.backgroundImage = "url('" + url + "')";
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.classList.add('is-filled');
          }
          hideBadge();
          toast('已替换；文件已保存到 ' + res.image);
        });
      };
      reader.readAsDataURL(file);
    });

    input.click();
  }

  function labelOf(plate) {
    var l = plate.querySelector('.plate__label');
    return l ? l.textContent.replace(/\s+/g, ' ').trim() : '';
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

  function positionPop(node, anchor) {
    var r = anchor.getBoundingClientRect();
    var w = 340;
    node.style.width = w + 'px';
    var left = Math.min(Math.max(12, r.left), window.innerWidth - w - 12);
    var top = r.bottom + 10;
    if (top + 240 > window.innerHeight) top = Math.max(12, r.top - 250);
    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top + window.scrollY) + 'px';
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
    if (e.key === 'Escape') { closePop(); }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildToolbar);
  } else {
    buildToolbar();
  }
})();
