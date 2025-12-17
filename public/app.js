document.addEventListener('DOMContentLoaded', () => {
  // ---------- СНЕГ ----------
  const snowBtn = document.getElementById('snowToggle');
  const savedSnow = localStorage.getItem('snowEnabled');
  if (savedSnow === null) localStorage.setItem('snowEnabled', '1');
  const setSnowBtn = (on) => snowBtn?.classList.toggle('active', on);
  if (localStorage.getItem('snowEnabled') === '1') { window.Snow?.start(); setSnowBtn(true); }
  snowBtn?.addEventListener('click', () => {
    const on = localStorage.getItem('snowEnabled') === '1';
    if (on) { window.Snow?.stop(); localStorage.setItem('snowEnabled','0'); setSnowBtn(false); }
    else { window.Snow?.start(); localStorage.setItem('snowEnabled','1'); setSnowBtn(true); }
  });

  // ---------- ПЛЕЕР ----------
  const $ = (id) => document.getElementById(id);
  const audio = $('bgm');
  const btnPlay = $('plPlay'), btnPrev = $('plPrev'), btnNext = $('plNext');
  const btnShuffle = $('plShuffle'), btnRepeat = $('plRepeat');
  const vol = $('plVolume'), titleEl = $('plTitle'), curEl = $('plCur'), durEl = $('plDur');
  const progress = $('plProgress'), bar = $('plBar');
  const listBtn = $('plList'), drawer = $('plDrawer'), closeBtn = $('plClose'), listEl = $('plDrawerList');

  const state = {
    tracks: [],
    index: 0,
    shuffle: localStorage.getItem('plShuffle') === '1',
    repeat: localStorage.getItem('plRepeat') || 'all' // off | all | one
  };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmt(s) { if (!isFinite(s)) return '0:00'; const m = Math.floor(s/60), ss = Math.floor(s%60); return `${m}:${String(ss).padStart(2,'0')}`; }

  // Volume
  const savedVol = parseFloat(localStorage.getItem('bgmVolume') || '0.4');
  audio.volume = clamp(savedVol, 0, 1);
  if (vol) vol.value = String(Math.round(audio.volume * 100));
(function modalCloser(){
  const modal = document.getElementById('q-modal');
  const frame = document.getElementById('q-modal-frame');
  if (!modal || !frame) return;

  function openModal() {
    modal.classList.add('open');
    modal.removeAttribute('hidden');
    document.body.classList.add('modal-open');
  }
  function closeModal() {
    modal.classList.remove('open');
    document.body.classList.remove('modal-open');
    frame.innerHTML = '';
    modal.setAttribute('hidden', '');
  }

  // Открытие: уже есть у тебя при клике по ссылке с data-turbo-frame="q-modal-frame"
  // Если надо, оставь:
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[data-turbo-frame="q-modal-frame"]');
    if (a) openModal();
  });

  // Универсальное закрытие по кнопке в любом месте модалки
document.addEventListener('click', (e) => {
  if (e.target.closest?.('.modal-close')) {
    e.preventDefault();
    const modal = document.getElementById('q-modal');
    const frame = document.getElementById('q-modal-frame');
    if (modal && frame) { modal.classList.remove('open'); document.body.classList.remove('modal-open'); frame.innerHTML=''; modal.setAttribute('hidden',''); }
  }
});

  // Закрытие по клику на подложку и по Esc
  modal.addEventListener('click', (e) => {
    if (e.target.classList?.contains('modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // Если используешь Turbo — открыть, когда frame загрузился
  document.addEventListener('turbo:frame-load', (e) => {
    if (e.target?.id === 'q-modal-frame') openModal();
  });

  // Если используешь фолбэк с fetch — не забудь openModal() вызывать после подстановки HTML
  // и можно вызвать closeModal() при переходе по сайту.
})();
  // Shuffle/Repeat UI
  function applyShuffle(on) { state.shuffle = on; btnShuffle.classList.toggle('active', on); localStorage.setItem('plShuffle', on ? '1':'0'); }
  function cycleRepeat() {
    const order = ['off','all','one']; let i = order.indexOf(state.repeat); i = (i+1)%order.length;
    state.repeat = order[i]; btnRepeat.classList.toggle('active', state.repeat !== 'off');
    btnRepeat.textContent = state.repeat === 'one' ? '🔂' : '🔁';
    btnRepeat.dataset.mode = state.repeat;
    audio.loop = state.repeat === 'one';
    localStorage.setItem('plRepeat', state.repeat);
  }
  applyShuffle(state.shuffle);
  // показать правильную иконку повтора на старте
  (function initRepeatIcon(){ btnRepeat.textContent = state.repeat === 'one' ? '🔂' : '🔁'; btnRepeat.classList.toggle('active', state.repeat !== 'off'); })();

  // Fetch playlist
  async function loadTracks() {
    try {
      const res = await fetch('/api/audio', { cache: 'no-store' });
      const data = await res.json();
      state.tracks = data?.tracks || [];
      renderList();
      restoreLastAndMaybeAutoplay();
    } catch (e) {
      console.error('Не удалось загрузить список треков', e);
      titleEl.textContent = 'Плейлист недоступен';
    }
  }

  function renderList() {
    listEl.innerHTML = '';
    if (state.tracks.length === 0) {
      titleEl.textContent = 'Добавьте музыку в /public/audio';
      const li = document.createElement('li');
      li.className = 'pl-item muted';
      li.textContent = 'Нет аудио (поддержка: mp3, ogg, m4a, wav, webm)';
      listEl.appendChild(li);
      [btnPlay, btnPrev, btnNext].forEach(b => b.disabled = true);
      return;
    }
    [btnPlay, btnPrev, btnNext].forEach(b => b.disabled = false);
    state.tracks.forEach((t, i) => {
      const li = document.createElement('li');
      li.className = 'pl-item';
      li.dataset.index = String(i);
      li.textContent = t.title || t.file;
      li.addEventListener('click', () => playIndex(i, true));
      listEl.appendChild(li);
    });
    updateActiveInList();
    setTitle();
    setSrc();
  }

  function updateActiveInList() {
    const items = listEl.querySelectorAll('.pl-item');
    items.forEach(el => el.classList.toggle('active', Number(el.dataset.index) === state.index));
  }

  function setTitle() {
    const t = state.tracks[state.index];
    titleEl.textContent = t ? t.title : '—';
  }

  function setSrc() {
    const t = state.tracks[state.index];
    audio.src = t ? encodeURI(t.url) : '';
    audio.load();
  }

  async function playIndex(i, fromUser) {
    if (i < 0 || i >= state.tracks.length) return;
    state.index = i;
    localStorage.setItem('plIndex', String(i));
    setSrc(); setTitle(); updateActiveInList();
    try { await audio.play(); } catch (e) { if (fromUser) console.debug('Play blocked by browser', e); }
  }

  function togglePlay() { if (audio.paused) audio.play().catch(()=>{}); else audio.pause(); }

  function nextIndex() {
    if (state.tracks.length === 0) return state.index;
    if (state.shuffle) {
      if (state.tracks.length === 1) return state.index;
      let n; do { n = Math.floor(Math.random() * state.tracks.length); } while (n === state.index);
      return n;
    } else {
      const last = state.tracks.length - 1;
      if (state.index < last) return state.index + 1;
      return state.repeat === 'all' ? 0 : state.index;
    }
  }

  function prevIndex() {
    if (audio.currentTime > 3) return state.index; // рестарт текущего
    if (state.shuffle) return nextIndex();
    return state.index > 0 ? state.index - 1 : (state.repeat === 'all' ? state.tracks.length - 1 : 0);
  }

  // Controls
  btnPlay?.addEventListener('click', togglePlay);
  btnPrev?.addEventListener('click', () => {
    const i = prevIndex();
    if (i !== state.index) playIndex(i, true); else audio.currentTime = 0;
  });
  btnNext?.addEventListener('click', () => {
    const i = nextIndex();
    if (i !== state.index || state.repeat === 'all' || state.shuffle) playIndex(i, true);
  });
  btnShuffle?.addEventListener('click', () => applyShuffle(!state.shuffle));
  btnRepeat?.addEventListener('click', cycleRepeat);

  vol?.addEventListener('input', (e) => {
    const v = (e.target.valueAsNumber || parseInt(e.target.value,10))/100;
    audio.volume = clamp(v, 0, 1);
    localStorage.setItem('bgmVolume', String(audio.volume));
  });

  progress?.addEventListener('click', (e) => {
    if (!isFinite(audio.duration)) return;
    const rect = progress.getBoundingClientRect();
    const p = clamp((e.clientX - rect.left) / rect.width, 0, 1);
    audio.currentTime = p * audio.duration;
  });

  // Keyboard
  document.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    if (e.code === 'ArrowRight') audio.currentTime = Math.min((audio.currentTime||0) + 5, (audio.duration||0)-0.1);
    if (e.code === 'ArrowLeft')  audio.currentTime = Math.max((audio.currentTime||0) - 5, 0);
    if (e.code === 'ArrowUp')   { e.preventDefault(); vol.value = String(Math.min(vol.valueAsNumber + 5, 100)); vol.dispatchEvent(new Event('input')); }
    if (e.code === 'ArrowDown') { e.preventDefault(); vol.value = String(Math.max(vol.valueAsNumber - 5, 0));  vol.dispatchEvent(new Event('input')); }
  });

  // Audio events
  audio.addEventListener('loadedmetadata', () => { durEl.textContent = fmt(audio.duration); });
  audio.addEventListener('timeupdate', () => {
    curEl.textContent = fmt(audio.currentTime);
    const p = audio.duration ? Math.min(audio.currentTime / audio.duration, 1) : 0;
    bar.style.width = `${p * 100}%`;
    if ((Math.floor(audio.currentTime) % 2) === 0) {
      localStorage.setItem('plIndex', String(state.index));
      localStorage.setItem('plTime', String(Math.floor(audio.currentTime)));
    }
  });
  audio.addEventListener('ended', () => {
    if (state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(()=>{}); return; }
    const i = nextIndex();
    if (i !== state.index || state.repeat === 'all' || state.shuffle) playIndex(i, false);
  });
  audio.addEventListener('play', () => { btnPlay.textContent = '⏸️'; localStorage.setItem('bgmEnabled','1'); });
  audio.addEventListener('pause', () => { btnPlay.textContent = '▶️'; localStorage.setItem('bgmEnabled','0'); });
  audio.addEventListener('error', () => {
    console.warn('Ошибка аудио', audio.error);
    // Переходим к следующему треку, если текущий битый
    const i = nextIndex();
    if (i !== state.index) playIndex(i, false);
  });

  // Drawer
  listBtn?.addEventListener('click', () => drawer.classList.toggle('open'));
  closeBtn?.addEventListener('click', () => drawer.classList.remove('open'));

  function restoreLastAndMaybeAutoplay() {
    const savedIdx = parseInt(localStorage.getItem('plIndex') || '0', 10);
    if (!Number.isNaN(savedIdx) && savedIdx >= 0 && savedIdx < state.tracks.length) state.index = savedIdx;
    setSrc(); setTitle(); updateActiveInList();

    const savedTime = parseInt(localStorage.getItem('plTime') || '0', 10);
    if (!Number.isNaN(savedTime) && savedTime > 0) {
      audio.addEventListener('loadedmetadata', () => {
        if (savedTime < audio.duration - 1) audio.currentTime = savedTime;
      }, { once: true });
    }
    // Автозапуск, если ранее было включено
    if (localStorage.getItem('bgmEnabled') === '1') {
      audio.play().catch(()=>{ /* браузер может попросить клик */ });
    }
  }
  // Плавные переходы между страницами (Turbo Drive)
if (window.Turbo) {
  Turbo.setProgressBarDelay(100); // показывать бар, если загрузка >100мс

  document.addEventListener('turbo:before-render', (event) => {
    // Добавляем класс для анимации выхода старой страницы
    document.body.classList.add('page-exit');
    // Готовим новую страницу с анимацией входа
    const newBody = event.detail.newBody;
    newBody.classList.add('page-enter');

    // Останавливаем стандартный рендер, дождёмся конца анимации
    event.preventDefault();
    const onEnd = () => {
      document.body.removeEventListener('animationend', onEnd);
      event.detail.resume();                // продолжаем рендер
      requestAnimationFrame(() => {
        newBody.classList.remove('page-enter');
        newBody.classList.remove('page-exit');
      });
    };
    document.body.addEventListener('animationend', onEnd, { once: true });
  });

  document.addEventListener('turbo:render', () => {
    document.body.classList.remove('page-exit');
  });
}
// Modal open/close for Questions
(function modalForQuestions(){
  const modal = document.getElementById('q-modal');
  const frame = document.getElementById('q-modal-frame');
  if (!modal || !frame) return;

  const open = () => { modal.classList.add('open'); modal.removeAttribute('hidden'); document.body.classList.add('modal-open'); };
  const close = () => { modal.classList.remove('open'); document.body.classList.remove('modal-open'); frame.innerHTML = ''; modal.setAttribute('hidden',''); };

  // Открыть при клике по ссылке, таргетящей фрейм
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-turbo-frame="q-modal-frame"]');
    if (a) open();
  });

  // Повторно биндим close после каждой загрузки контента фрейма
  function bindCloses() {
    modal.querySelectorAll('.modal-close').forEach(btn => {
      btn.onclick = close;
    });
  }

  document.addEventListener('turbo:frame-load', (e) => {
    if (e.target && e.target.id === 'q-modal-frame') { open(); bindCloses(); }
  });

  modal.addEventListener('click', (e) => { if (e.target.classList?.contains('modal-backdrop')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  // Если используешь фолбэк загрузки через fetch — после подстановки HTML вызывай bindCloses()
})();
(function modalLoader(){
  const modal = document.getElementById('q-modal');
  const frame = document.getElementById('q-modal-frame');
  const closeBtn = document.getElementById('q-modal-close');
  if (!modal || !frame) return;

  const open = () => { modal.classList.add('open'); modal.removeAttribute('hidden'); document.body.classList.add('modal-open'); };
  const close = () => { modal.classList.remove('open'); document.body.classList.remove('modal-open'); frame.innerHTML = ''; modal.setAttribute('hidden',''); };

  async function loadIntoModal(url, { method='GET', body=null } = {}) {
    const headers = { 'Turbo-Frame': 'q-modal-frame', 'X-Requested-With': 'fetch' };
    // Если body — FormData, перекодируем в x-www-form-urlencoded (Express парсит это без multer)
    let fetchBody = body;
    if (body instanceof FormData) {
      const usp = new URLSearchParams();
      for (const [k, v] of body.entries()) usp.append(k, v);
      fetchBody = usp.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    const res = await fetch(url, { method, headers, body: fetchBody, credentials: 'same-origin' });
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const tf = doc.querySelector('turbo-frame#q-modal-frame');
    frame.innerHTML = tf ? tf.innerHTML : doc.body.innerHTML;
    open();
  }

  // Перехват кликов по дням
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[data-turbo-frame="q-modal-frame"]');
    if (!a) return;
    e.preventDefault(); // не даём перейти на отдельную страницу
    loadIntoModal(a.href);
  });

  // Перехват submit формы внутри модалки
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!frame.contains(form)) return;
    e.preventDefault();
    const fd = new FormData(form);
    fd.append('_frame', 'q-modal-frame');
    loadIntoModal(form.action, { method: (form.method || 'POST').toUpperCase(), body: fd });
  });

  // Закрытие
  closeBtn?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target.classList?.contains('modal-backdrop')) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();
  // ——— NAV: мобильное меню ———
  function initNav() {
    const toggle = document.getElementById('menuToggle');
    const menu = document.getElementById('navMenu');
    if (!toggle || !menu) return;
    const setOpen = (open) => {
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    toggle.addEventListener('click', () => setOpen(!menu.classList.contains('open')));
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });
    // закрывать меню после перехода
    menu.querySelectorAll('a,button').forEach(el => el.addEventListener('click', () => setOpen(false)));
  }

  // ——— Dynamic player height → CSS var ———
  function syncPlayerHeight() {
    const bar = document.getElementById('playerBar');
    if (!bar) return;
    const h = bar.offsetHeight || 84;
    document.documentElement.style.setProperty('--player-h', h + 'px');
  }

  // Инициализация на каждой загрузке представления (Turbo поддерживается)
  const perView = () => {
    // ваш существующий perView для Snow — оставьте как есть
    initNav();
    syncPlayerHeight();
    window.addEventListener('resize', syncPlayerHeight, { passive: true });
    window.addEventListener('orientationchange', syncPlayerHeight, { passive: true });
  };

  if (window.Turbo) {
    document.addEventListener('turbo:load', perView);
  } else {
    document.addEventListener('DOMContentLoaded', perView);
  }
  loadTracks();
  
});
(function enhanceBurger(){
  const run = () => {
    const toggle = document.getElementById('menuToggle');
    const menu = document.getElementById('navMenu');
    if (!toggle || !menu || toggle.dataset.enhanced === '1') return;
    toggle.dataset.enhanced = '1';
    toggle.setAttribute('aria-controls', 'navMenu');

    const focusablesSelector = 'a, button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
    const getFocusables = () =>
      Array.from(menu.querySelectorAll(focusablesSelector)).filter(el => !el.disabled && el.offsetParent !== null);

    const setOpen = (open) => {
      menu.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      document.body.classList.toggle('menu-open', open);
      if (open) {
        getFocusables()[0]?.focus();
      } else {
        toggle.focus();
      }
    };

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      setOpen(!menu.classList.contains('open'));
    });

    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && !toggle.contains(e.target)) setOpen(false);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') setOpen(false);
    });

    // trap focus внутри меню
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab' || !menu.classList.contains('open')) return;
      const f = getFocusables();
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
      else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
    });

    // закрывать меню после клика по ссылкам/кнопкам
    menu.querySelectorAll('a,button').forEach(el => el.addEventListener('click', () => setOpen(false)));
  };

  if (window.Turbo) document.addEventListener('turbo:load', run);
  document.addEventListener('DOMContentLoaded', run);
})();
// Countdown до 2025-01-07 00:00:00 локально
(function initCountdown(){
  const root = document.getElementById('countdown'); if (!root) return;
  const target = new Date(2025, 0, 7, 0, 0, 0).getTime();
  const el = {
    days: root.querySelector('[data-k="days"]'),
    hours: root.querySelector('[data-k="hours"]'),
    mins: root.querySelector('[data-k="mins"]'),
    secs: root.querySelector('[data-k="secs"]')
  };
  function tick(){
    const now = Date.now();
    let d = Math.max(0, Math.floor((target - now)/1000));
    const days = Math.floor(d/86400); d -= days*86400;
    const hours = Math.floor(d/3600); d -= hours*3600;
    const mins = Math.floor(d/60); d -= mins*60;
    const secs = d;
    if (el.days) el.days.textContent = String(days);
    if (el.hours) el.hours.textContent = String(hours).padStart(2,'0');
    if (el.mins) el.mins.textContent = String(mins).padStart(2,'0');
    if (el.secs) el.secs.textContent = String(secs).padStart(2,'0');
  }
  tick(); setInterval(tick, 1000);
})();



// Иконка снежинки: подменяем картинку по состоянию
(function snowIconSync(){
  const btn = document.getElementById('snowToggle');
  const icon = document.getElementById('snowflakeIcon'); // если хочешь использовать свою картинку
  if (!btn || !icon) return;
  const sync = () => {
    const on = localStorage.getItem('snowEnabled') === '1';
    icon.src = on ? '/images/snowflake-icon-active.png' : '/images/snowflake-icon-inactive.png';
  };
  sync();
  btn.addEventListener('click', () => setTimeout(sync, 0));
})();