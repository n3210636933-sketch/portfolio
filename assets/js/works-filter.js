/* ==========================================================================
   works-filter.js — 作品列表页的类型筛选
   · data-filter="all|brand|ad|book|package|illustration|ai"
   · 卡片 data-cat="brand package"（可多值）
   · 支持 URL 锚点直达（works.html#package），可分享、可后退
   ========================================================================== */

(function () {
  'use strict';

  var bar = document.querySelector('[data-filter-bar]');
  var grid = document.querySelector('[data-works-grid]');
  if (!bar || !grid) return;

  var buttons = bar.querySelectorAll('[data-filter]');
  var cards = grid.querySelectorAll('[data-cat]');
  var empty = document.querySelector('[data-filter-empty]');
  var countEl = document.querySelector('[data-result-count]');
  var live = document.querySelector('[data-filter-live]');
  var FADE = 220;

  function matches(card, key) {
    if (key === 'all') return true;
    var cats = (card.getAttribute('data-cat') || '').split(/\s+/);
    return cats.indexOf(key) !== -1;
  }

  function apply(key, animate) {
    var shown = 0;

    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var ok = matches(card, key);

      if (ok) {
        shown++;
        card.classList.remove('is-hidden');
        // 下一帧再移除淡出态，保证过渡被触发
        (function (c) {
          window.requestAnimationFrame(function () {
            window.requestAnimationFrame(function () { c.classList.remove('is-filtered-out'); });
          });
        })(card);
      } else if (animate) {
        card.classList.add('is-filtered-out');
        (function (c) {
          window.setTimeout(function () {
            if (c.classList.contains('is-filtered-out')) c.classList.add('is-hidden');
          }, FADE);
        })(card);
      } else {
        card.classList.add('is-filtered-out', 'is-hidden');
      }
    }

    for (var b = 0; b < buttons.length; b++) {
      buttons[b].setAttribute('aria-pressed', buttons[b].getAttribute('data-filter') === key ? 'true' : 'false');
    }

    if (empty) empty.hidden = shown !== 0;
    if (countEl) countEl.textContent = String(shown).padStart(2, '0');
    if (live) {
      live.textContent = '当前显示 ' + shown + ' 个项目 / Showing ' + shown + ' projects';
    }
  }

  function keyFromHash() {
    var k = (window.location.hash || '').replace('#', '');
    if (!k) return 'all';
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-filter') === k) return k;
    }
    return 'all';
  }

  bar.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-filter]') : null;
    if (!btn) return;
    var key = btn.getAttribute('data-filter');
    if (key === 'all') {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } else {
      history.replaceState(null, '', '#' + key);
    }
    apply(key, true);
  });

  window.addEventListener('hashchange', function () { apply(keyFromHash(), true); });

  apply(keyFromHash(), false);
})();
