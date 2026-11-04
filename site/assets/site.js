/*
 * ynab-mcp site behaviour. Progressive enhancement only: every page is
 * complete without this file. No network requests, no storage, no cookies.
 */
(function () {
  'use strict';

  var root = document.documentElement;
  root.classList.add('js');

  // ---------- Mobile nav ----------
  var toggle = document.querySelector('.nav-toggle');
  var nav = document.getElementById('site-nav');
  if (toggle && nav) {
    toggle.hidden = false;
    toggle.addEventListener('click', function () {
      var open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      nav.classList.toggle('is-open', !open);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && nav.classList.contains('is-open')) {
        toggle.setAttribute('aria-expanded', 'false');
        nav.classList.remove('is-open');
        toggle.focus();
      }
    });
  }

  // ---------- Copy buttons ----------
  var status = document.createElement('div');
  status.className = 'visually-hidden';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  document.body.appendChild(status);

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy') ? resolve() : reject(new Error('copy failed'));
      } catch (err) {
        reject(err);
      } finally {
        document.body.removeChild(ta);
      }
    });
  }

  document.querySelectorAll('.code').forEach(function (block) {
    var pre = block.querySelector('pre');
    // data-no-copy: a command typed by hand, so Copy can't overwrite a token on the clipboard.
    if (!pre || block.hasAttribute('data-no-copy')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    var label = block.getAttribute('data-label');
    btn.setAttribute('aria-label', label ? 'Copy ' + label : 'Copy code');
    btn.addEventListener('click', function () {
      copyText(pre.innerText.replace(/\n$/, '')).then(
        function () {
          btn.textContent = 'Copied';
          status.textContent = 'Copied to clipboard';
          setTimeout(function () {
            btn.textContent = 'Copy';
            status.textContent = '';
          }, 1800);
        },
        function () {
          btn.textContent = 'Press Ctrl+C';
          status.textContent = 'Copy failed. Select the text and copy it manually.';
        }
      );
    });
    block.appendChild(btn);
  });

  // ---------- Tabs ----------
  // Markup: <div class="tabs" data-tabs> containing <section class="tab-panel"
  // id="..."> elements, each starting with <h3 class="tab-title">. Without JS
  // the sections read top to bottom.
  document.querySelectorAll('[data-tabs]').forEach(function (container, ci) {
    var panels = Array.prototype.slice.call(container.querySelectorAll(':scope > .tab-panel'));
    if (panels.length < 2) return;
    var list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    var labelledBy = container.getAttribute('data-tabs-label');
    if (labelledBy) list.setAttribute('aria-labelledby', labelledBy);
    var tabs = panels.map(function (panel, i) {
      var title = panel.querySelector('.tab-title');
      var tab = document.createElement('button');
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.id = 'tab-' + ci + '-' + i;
      tab.setAttribute('aria-controls', panel.id);
      tab.textContent = title ? title.textContent : 'Tab ' + (i + 1);
      panel.setAttribute('role', 'tabpanel');
      panel.setAttribute('aria-labelledby', tab.id);
      panel.setAttribute('tabindex', '0');
      list.appendChild(tab);
      return tab;
    });

    function select(index, focus) {
      tabs.forEach(function (tab, i) {
        var on = i === index;
        tab.setAttribute('aria-selected', String(on));
        tab.tabIndex = on ? 0 : -1;
        panels[i].hidden = !on;
      });
      if (focus) tabs[index].focus();
    }

    tabs.forEach(function (tab, i) {
      tab.addEventListener('click', function () {
        select(i, false);
      });
      tab.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = tabs.length - 1;
        if (next !== null) {
          e.preventDefault();
          select(next, true);
        }
      });
    });

    // Show the panel that is, or contains, the element the URL fragment names,
    // then scroll to that element: the browser can't scroll to a hidden one.
    function showHash() {
      var target = null;
      try {
        if (location.hash) target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      } catch (e) {
        target = null;
      }
      if (!target) return false;
      for (var i = 0; i < panels.length; i++) {
        if (panels[i].contains(target)) {
          select(i, false);
          target.scrollIntoView();
          return true;
        }
      }
      return false;
    }

    container.insertBefore(list, panels[0]);
    if (!showHash()) select(0, false);
    window.addEventListener('hashchange', showHash);
  });

  // ---------- Tool filter ----------
  var search = document.getElementById('tool-search');
  var kind = document.getElementById('tool-kind');
  var controls = document.querySelector('.tool-controls');
  if (search && kind && controls) {
    controls.hidden = false;
    var items = Array.prototype.slice.call(document.querySelectorAll('#tool-groups .tool-list > li'));
    var groups = Array.prototype.slice.call(document.querySelectorAll('#tool-groups .tool-group'));
    var countEl = document.getElementById('tool-count');
    var empty = document.getElementById('no-results');
    var total = items.length;
    var timer = null;

    function apply() {
      var terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      var k = kind.value;
      var shown = 0;
      items.forEach(function (li) {
        var hay = li.getAttribute('data-search') || '';
        var okText = terms.every(function (t) {
          return hay.indexOf(t) !== -1;
        });
        var okKind = k === 'all' || li.getAttribute('data-kind') === k ||
          (k === 'write' && li.getAttribute('data-kind') === 'destructive');
        var show = okText && okKind;
        li.hidden = !show;
        if (show) shown++;
      });
      groups.forEach(function (g) {
        var visible = g.querySelectorAll('.tool-list > li:not([hidden])').length;
        g.hidden = visible === 0;
        var n = g.querySelector('.n');
        if (n) n.textContent = visible === Number(g.getAttribute('data-total'))
          ? n.getAttribute('data-full')
          : visible + ' of ' + g.getAttribute('data-total');
      });
      if (empty) empty.hidden = shown !== 0;
      if (countEl) {
        countEl.textContent = shown === total
          ? 'Showing all ' + total + ' tools.'
          : 'Showing ' + shown + ' of ' + total + ' tools.';
      }
    }

    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(apply, 80);
    });
    kind.addEventListener('change', apply);
    apply();
  }
})();
