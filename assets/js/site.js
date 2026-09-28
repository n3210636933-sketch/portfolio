/* ==========================================================================
   site.js — 全站交互
   1. 中英切换      2. 导航（吸顶 / 毛玻璃 / 移动端抽屉）
   3. 滚动揭示      4. Lenis 惯性滚动（可选，失败自动降级）
   5. 光标跟随缩略图 6. 联系弹窗   7. 复制联系方式   8. 返回顶部
   所有增强均为渐进式：脚本失效时页面仍可用。
   ========================================================================== */

(function () {
  'use strict';

  var doc = document;
  var root = doc.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ======================================================================
     1. 中英双语切换
     ====================================================================== */

  var LANG_KEY = 'nlx-lang';

  function applyLang(lang) {
    root.setAttribute('data-lang', lang);
    root.setAttribute('lang', lang === 'en' ? 'en' : 'zh-CN');

    var buttons = doc.querySelectorAll('[data-set-lang]');
    for (var i = 0; i < buttons.length; i++) {
      var isOn = buttons[i].getAttribute('data-set-lang') === lang;
      buttons[i].setAttribute('aria-pressed', isOn ? 'true' : 'false');
    }
    try { localStorage.setItem(LANG_KEY, lang); } catch (e) { /* 隐私模式忽略 */ }
  }

  // 读取初始值（<head> 内联脚本已提前设置，这里兜底）
  var initialLang = root.getAttribute('data-lang') || 'zh';
  applyLang(initialLang);

  doc.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-set-lang]') : null;
    if (!btn) return;
    applyLang(btn.getAttribute('data-set-lang'));
  });

  /* ======================================================================
     2. 导航
     ====================================================================== */

  var nav = doc.querySelector('.site-nav');
  var burger = doc.querySelector('.nav-burger');
  var navLinks = doc.querySelector('.nav-links');

  function closeDrawer() {
    if (!navLinks || !burger) return;
    navLinks.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
  }

  if (burger && navLinks) {
    burger.addEventListener('click', function () {
      var open = navLinks.classList.toggle('is-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    navLinks.addEventListener('click', function (e) {
      if (e.target.closest('a')) closeDrawer();
    });

    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeDrawer();
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 860) closeDrawer();
    });
  }

  /* 滚动状态：吸顶毛玻璃 + 返回顶部 */
  var toTop = doc.createElement('button');
  toTop.className = 'to-top';
  toTop.type = 'button';
  toTop.setAttribute('aria-label', '返回顶部 / Back to top');
  toTop.innerHTML = '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">' +
    '<path d="M8 13V3M8 3L3.5 7.5M8 3l4.5 4.5" stroke="currentColor" stroke-width="1.4" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></svg>';
  toTop.addEventListener('click', function () {
    if (window.__lenis) window.__lenis.scrollTo(0, { duration: 1.1 });
    else window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  });
  doc.body.appendChild(toTop);

  var ticking = false;
  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    if (nav) nav.classList.toggle('is-stuck', y > 24);
    toTop.classList.toggle('is-shown', y > window.innerHeight * 0.9);
    ticking = false;
  }

  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(onScroll);
  }, { passive: true });

  onScroll();

  /* 标记当前页导航项 */
  var here = window.location.pathname.split('/').pop() || 'index.html';
  var navAnchors = doc.querySelectorAll('.nav-links a');
  for (var n = 0; n < navAnchors.length; n++) {
    var target = (navAnchors[n].getAttribute('href') || '').split('/').pop().split('#')[0];
    if (target && (target === here || (here === 'index.html' && target === ''))) {
      navAnchors[n].setAttribute('aria-current', 'page');
    }
  }

  /* ======================================================================
     3. 滚动揭示
     ====================================================================== */

  var reveals = doc.querySelectorAll('.reveal');

  if (!('IntersectionObserver' in window) || reduceMotion) {
    for (var r = 0; r < reveals.length; r++) reveals[r].classList.add('is-in');
  } else {
    // 同一 [data-stagger] 容器内的元素依次延迟
    var groups = doc.querySelectorAll('[data-stagger]');
    for (var g = 0; g < groups.length; g++) {
      var step = parseInt(groups[g].getAttribute('data-stagger'), 10) || 90;
      var kids = groups[g].querySelectorAll('.reveal');
      for (var k = 0; k < kids.length; k++) {
        kids[k].style.setProperty('--reveal-delay', (k * step) + 'ms');
      }
    }

    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.08 });

    for (var q = 0; q < reveals.length; q++) io.observe(reveals[q]);
  }

  /* 技能条：进入视口时再填充 */
  var bars = doc.querySelectorAll('.bar-item');
  if ('IntersectionObserver' in window && bars.length) {
    var barIo = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-in');
        barIo.unobserve(entry.target);
      });
    }, { threshold: 0.4 });
    for (var b = 0; b < bars.length; b++) barIo.observe(bars[b]);
  } else {
    for (var b2 = 0; b2 < bars.length; b2++) bars[b2].classList.add('is-in');
  }

  /* ======================================================================
     4. Lenis 惯性滚动（可选增强）
     ====================================================================== */

  function initLenis() {
    if (reduceMotion || typeof window.Lenis !== 'function') return;
    var lenis = new window.Lenis({
      duration: 1.05,
      easing: function (t) { return Math.min(1, 1.001 - Math.pow(2, -10 * t)); },
      smoothWheel: true,
      wheelMultiplier: 0.95,
      touchMultiplier: 1.6
    });
    window.__lenis = lenis;

    function raf(time) { lenis.raf(time); window.requestAnimationFrame(raf); }
    window.requestAnimationFrame(raf);

    // 站内锚点交给 Lenis
    doc.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('a[href^="#"]') : null;
      if (!a) return;
      var id = a.getAttribute('href');
      if (!id || id === '#') return;
      var el = doc.querySelector(id);
      if (!el) return;
      e.preventDefault();
      lenis.scrollTo(el, { offset: -90 });
    });
  }

  // 若 CDN 稍后加载完成，再初始化
  window.addEventListener('load', initLenis);
  if (doc.readyState === 'complete') initLenis();

  /* ======================================================================
     5. 光标跟随缩略图（精选作品）
     ====================================================================== */

  var rows = doc.querySelectorAll('[data-thumb]');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  if (rows.length && finePointer && !reduceMotion) {
    var thumb = doc.createElement('div');
    thumb.className = 'cursor-thumb';
    thumb.setAttribute('aria-hidden', 'true');
    thumb.innerHTML = '<img alt="" />';
    doc.body.appendChild(thumb);
    var thumbImg = thumb.querySelector('img');

    var tx = 0, ty = 0, cx = 0, cy = 0, active = false, rafId = null;

    function loop() {
      cx += (tx - cx) * 0.14;
      cy += (ty - cy) * 0.14;
      thumb.style.transform = 'translate3d(' + (cx - 150) + 'px,' + (cy - 112) + 'px,0) scale(' + (active ? 1 : 0.86) + ')';
      rafId = window.requestAnimationFrame(loop);
    }

    doc.addEventListener('mousemove', function (e) {
      tx = e.clientX;
      ty = e.clientY;
    }, { passive: true });

    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        row.addEventListener('mouseenter', function (e) {
          var src = row.getAttribute('data-thumb');
          if (thumbImg.getAttribute('src') !== src) thumbImg.setAttribute('src', src);
          tx = e.clientX; ty = e.clientY;
          if (cx === 0 && cy === 0) { cx = tx; cy = ty; }
          active = true;
          thumb.classList.add('is-active');
          if (!rafId) loop();
        });
        row.addEventListener('mouseleave', function () {
          active = false;
          thumb.classList.remove('is-active');
        });
      })(rows[i]);
    }
  }

  /* ======================================================================
     6. 联系弹窗（原生 <dialog>）
     ====================================================================== */

  var CONTACT = {
    email: 'n3210636933@outlook.com',
    phone: '186 3651 3232',
    phoneRaw: '18636513232',
    location: '山西 · 长治 ／ Shanxi, Changzhi',
    wechat: '18636513232'
  };

  function dialogHTML() {
    return '' +
      '<dialog class="contact-dialog" id="contact-dialog" aria-labelledby="cd-title">' +
        '<div class="contact-dialog__head">' +
          '<div>' +
            '<p class="eyebrow">Contact</p>' +
            '<h2 id="cd-title" style="font-size:var(--fs-h3);margin-top:var(--sp-3)">' +
              '<span data-lang="zh">让我们一起创造。</span>' +
              '<span data-lang="en">Let\u2019s create something.</span>' +
            '</h2>' +
          '</div>' +
          '<button type="button" class="dialog-close" data-dialog-close aria-label="关闭 / Close">' +
            '<svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden="true">' +
            '<path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
          '</button>' +
        '</div>' +
        '<div class="contact-dialog__body">' +
          '<div class="contact-list">' +
            '<div class="contact-row">' +
              '<span class="contact-row__k">Email</span>' +
              '<a class="contact-row__v" href="mailto:' + CONTACT.email + '">' + CONTACT.email + '</a>' +
              '<button type="button" class="copy-btn" data-copy="' + CONTACT.email + '">复制</button>' +
            '</div>' +
            '<div class="contact-row">' +
              '<span class="contact-row__k">Phone</span>' +
              '<a class="contact-row__v" href="tel:' + CONTACT.phoneRaw + '">' + CONTACT.phone + '</a>' +
              '<button type="button" class="copy-btn" data-copy="' + CONTACT.phoneRaw + '">复制</button>' +
            '</div>' +
            '<div class="contact-row">' +
              '<span class="contact-row__k">WeChat</span>' +
              '<span class="contact-row__v">' + CONTACT.wechat + '</span>' +
              '<button type="button" class="copy-btn" data-copy="' + CONTACT.wechat + '">复制</button>' +
            '</div>' +
            '<div class="contact-row">' +
              '<span class="contact-row__k">Base</span>' +
              '<span class="contact-row__v" style="font-size:1rem">' + CONTACT.location + '</span>' +
            '</div>' +
          '</div>' +
          '<p class="figcaption" style="margin-top:var(--sp-5)">' +
            '<span data-lang="zh">通常 24 小时内回复。欢迎附带项目背景、时间节点与预算区间。</span>' +
            '<span data-lang="en">I usually reply within 24 hours. Feel free to include project context, timeline and budget range.</span>' +
          '</p>' +
        '</div>' +
      '</dialog>';
  }

  var dialog = null;

  function getDialog() {
    if (dialog) return dialog;
    var holder = doc.createElement('div');
    holder.innerHTML = dialogHTML();
    dialog = holder.firstChild;
    doc.body.appendChild(dialog);

    dialog.addEventListener('click', function (e) {
      if (e.target === dialog) dialog.close();               // 点击遮罩关闭
      if (e.target.closest && e.target.closest('[data-dialog-close]')) dialog.close();
    });
    return dialog;
  }

  doc.addEventListener('click', function (e) {
    var trigger = e.target.closest ? e.target.closest('[data-modal-open]') : null;
    if (!trigger) return;
    var d = getDialog();
    if (typeof d.showModal === 'function') {
      e.preventDefault();
      d.showModal();
    }
    // 不支持 <dialog> 时不拦截，按 href 跳到 contact.html
  });

  /* ======================================================================
     7. 复制联系方式
     ====================================================================== */

  doc.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-copy]') : null;
    if (!btn) return;
    var text = btn.getAttribute('data-copy');

    function done(ok) {
      var old = btn.textContent;
      btn.textContent = ok ? '已复制 ✓' : '复制失败';
      btn.classList.add('is-copied');
      window.setTimeout(function () {
        btn.textContent = old;
        btn.classList.remove('is-copied');
      }, 1800);
    }

    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
    } else {
      // file:// 或非安全上下文下的兜底
      try {
        var ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:absolute;left:-9999px;opacity:0';
        doc.body.appendChild(ta);
        ta.select();
        var ok = doc.execCommand('copy');
        doc.body.removeChild(ta);
        done(ok);
      } catch (err) { done(false); }
    }
  });

  /* ======================================================================
     8. 杂项：年份
     ====================================================================== */

  var yearEls = doc.querySelectorAll('[data-year]');
  for (var y = 0; y < yearEls.length; y++) {
    yearEls[y].textContent = String(new Date().getFullYear());
  }

  /* 页面载入完成标记（供 CSS 做渐进增强） */
  doc.body.classList.add('is-ready');
})();
