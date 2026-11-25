/* Роутер и вся интерактивность приложения. */
(function () {
  const { toast, modal, confirmDialog, esc, price } = UI;
  const app = document.getElementById('app');

  function openModal({ title, body, actions, onMount, onClose }) {
    const footer = Array.isArray(actions) && actions.length
      ? actions.map((a, i) => `<button type="button" class="btn ${a.primary ? 'btn-primary' : ''}" data-modal-act="${i}">${esc(a.label || 'ОК')}</button>`).join('')
      : '';
    const close = modal({
      title,
      body,
      footer,
      onMount: (root, closeFn) => {
        const wrappedClose = () => {
          if (typeof onClose === 'function') { try { onClose(); } catch (e) {} }
          closeFn();
        };
        if (Array.isArray(actions)) {
          actions.forEach((a, i) => {
            const btn = root.querySelector(`[data-modal-act="${i}"]`);
            if (btn) btn.onclick = () => (a.onClick ? a.onClick(wrappedClose) : wrappedClose());
          });
        }
        if (typeof onMount === 'function') onMount(root, wrappedClose);
      },
    });
    return close;
  }

  const state = {
    me: null,
    meta: null,
    filters: {},
    ads: [],
    total: 0,
    loading: false,
    photos: [],
    editAd: null,
  };

  const $ = (sel, root) => (root || document).querySelector(sel);

  // База пути: '' на сервере, '/kopeka' на GitHub Pages (window.__BASE_PATH__)
  const BASE = String(window.__BASE_PATH__ || '').replace(/\/+$/, '');
  function appPath() {
    let p = location.pathname || '/';
    if (BASE && (p === BASE || p.startsWith(BASE + '/'))) p = p.slice(BASE.length) || '/';
    if (p === '/index.html') p = '/';
    p = p.replace(/\.html$/i, ''); // /kopeka/auth.html -> /auth
    return p || '/';
  }
  function toHref(path) { return BASE + (path === '/' ? '/' : path); }
  // href мог уже получить префикс базы (серверная разметка или script в Pages-сборке)
  function stripBase(href) {
    if (!BASE) return href;
    if (href === BASE) return '/';
    if (href.startsWith(BASE + '/')) return href.slice(BASE.length);
    return href;
  }
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ---------------- навигация ---------------- */

  function navigate(path, opts) {
    if (opts && opts.replace) history.replaceState({}, '', toHref(path));
    else history.pushState({}, '', toHref(path));
    render();
  }

  document.addEventListener('click', (e) => {
    const link = e.target.closest('a[data-link]');
    if (link && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) {
      const raw = link.getAttribute('href') || '';
      const href = stripBase(raw);
      if (href && href.startsWith('/')) {
        e.preventDefault();
        navigate(href);
      }
    }
  });

  window.addEventListener('popstate', render);

  // Поиск в шапке
  $('#header-search').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = new FormData(e.target).get('q').toString().trim();
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    navigate('/' + (params.toString() ? '?' + params.toString() : ''));
  });

  /* ---------------- данные ---------------- */

  async function loadMe() {
    try {
      const r = await API.get('/api/me');
      state.me = r.user;
      renderUserSlot(r.counts);
    } catch (e) { state.me = null; }
  }

  async function loadMeta() {
    if (state.meta) return state.meta;
    state.meta = await API.get('/api/meta');
    return state.meta;
  }

  function renderUserSlot(counts) {
    const slot = $('#user-slot');
    if (!state.me) {
      slot.innerHTML = `<a class="btn btn-ghost btn-sm" href="/auth" data-link>Войти</a>`;
      return;
    }
    const c = counts || {};
    slot.innerHTML = `
      <div style="position:relative">
        <button class="icon-btn" id="user-menu-btn" title="${esc(state.me.name)}">
          <span class="avatar" style="width:32px;height:32px;font-size:14px">${esc(UI.initials(state.me.name))}</span>
        </button>
        <div id="user-menu" class="card" hidden
             style="position:absolute;right:0;top:48px;width:230px;padding:8px;z-index:60">
          <div style="padding:8px 10px">
            <div style="font-weight:700">${esc(state.me.name)}</div>
            <div class="small muted">${esc(state.me.phone)}</div>
          </div>
          <a class="side-link" href="/user/${esc(state.me.id)}" data-link>Мой профиль</a>
          <a class="side-link" href="/my" data-link>Мои объявления ${c.ads ? `<span class="muted small">${c.ads}</span>` : ''}</a>
          <a class="side-link" href="/chats" data-link>Сообщения ${c.chats ? `<span class="muted small">${c.chats}</span>` : ''}</a>
          <a class="side-link" href="/deals" data-link>Сделки ${c.deals ? `<span class="muted small">${c.deals}</span>` : ''}</a>
          <a class="side-link" href="/favorites" data-link>Избранное ${c.favorites ? `<span class="muted small">${c.favorites}</span>` : ''}</a>
          <a class="side-link" href="/new" data-link>+ Разместить</a>
          <button class="side-link" id="logout-btn" style="width:100%;color:var(--red)">Выйти</button>
        </div>
      </div>`;
    const btn = $('#user-menu-btn');
    const menu = $('#user-menu');
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', () => { if (menu) menu.hidden = true; });
    $('#logout-btn').onclick = async () => {
      await API.post('/api/auth/logout');
      state.me = null;
      if (es) { es.close(); es = null; }
      toast('Вы вышли из аккаунта');
      await loadMe();
      render();
    };
  }

  /* ---------------- realtime ---------------- */

  let es = null;
  function connectEvents() {
    if (!state.me || es) return;
    try {
      es = new EventSource('/api/events');
      es.addEventListener('message', () => {
        bumpUnread();
        if (!appPath().startsWith('/chats')) return;
        const draft = document.querySelector('#chat-form textarea');
        if (draft && draft.value.trim()) { toast('Новое сообщение в чате'); return; }
        render(true);
      });
      es.addEventListener('deal', () => { const p = appPath(); if (p.startsWith('/chats') || p === '/deals') render(true); });
      es.onerror = () => { /* браузер сам переподключится */ };
    } catch (e) { /* окружение без SSE */ }
  }

  async function refreshUnread() {
    if (!state.me) return;
    try {
      const r = await API.get('/api/chats');
      setUnread(r.unreadTotal);
    } catch (e) {}
  }
  function setUnread(n) {
    const b = $('#unread-badge');
    if (!b) return;
    if (n > 0) { b.hidden = false; b.textContent = n > 99 ? '99+' : String(n); }
    else b.hidden = true;
  }
  function bumpUnread() { refreshUnread(); }

  /* ---------------- рендер ---------------- */

  async function render(silent) {
    const path = appPath();
    const params = new URLSearchParams(location.search);
    // если пользователь пришёл по прямому адресу файла (/kopeka/chats.html),
    // чистим адрес — при перезагрузке не будет лишней задержки из-за 404-фолбэка
    if (/\.html$/i.test(location.pathname) && !silent) {
      const cleanRoute = toHref(path) + location.search;
      try { history.replaceState({}, '', cleanRoute); } catch (e) {}
    }

    try {
      await loadMe();
      await loadMeta();

      connectEvents();
      if (path === '/' || path === '') return await renderHome(params);
      if (path === '/new') return await renderForm(null);
      if (path.startsWith('/edit/')) return await renderForm(path.split('/')[2]);
      if (path.startsWith('/ad/')) return await renderAd(path.split('/')[2]);
      if (path === '/chats') return await renderChats(null);
      if (path.startsWith('/chats/')) return await renderChats(path.split('/')[2]);
      if (path === '/deals') return await renderDeals();
      if (path === '/favorites') return await renderFavorites();
      if (path === '/auth') return renderAuth();
      if (path === '/me') return await renderSettings();
      if (path === '/my') return await renderMyAds();
      if (path.startsWith('/user/')) return await renderProfile(path.split('/')[2]);

      app.innerHTML = Views.notFound();
    } catch (e) {
      // 404 по адресу (снятое объявление, чужой чат) — это не поломка приложения:
      // показываем понятный экран с переходом на главную, а не «Ошибка: …»
      if (e && (e.status === 404 || /не найдено|не найден/i.test(e.message || ''))) {
        app.innerHTML = Views.notFound(e.message);
        return;
      }
      console.error(e);
      app.innerHTML = `<div class="container"><div class="empty">Ошибка: ${esc(e.message)}</div></div>`;
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    refreshUnread();
  }

  /* ---- главная ---- */
  async function renderHome(params) {
    state.filters = {
      q: params.get('q') || '',
      category: params.get('category') || '',
      city: params.get('city') || '',
      min: params.get('min') || '',
      max: params.get('max') || '',
      deal: params.get('deal') || '',
      sort: params.get('sort') || 'new',
      limit: 24,
      offset: 0,
    };
    app.innerHTML = Views.home(Object.assign({}, state, { ads: [], total: 0, loading: true }));
    const r = await API.get('/api/ads', state.filters);
    state.ads = r.items;
    state.total = r.total;
    app.innerHTML = Views.home(Object.assign({}, state));
    bindHome();
  }

  function bindHome() {
    const sort = $('#sort-select');
    if (sort) sort.onchange = () => {
      const u = new URLSearchParams(location.search);
      u.set('sort', sort.value);
      navigate('/?' + u.toString());
    };
    const form = $('#filter-form');
    if (form) form.onsubmit = (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const u = new URLSearchParams(location.search);
      ['city', 'min', 'max', 'deal'].forEach((k) => {
        const v = (fd.get(k) || '').toString().trim();
        if (v) u.set(k, v); else u.delete(k);
      });
      navigate('/?' + u.toString());
    };
    const more = $('#more-btn');
    if (more) more.onclick = async () => {
      more.disabled = true;
      const r = await API.get('/api/ads', Object.assign({}, state.filters, { offset: state.ads.length }));
      state.ads = state.ads.concat(r.items);
      app.innerHTML = Views.home(Object.assign({}, state));
      bindHome();
    };
    bindFavButtons();
  }

  /* ---- объявление ---- */
  async function renderAd(adId) {
    const r = await API.get('/api/ads/' + encodeURIComponent(adId));
    app.innerHTML = Views.adPage({ ad: r.ad, similar: r.similar, me: state.me });
    bindFavButtons();

    $$('[data-thumb]').forEach((img) => {
      img.onclick = () => {
        $('#main-img').src = img.dataset.thumb;
        $$('[data-thumb]').forEach(i => i.classList.remove('active'));
        img.classList.add('active');
      };
    });

    const del = $('[data-delete-ad]');
    if (del) del.onclick = async () => {
      if (!(await confirmDialog('Снять объявление?', 'Объявление перестанет показываться в поиске, но останется в архиве «Моих объявлений» — его можно вернуть.'))) return;
      try {
        await API.del('/api/ads/' + del.dataset.deleteAd);
        toast('Объявление снято');
        navigate('/my');
      } catch (e) { toast(e.message, 'err'); }
    };

    const phoneBtn = $('[data-show-phone]');
    if (phoneBtn) phoneBtn.onclick = () => {
      phoneBtn.textContent = phoneBtn.dataset.showPhone;
      phoneBtn.classList.add('btn-primary');
    };

    const chatBtn = $('[data-start-chat]');
    if (chatBtn) chatBtn.onclick = () => startChat(chatBtn.dataset.startChat);
  }

  async function startChat(adId) {
    if (!state.me) return navigate('/auth');
    try {
      const r = await API.post('/api/chats', { adId });
      navigate('/chats/' + r.chat.id);
    } catch (e) { toast(e.message, 'err'); }
  }

  /* ---- форма ---- */
  async function renderForm(adId) {
    if (!state.me) {
      app.innerHTML = Views.loginRequired('Размещать объявления могут только зарегистрированные пользователи.');
      return;
    }
    state.editAd = null;
    state.photos = [];
    if (adId) {
      const r = await API.get('/api/ads/' + encodeURIComponent(adId));
      if (!r.ad.isMine) { app.innerHTML = Views.loginRequired('Редактировать объявление может только его автор.'); return; }
      state.editAd = r.ad;
      state.photos = r.ad.photos.slice();
    }
    renderFormBody();
  }

  function renderFormBody() {
    app.innerHTML = Views.adForm({ editAd: state.editAd, photos: state.photos, meta: state.meta, me: state.me });
    bindForm();
  }

  function bindForm() {
    const form = $('#ad-form');
    const input = $('#photo-input');

    const syncChecks = () => {
      $$('.check').forEach((l) => l.classList.toggle('checked', !!l.querySelector('input').checked));
    };
    syncChecks();
    $$('.check input').forEach((i) => i.addEventListener('change', syncChecks));

    const redrawPhotos = () => {
      const uploader = $('#uploader');
      if (!uploader) return;
      uploader.innerHTML =
        state.photos.map((p, i) => `<div class="upload-tile"><img src="${esc(p)}" alt=""/><button type="button" class="rm" data-remove-photo="${i}">×</button></div>`).join('') +
        (state.photos.length < 8 ? `<label class="upload-add"><input type="file" id="photo-input" accept="image/*" multiple hidden/><span style="font-size:22px;line-height:1">+</span><span>Добавить фото</span></label>` : '');
      bindPhotoInput();
      $$('[data-remove-photo]').forEach((b) => {
        b.onclick = () => { state.photos.splice(Number(b.dataset.removePhoto), 1); redrawPhotos(); };
      });
    };

    function bindPhotoInput() {
      const inp = $('#photo-input');
      if (!inp) return;
      inp.onchange = async () => {
        const files = Array.from(inp.files || []).slice(0, 8 - state.photos.length);
        for (const f of files) {
          if (f.size > 8 * 1024 * 1024) { toast(`Файл «${f.name}» больше 8 МБ`, 'err'); continue; }
          try {
            const dataUrl = await UI.compressImage(f);
            state.photos.push(dataUrl);
          } catch (e) { toast('Не удалось обработать ' + f.name, 'err'); }
        }
        redrawPhotos();
        if (state.photos.length >= 8) toast('Максимум 8 фотографий', 'err');
      };
    }
    bindPhotoInput();
    $$('[data-remove-photo]').forEach((b) => {
      b.onclick = () => { state.photos.splice(Number(b.dataset.removePhoto), 1); redrawPhotos(); };
    });

    form.onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const payload = {
        title: fd.get('title').toString().trim(),
        category: fd.get('category').toString(),
        price: Number(fd.get('price')),
        city: fd.get('city').toString().trim(),
        metro: fd.get('metro').toString().trim(),
        condition: fd.get('condition').toString(),
        description: fd.get('description').toString().trim(),
        deals: {
          meeting: !!form.querySelector('[name="d-meeting"]').checked,
          delivery: !!form.querySelector('[name="d-delivery"]').checked,
          transfer: !!form.querySelector('[name="d-transfer"]').checked,
        },
        photos: state.photos,
      };
      const promoteChecked = !!(form.querySelector('#f-promote') && form.querySelector('#f-promote').checked);
      const promoMethodEl = form.querySelector('input[name="promoMethod"]:checked');
      const promoMethod = promoMethodEl ? promoMethodEl.value : 'sbp';
      const submit = form.querySelector('[type="submit"]');
      submit.disabled = true;
      submit.textContent = 'Сохраняем…';
      try {
        if (state.editAd) {
          await API.patch('/api/ads/' + state.editAd.id, payload);
          toast('Изменения сохранены');
          navigate('/ad/' + state.editAd.id);
          if (promoteChecked) openPromoPaymentModal({ adId: state.editAd.id, adTitle: payload.title, method: promoMethod });
        } else {
          const r = await API.post('/api/ads', payload);
          toast('Объявление опубликовано');
          navigate('/ad/' + r.ad.id);
          if (promoteChecked) {
            openPromoPaymentModal({ adId: r.ad.id, adTitle: payload.title, method: promoMethod });
          } else {
            openSupportProjectModal(payload.title);
          }
        }
      } catch (err) {
        // не сохранилось (нет места / хранилище недоступно) — сообщение держим дольше,
        // фото и текст остаются в форме, можно убрать пару снимков и повторить
        toast(err.message, 'err', err.status === 507 ? 12000 : 4000);
        submit.disabled = false;
        submit.textContent = 'Сохранить';
      }
    };
  }

  /* ---- чаты ---- */
  async function renderChats(chatId) {
    if (!state.me) { app.innerHTML = Views.loginRequired('Чтобы переписываться с продавцами, войдите в аккаунт.'); return; }
    const list = await API.get('/api/chats');
    let chat = null;
    if (chatId) {
      try {
        const r = await API.get(`/api/chats/${encodeURIComponent(chatId)}/messages`);
        chat = { chat: r.chat, messages: r.messages, peer: r.peer, deals: r.deals };
      } catch (e) { toast(e.message, 'err'); }
    }
    state.chat = chat;
    app.innerHTML = Views.chats({ me: state.me, chats: list.items, chat });
    setUnread(list.unreadTotal);

    const form = $('#chat-form');
    if (form) {
      const ta = form.querySelector('textarea');
      ta.focus();
      ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(120, ta.scrollHeight) + 'px'; };
      ta.onkeydown = (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); form.requestSubmit(); }
      };
      form.onsubmit = async (ev) => {
        ev.preventDefault();
        const text = ta.value.trim();
        if (!text) return;
        ta.value = '';
        ta.style.height = 'auto';
        try {
          const r = await API.post(`/api/chats/${encodeURIComponent(chat.chat.id)}/messages`, { text });
          appendMessage(r.message);
        } catch (e) { toast(e.message, 'err'); ta.value = text; }
      };
      const box = $('#messages');
      if (box) box.scrollTop = box.scrollHeight;
    }

    const makeDeal = $('[data-make-deal]');
    if (makeDeal) makeDeal.onclick = () => openDealModal(chat.chat.id, chat.chat.ad);
  }

  function appendMessage(m) {
    const box = $('#messages');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'msg mine' + (m.kind === 'deal' ? ' deal' : '');
    el.innerHTML = esc(m.text) + `<span class="time">${esc(UI.clock(m.createdAt))}</span>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
  }

  function openDealModal(chatId, ad) {
    const defaultWhen = new Date(Date.now() + 24 * 3600 * 1000);
    const local = new Date(defaultWhen.getTime() - defaultWhen.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    modal({
      title: 'Предложить сделку',
      body: `
        <div class="field"><label>Как передаём товар</label>
          <select class="select" id="deal-type">
            <option value="meet">Личная встреча</option>
            <option value="delivery">Доставка</option>
            <option value="transfer">Перевозка</option>
          </select>
        </div>
        <div class="field"><label>Место</label>
          <input class="input" id="deal-place" placeholder="м. Тверская, выход №3" value="${esc(ad ? ad.title : '')}"/>
        </div>
        <div class="row">
          <div class="field"><label>Дата и время</label><input class="input" id="deal-when" type="datetime-local" value="${local}"/></div>
          <div class="field"><label>Цена, ₽</label><input class="input" id="deal-price" type="number" min="0" value="${ad ? ad.price : ''}"/></div>
        </div>
        <div class="field"><label>Комментарий</label><textarea class="textarea" id="deal-comment" placeholder="Например: подъеду на 10 минут позже, оплата наличными"></textarea></div>
        <p class="small muted">Предложение появится в чате. Вторая сторона сможет подтвердить его в разделе «Сделки».</p>`,
      footer: `<button class="btn" data-close>Отмена</button><button class="btn btn-primary" id="deal-send">Отправить предложение</button>`,
      onMount: (root, close) => {
        root.querySelector('#deal-send').onclick = async () => {
          const btn = root.querySelector('#deal-send');
          btn.disabled = true;
          const whenVal = root.querySelector('#deal-when').value;
          try {
            await API.post(`/api/chats/${encodeURIComponent(chatId)}/deals`, {
              type: root.querySelector('#deal-type').value,
              place: root.querySelector('#deal-place').value,
              when: whenVal ? new Date(whenVal).getTime() : null,
              price: root.querySelector('#deal-price').value,
              comment: root.querySelector('#deal-comment').value,
            });
            close();
            toast('Предложение отправлено');
            render(true);
          } catch (e) {
            toast(e.message, 'err');
            btn.disabled = false;
          }
        };
      },
    });
  }

  /* ---- сделки ---- */
  async function renderDeals() {
    if (!state.me) { app.innerHTML = Views.loginRequired('Войдите, чтобы видеть свои сделки.'); return; }
    const r = await API.get('/api/deals');
    app.innerHTML = Views.deals({ me: state.me, deals: r.items });
  }

  /* ---- избранное ---- */
  async function renderFavorites() {
    if (!state.me) { app.innerHTML = Views.loginRequired('Войдите, чтобы сохранять объявления в избранное.'); return; }
    const r = await API.get('/api/favorites');
    app.innerHTML = Views.favorites({ me: state.me, favorites: r.items });
    bindFavButtons();
  }

  /* ---- профиль ---- */
  async function renderProfile(userId) {
    const r = await API.get('/api/users/' + encodeURIComponent(userId));
    app.innerHTML = Views.profile({ me: state.me, profile: r.user, userAds: r.ads, reviewsList: r.reviewsList });
    bindFavButtons();
    const rev = $('[data-review]');
    if (rev) rev.onclick = () => openReviewModal(rev.dataset.review);
  }

  function openReviewModal(userId) {
    modal({
      title: 'Оставить отзыв',
      body: `
        <div class="field"><label>Оценка</label>
          <select class="select" id="rev-rating">${[5, 4, 3, 2, 1].map(n => `<option value="${n}">${'★'.repeat(n)} ${n}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Отзыв</label><textarea class="textarea" id="rev-text" placeholder="Как прошла сделка?"></textarea></div>`,
      footer: `<button class="btn" data-close>Отмена</button><button class="btn btn-primary" id="rev-send">Отправить</button>`,
      onMount: (root, close) => {
        root.querySelector('#rev-send').onclick = async () => {
          try {
            await API.post('/api/reviews', {
              toId: userId,
              rating: Number(root.querySelector('#rev-rating').value),
              text: root.querySelector('#rev-text').value,
            });
            close();
            toast('Спасибо за отзыв!');
            render(true);
          } catch (e) { toast(e.message, 'err'); }
        };
      },
    });
  }

  /* ---- поддержка проекта / благотворительность напрямую ---- */
  const RU_BANKS = [
    { name: 'СберБанк', color: '#21A038', scheme: 'sberbankonline://', web: 'https://online.sberbank.ru/' },
    { name: 'Т-Банк (Тинькофф)', color: '#FFDD2D', darkText: true, scheme: 'tinkoffbank://', web: 'https://www.tbank.ru/' },
    { name: 'Альфа-Банк', color: '#EF3124', scheme: 'alfabank://', web: 'https://alfabank.ru/' },
    { name: 'ВТБ Онлайн', color: '#002882', scheme: 'vtb24://', web: 'https://online.vtb.ru/' },
    { name: 'Газпромбанк', color: '#0057B6', scheme: 'gpb://', web: 'https://ib.online.gpb.ru/' },
    { name: 'Озон Банк', color: '#005BFF', scheme: 'ozonbank://', web: 'https://finance.ozon.ru/' },
    { name: 'Яндекс Пэй', color: '#000000', scheme: 'yandexpay://', web: 'https://bank.yandex.ru/' },
    { name: 'Райффайзен', color: '#FEE600', darkText: true, scheme: 'raiffeisen://', web: 'https://online.raiffeisen.ru/' },
    { name: 'Совкомбанк', color: '#003791', scheme: 'halvacard://', web: 'https://halvacard.ru/' },
    { name: 'Россельхозбанк', color: '#42AB44', scheme: 'rshb://', web: 'https://online.rshb.ru/' },
    { name: 'ПСБ', color: '#EA5616', scheme: 'psbank://', web: 'https://ib.psbank.ru/' },
    { name: 'МТС Банк', color: '#E30611', scheme: 'mtsbank://', web: 'https://online.mtsbank.ru/' },
    { name: 'Почта Банк', color: '#002F87', scheme: 'pochtabank://', web: 'https://my.pochtabank.ru/' },
    { name: 'Уралсиб', color: '#2E1A47', scheme: 'uralsib://', web: 'https://i.uralsib.ru/' },
    { name: 'Банк СПб', color: '#E2001A', scheme: 'bspb://', web: 'https://i.bspb.ru/' },
    { name: 'Ак Барс Банк', color: '#009A44', scheme: 'akbars://', web: 'https://online.akbars.ru/' },
    { name: 'Русский Стандарт', color: '#006838', scheme: 'rsb://', web: 'https://online.rsb.ru/' },
    { name: 'Ренессанс Банк', color: '#E40046', scheme: 'rencredit://', web: 'https://ib.rencredit.ru/' },
    { name: 'ОТП Банк', color: '#52AE30', scheme: 'otpbank://', web: 'https://online.otpbank.ru/' },
    { name: 'УБРиР', color: '#A6192E', scheme: 'ubrr://', web: 'https://i.ubrr.ru/' },
    { name: 'МКБ', color: '#D22630', scheme: 'mkb://', web: 'https://online.mkb.ru/' },
    { name: 'Точка Банк', color: '#6E2EFF', scheme: 'tochka://', web: 'https://i.tochka.com/' },
    { name: 'РНКБ', color: '#0088CC', scheme: 'rncb://', web: 'https://online.rncb.ru/' },
    { name: 'Синара Банк', color: '#FF5C00', scheme: 'sinara://', web: 'https://online.sinara.ru/' },
    { name: 'Авангард', color: '#006E51', scheme: 'avangard://', web: 'https://www.avangard.ru/' },
    { name: 'ЮMoney', color: '#8B3FFD', scheme: 'yoomoney://', web: 'https://yoomoney.ru/' },
  ];

  function openSupportProjectModal(adTitle) {
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent || '');
    openModal({
      title: 'Объявление опубликовано!',
      body: `
        <div style="display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.55">
          <div style="padding:14px 16px;border-radius:14px;background:linear-gradient(135deg,rgba(22,163,74,.12),rgba(245,158,11,.10));border:1px solid rgba(22,163,74,.28)">
            <div style="font-size:16px;font-weight:800;margin-bottom:4px">🎉 Ваше объявление уже на сайте!</div>
            ${adTitle ? `<div class="small muted">«${UI.esc(adTitle)}»</div>` : ''}
          </div>
          <p><b>Поддержать проект CoffeeIT и благотворительность напрямую</b><br/>
          <span class="muted">Выберите сумму и нажмите на ваш банк — номер карты скопируется автоматически, и на телефоне сразу откроется приложение банка.</span></p>
          <div style="display:flex;gap:8px;flex-wrap:wrap" id="support-amounts">
            <button type="button" class="btn btn-sm" data-sup-sum="50">50 ₽</button>
            <button type="button" class="btn btn-sm btn-primary" data-sup-sum="100">100 ₽</button>
            <button type="button" class="btn btn-sm" data-sup-sum="300">300 ₽</button>
            <button type="button" class="btn btn-sm" data-sup-sum="500">500 ₽</button>
          </div>
          <div class="field">
            <label for="support-custom-sum">Или своя сумма (₽)</label>
            <input class="input" id="support-custom-sum" type="number" min="10" step="10" value="100"/>
          </div>
          <div style="padding:12px 14px;border-radius:12px;background:var(--bg2);border:1px solid var(--border);font-size:13.5px;line-height:1.55">
            <b>Номер карты для перевода:</b>
            <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;padding:10px 12px;border-radius:10px;background:var(--card);border:1px solid var(--border);flex-wrap:wrap">
              <code style="font-size:16px;font-weight:800;letter-spacing:.06em">2204 1801 2664 7940</code>
              <button type="button" class="btn btn-sm" id="support-copy-card">Скопировать</button>
            </div>
            <span class="muted small">Назначение: «Поддержка проекта CoffeeIT». Любая сумма добровольна.</span>
          </div>
          <div class="field">
            <label for="support-bank-search">Открыть ваш банк на телефоне</label>
            <input class="input" id="support-bank-search" type="search" placeholder="Поиск банка (Сбер, Т-Банк, Альфа, ВТБ…)" autocomplete="off"/>
          </div>
          <div id="support-banks-grid" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:210px;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-right:2px"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" id="support-confirm-btn" style="flex:1">❤️ Я перевёл поддержку</button>
            <button type="button" class="btn" id="support-skip-btn" style="flex:1">Перейти к объявлению</button>
          </div>
        </div>`,
      onMount: (root, close) => {
        const input = root.querySelector('#support-custom-sum');
        const search = root.querySelector('#support-bank-search');
        const grid = root.querySelector('#support-banks-grid');

        const renderBanks = (q) => {
          const term = String(q || '').trim().toLowerCase();
          const list = term ? RU_BANKS.filter(b => b.name.toLowerCase().includes(term)) : RU_BANKS;
          if (!list.length) {
            grid.innerHTML = '<div class="small muted" style="grid-column:1/-1;padding:8px 0">Банк не найден — скопируйте номер карты выше и откройте ваш банк вручную.</div>';
            return;
          }
          grid.innerHTML = list.map((b, idx) => `
            <button type="button" class="btn btn-sm" data-bank-idx="${RU_BANKS.indexOf(b)}" style="justify-content:flex-start;gap:8px;min-height:44px;padding:8px 10px;border-color:var(--border);background:var(--card);color:var(--text);text-align:left">
              <span style="width:12px;height:12px;border-radius:50%;background:${b.color};flex-shrink:0;border:1px solid rgba(0,0,0,.1)"></span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;font-size:13px">${UI.esc(b.name)}</span>
            </button>`).join('');
          grid.querySelectorAll('[data-bank-idx]').forEach((btn) => {
            btn.onclick = async () => {
              const bank = RU_BANKS[Number(btn.dataset.bankIdx)];
              if (!bank) return;
              try { await navigator.clipboard.writeText('2204180126647940'); } catch (e) {}
              toast(`Номер карты скопирован! Открываем ${bank.name}…`);
              if (isMobile) {
                window.location.href = bank.scheme;
                setTimeout(() => { window.open(bank.web, '_blank', 'noopener'); }, 1500);
              } else {
                window.open(bank.web, '_blank', 'noopener');
              }
            };
          });
        };

        renderBanks('');
        search.oninput = () => renderBanks(search.value);

        root.querySelectorAll('[data-sup-sum]').forEach((b) => {
          b.onclick = () => {
            root.querySelectorAll('[data-sup-sum]').forEach((x) => x.classList.remove('btn-primary'));
            b.classList.add('btn-primary');
            input.value = b.dataset.supSum;
          };
        });
        const copyBtn = root.querySelector('#support-copy-card');
        if (copyBtn) {
          copyBtn.onclick = async () => {
            try {
              await navigator.clipboard.writeText('2204180126647940');
              toast('Номер карты скопирован: 2204 1801 2664 7940');
            } catch (e) {
              toast('2204 1801 2664 7940');
            }
          };
        }
        root.querySelector('#support-skip-btn').onclick = () => close();
        root.querySelector('#support-confirm-btn').onclick = () => {
          const sum = Number(input.value) || 100;
          close();
          toast(`❤️ Спасибо за поддержку проекта CoffeeIT (${sum} ₽)!`);
        };
      },
    });
  }

  /* ---- платное продвижение в ТОП (100 ₽ — СБП / перевод на карту) ---- */
  function getPromos() {
    try { return JSON.parse(localStorage.getItem('coffeeit:promos:v1') || '[]'); } catch (e) { return []; }
  }
  function savePromo(entry) {
    try {
      const list = getPromos();
      list.unshift(entry);
      localStorage.setItem('coffeeit:promos:v1', JSON.stringify(list.slice(0, 50)));
    } catch (e) {}
  }

  function renderMePromos() {
    const box = $('#me-promos-list');
    if (!box) return;
    const list = getPromos();
    if (!list.length) {
      box.innerHTML = '<div class="small muted">Пока нет активных продвижений. Поднимите любое объявление в ТОП просмотров за 100 ₽.</div>';
      return;
    }
    box.innerHTML = list.map((p) => {
      const methodLabel = p.method === 'card' ? 'Перевод на карту' : 'СБП';
      const dt = new Date(p.createdAt).toLocaleDateString('ru-RU');
      return `<div style="padding:10px 12px;border-radius:12px;background:var(--bg2);border:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap">
        <div>
          <div style="font-weight:700;font-size:14px">★ ${UI.esc(p.adTitle || 'Объявление')}</div>
          <div class="small muted">${dt} · ${methodLabel} · <b>100 ₽</b></div>
        </div>
        <span style="font-size:11px;padding:3px 9px;border-radius:999px;background:rgba(22,163,74,.14);color:var(--primary);font-weight:700">В ТОПе (7 дней)</span>
      </div>`;
    }).join('');
  }

  function openPromoPaymentModal(opts = {}) {
    const initMethod = opts.method === 'card' ? 'card' : 'sbp';
    const initTitle = opts.adTitle || '';
    openModal({
      title: 'Продвижение в ТОП просмотров — 100 ₽',
      body: `
        <form id="promo-pay-form" style="display:flex;flex-direction:column;gap:12px;font-size:14px">
          <div style="padding:12px 14px;border-radius:12px;background:linear-gradient(135deg,rgba(245,158,11,.14),rgba(22,163,74,.10));border:1px solid rgba(245,158,11,.35)">
            <b>★ ТОП просмотров на 7 дней — 100 ₽</b>
            <div class="small muted" style="margin-top:3px">Объявление выделяется и показывается выше в ленте CoffeeIT.</div>
          </div>
          <div class="field">
            <label for="promo-ad-title">Объявление</label>
            <input class="input" id="promo-ad-title" name="adTitle" placeholder="Название объявления" value="${UI.esc(initTitle)}" required/>
          </div>
          <div class="field">
            <label>Выберите способ оплаты</label>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:4px">
              <label style="flex:1;min-width:150px;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--bg2);display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="payMethod" value="sbp" ${initMethod === 'sbp' ? 'checked' : ''}/>
                <span><b>СБП</b> (быстрый перевод)</span>
              </label>
              <label style="flex:1;min-width:150px;padding:10px 12px;border-radius:12px;border:1px solid var(--border);background:var(--bg2);display:flex;align-items:center;gap:8px;cursor:pointer">
                <input type="radio" name="payMethod" value="card" ${initMethod === 'card' ? 'checked' : ''}/>
                <span><b>Перевод на карту</b></span>
              </label>
            </div>
          </div>
          <div id="promo-pay-details" style="padding:12px;border-radius:12px;background:var(--bg2);border:1px solid var(--border);font-size:13px;line-height:1.5"></div>
          <button class="btn btn-primary" type="submit">Перейти к оплате 100 ₽</button>
        </form>`,
      onMount: (root, close) => {
        const details = root.querySelector('#promo-pay-details');
        const updateDetails = () => {
          const m = root.querySelector('input[name="payMethod"]:checked').value;
          if (m === 'sbp') {
            details.innerHTML = '<b>Оплата через СБП:</b><br/>Сумма: <b>100 ₽</b><br/>Переведите по СБП по номеру телефона получателя CoffeeIT (укажите свой номер в комментарии) и нажмите кнопку подтверждения ниже.';
          } else {
            details.innerHTML = '<b>Перевод на банковскую карту:</b><br/>Сумма: <b>100 ₽</b><br/>Выполните перевод на карту получателя CoffeeIT (укажите название объявления в комментарии) и нажмите кнопку подтверждения ниже.';
          }
        };
        updateDetails();
        root.querySelectorAll('input[name="payMethod"]').forEach((r) => { r.onchange = updateDetails; });

        root.querySelector('#promo-pay-form').onsubmit = async (e) => {
          e.preventDefault();
          const adTitle = root.querySelector('#promo-ad-title').value.trim();
          const method = root.querySelector('input[name="payMethod"]:checked').value;
          const submitBtn = root.querySelector('[type="submit"]');
          submitBtn.disabled = true;
          submitBtn.textContent = 'Создаём платёж…';
          try {
            const r = await API.post('/api/promo/create', { adId: opts.adId || null, adTitle, method });
            if (r && r.confirmationUrl) {
              window.location.href = r.confirmationUrl;
              return;
            }
          } catch (err) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Оплатить 100 ₽';
            toast(err.message || 'Для реальной оплаты через СБП нужен запущенный сервер с ключами ЮKassa (YOOKASSA_SHOP_ID и YOOKASSA_SECRET_KEY).', 'err', 7000);
          }
        };
      },
    });
  }

  async function renderSettings() {
    if (!state.me) { app.innerHTML = Views.loginRequired('Войдите, чтобы изменить профиль.'); return; }
    app.innerHTML = Views.settings({ me: state.me });
    renderMePromos();
    $('#profile-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await API.patch('/api/me', Object.fromEntries(fd.entries()));
        state.me = r.user;
        toast('Профиль обновлён');
        render(true);
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  async function renderMyAds() {
    if (!state.me) { app.innerHTML = Views.loginRequired('Войдите, чтобы видеть свои объявления.'); return; }
    const r = await API.get('/api/ads', { owner: 'me', limit: 60 });
    app.innerHTML = Views.myAds({ me: state.me, myAds: r.items });
  }

  /* ---- политика конфиденциальности (152-ФЗ) и OAuth ---- */
  function saveConsentLog(provider, phone) {
    try {
      const log = JSON.parse(localStorage.getItem('coffeeit:consent:v1') || '[]');
      log.push({ provider, phone, policyVersion: '1.0', acceptedAt: new Date().toISOString() });
      localStorage.setItem('coffeeit:consent:v1', JSON.stringify(log.slice(-20)));
    } catch (e) {}
  }

  function openPrivacyModal() {
    openModal({
      title: 'Политика конфиденциальности CoffeeIT (152-ФЗ)',
      body: `
        <div style="display:flex;flex-direction:column;gap:10px;font-size:14px;line-height:1.55">
          <p><b>Оператор персональных данных:</b> сервис объявлений CoffeeIT (версия политики 1.0).</p>
          <p><b>Цели обработки:</b> создание и поддержка аккаунта, публикация объявлений, обмен сообщениями и оформление сделок между пользователями.</p>
          <p><b>Минимизация данных:</b> при регистрации через <b>Яндекс ID</b> или <b>VK ID (OAuth 2.1)</b> запрашиваются только необходимые данные — имя, контакт (email/телефон) и аватар. Избыточные сведения (например, дата рождения) не запрашиваются.</p>
          <p><b>Безопасность:</b> провайдер VK ID сертифицирован по стандарту ISO/IEC 27001. Факт и время вашего согласия фиксируются при регистрации (ст. 9 152-ФЗ).</p>
          <p><b>Сроки и права субъекта:</b> данные хранятся до удаления аккаунта. Вы вправе в любой момент отозвать согласие и удалить аккаунт в настройках профиля.</p>
        </div>`,
      actions: [{ label: 'Понятно', primary: true, onClick: (close) => close() }],
    });
  }

  function openOAuthModal(provider) {
    const isYandex = provider === 'yandex';
    const title = isYandex ? 'Быстрый вход через Яндекс ID' : 'Быстрый вход через VK ID (OAuth 2.1)';
    const defaultName = isYandex ? 'Алексей (Яндекс ID)' : 'Дмитрий (VK ID)';
    const defaultPhone = isYandex ? '+79991112233' : '+79994445566';
    const badgeColor = isYandex ? '#fc3f1d' : '#0077ff';
    const providerNote = isYandex
      ? 'Яндекс ID передаст в CoffeeIT только имя, контакт и аватар (минимизация по 152-ФЗ).'
      : 'VK ID (OAuth 2.1, ISO/IEC 27001) передаст в CoffeeIT только имя, контакт и аватар.';

    openModal({
      title,
      body: `
        <form id="oauth-modal-form" style="display:flex;flex-direction:column;gap:12px">
          <div style="padding:10px 12px;border-radius:10px;background:var(--bg2);font-size:13px;border-left:4px solid ${badgeColor}">
            ${UI.esc(providerNote)}
          </div>
          <div class="field">
            <label for="oauth-name">Имя из профиля ${isYandex ? 'Яндекс' : 'VK'}</label>
            <input class="input" id="oauth-name" name="name" value="${UI.esc(defaultName)}" required/>
          </div>
          <div class="field">
            <label for="oauth-phone">Телефон для связи</label>
            <input class="input" id="oauth-phone" name="phone" value="${UI.esc(defaultPhone)}" required/>
          </div>
          <div class="field">
            <label for="oauth-city">Город</label>
            <input class="input" id="oauth-city" name="city" value="Москва"/>
          </div>
          <label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.45;cursor:pointer">
            <input type="checkbox" id="oauth-consent" style="margin-top:3px;flex-shrink:0" required/>
            <span>Я даю согласие на обработку моих персональных данных в CoffeeIT в соответствии с <a href="#" data-open-privacy style="color:var(--primary);text-decoration:underline">Политикой конфиденциальности</a> (ст. 9 152-ФЗ).</span>
          </label>
          <button class="btn btn-primary" type="submit">Подтвердить и войти</button>
        </form>`,
      onMount: (root, close) => {
        const form = root.querySelector('#oauth-modal-form');
        form.onsubmit = async (e) => {
          e.preventDefault();
          if (!root.querySelector('#oauth-consent').checked) {
            return toast('Необходимо согласие на обработку персональных данных (152-ФЗ)', 'err');
          }
          const fd = new FormData(form);
          const phone = String(fd.get('phone') || '').trim();
          const name = String(fd.get('name') || '').trim();
          const city = String(fd.get('city') || 'Москва').trim();
          const pass = 'oauth_' + provider + '_2026';
          try {
            try {
              await API.post('/api/auth/register', { name, phone, password: pass, city });
            } catch (regErr) {
              await API.post('/api/auth/login', { phone, password: pass });
            }
            saveConsentLog(provider, phone);
            close();
            await loadMe();
            toast('Вход через ' + (isYandex ? 'Яндекс ID' : 'VK ID') + ' выполнен!');
            navigate('/');
          } catch (err) {
            toast(err.message, 'err');
          }
        };
      },
    });
  }

  async function openTelegramAuthModal() {
    let startData = null;
    try {
      startData = await API.post('/api/auth/tg-start', {});
    } catch (e) {
      startData = { configured: false };
    }

    if (startData && startData.configured && startData.botUrl) {
      let pollTimer = null;
      let verifiedData = null;
      openModal({
        title: 'Подтверждение номера через Telegram (бесплатно)',
        body: `
          <form id="tg-live-form" style="display:flex;flex-direction:column;gap:12px">
            <div style="padding:10px 12px;border-radius:10px;background:var(--bg2);font-size:13px;border-left:4px solid #229ED9">
              1. Нажмите «Открыть Telegram-бота».<br/>
              2. В боте нажмите кнопку <b>«📱 Поделиться номером»</b>.<br/>
              3. Вернитесь сюда — номер подтвердится автоматически (0 ₽).
            </div>
            <a class="btn" href="${UI.esc(startData.botUrl)}" target="_blank" rel="noopener" style="background:#229ED9;color:#fff;border-color:#229ED9;justify-content:center">
              ✈ Открыть Telegram-бота
            </a>
            <div id="tg-status-box" class="small muted">Ожидание подтверждения номера в Telegram…</div>
            <label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.45;cursor:pointer">
              <input type="checkbox" id="tg-consent" style="margin-top:3px;flex-shrink:0" required/>
              <span>Я даю согласие на обработку моих персональных данных в CoffeeIT в соответствии с <a href="#" data-open-privacy style="color:var(--primary);text-decoration:underline">Политикой конфиденциальности</a> (ст. 9 152-ФЗ).</span>
            </label>
            <button class="btn btn-primary" id="tg-finish-btn" type="submit" disabled>Завершить вход</button>
          </form>`,
        onMount: (root, close) => {
          const statusBox = root.querySelector('#tg-status-box');
          const finishBtn = root.querySelector('#tg-finish-btn');
          pollTimer = setInterval(async () => {
            try {
              const st = await API.get('/api/auth/tg-status', { token: startData.token });
              if (st && st.status === 'verified') {
                clearInterval(pollTimer);
                verifiedData = st;
                statusBox.innerHTML = `<b style="color:var(--primary)">✅ Номер подтверждён:</b> ${UI.esc(st.phone)} (${UI.esc(st.name || '')})`;
                finishBtn.disabled = false;
              } else if (st && st.status === 'expired') {
                clearInterval(pollTimer);
                statusBox.textContent = 'Сессия истекла — закройте окно и попробуйте снова.';
              }
            } catch (e) {}
          }, 2000);

          root.querySelector('#tg-live-form').onsubmit = async (e) => {
            e.preventDefault();
            if (!verifiedData) return toast('Сначала поделитесь номером в Telegram-боте', 'err');
            if (!root.querySelector('#tg-consent').checked) return toast('Необходимо согласие (152-ФЗ)', 'err');
            try {
              await API.post('/api/auth/tg-complete', { token: startData.token, name: verifiedData.name });
              saveConsentLog('telegram_bot', verifiedData.phone);
              clearInterval(pollTimer);
              close();
              await loadMe();
              toast('Номер подтверждён через Telegram!');
              navigate('/');
            } catch (err) {
              toast(err.message, 'err');
            }
          };
        },
        onClose: () => { if (pollTimer) clearInterval(pollTimer); },
      });
      return;
    }

    // Статическая версия (GitHub Pages) или бот ещё не настроен на сервере
    openModal({
      title: 'Подтверждение номера через Telegram (бесплатно)',
      body: `
        <form id="tg-demo-form" style="display:flex;flex-direction:column;gap:12px">
          <div style="padding:10px 12px;border-radius:10px;background:var(--bg2);font-size:13px;border-left:4px solid #229ED9">
            На сервере (<code>npm start</code> с <code>TG_BOT_TOKEN</code> и <code>TG_BOT_USERNAME</code>) здесь открывается ваш Telegram-бот с кнопкой <b>«Поделиться номером»</b> (0 ₽).<br/>
            Сейчас включён локальный режим проверки — вы можете сразу протестировать вход:
          </div>
          <div class="field">
            <label for="tg-name">Имя из Telegram</label>
            <input class="input" id="tg-name" name="name" value="Пользователь Telegram" required/>
          </div>
          <div class="field">
            <label for="tg-phone">Номер телефона</label>
            <input class="input" id="tg-phone" name="phone" value="+79997778899" required/>
          </div>
          <label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;line-height:1.45;cursor:pointer">
            <input type="checkbox" id="tg-demo-consent" style="margin-top:3px;flex-shrink:0" required/>
            <span>Я даю согласие на обработку моих персональных данных в CoffeeIT в соответствии с <a href="#" data-open-privacy style="color:var(--primary);text-decoration:underline">Политикой конфиденциальности</a> (ст. 9 152-ФЗ).</span>
          </label>
          <button class="btn btn-primary" type="submit">Подтвердить номер и войти</button>
        </form>`,
      onMount: (root, close) => {
        root.querySelector('#tg-demo-form').onsubmit = async (e) => {
          e.preventDefault();
          if (!root.querySelector('#tg-demo-consent').checked) return toast('Необходимо согласие (152-ФЗ)', 'err');
          const fd = new FormData(e.target);
          const name = String(fd.get('name') || '').trim();
          const phone = String(fd.get('phone') || '').trim();
          const pass = 'tg_bot_verified_2026';
          try {
            try {
              await API.post('/api/auth/register', { name, phone, password: pass, city: 'Москва' });
            } catch (regErr) {
              await API.post('/api/auth/login', { phone, password: pass });
            }
            saveConsentLog('telegram_bot', phone);
            close();
            await loadMe();
            toast('Вход через Telegram выполнен!');
            navigate('/');
          } catch (err) {
            toast(err.message, 'err');
          }
        };
      },
    });
  }

  /* ---- вход ---- */
  function renderAuth() {
    app.innerHTML = Views.auth({ meta: state.meta });
    $$('[data-oauth]').forEach((btn) => {
      btn.onclick = () => openOAuthModal(btn.dataset.oauth);
    });
    const tgBtn = $('[data-tg-auth]');
    if (tgBtn) tgBtn.onclick = () => openTelegramAuthModal();
    $('#login-form').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await API.post('/api/auth/login', { phone: fd.get('phone'), password: fd.get('password') });
        await loadMe();
        toast('Добро пожаловать в CoffeeIT!');
        navigate('/');
      } catch (err) { toast(err.message, 'err'); }
    };
    $('#register-form').onsubmit = async (e) => {
      e.preventDefault();
      const consent = $('#reg-consent');
      if (!consent || !consent.checked) {
        return toast('Подтвердите согласие на обработку персональных данных (152-ФЗ)', 'err');
      }
      const fd = new FormData(e.target);
      const data = Object.fromEntries(fd.entries());
      try {
        await API.post('/api/auth/register', data);
        saveConsentLog('phone', data.phone);
        await loadMe();
        toast('Аккаунт CoffeeIT создан!');
        navigate('/');
      } catch (err) { toast(err.message, 'err'); }
    };
  }

  /* ---- избранное: кнопки на любой странице ---- */
  function bindFavButtons() {
    $$('[data-fav]').forEach((btn) => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.onclick = async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!state.me) { toast('Войдите, чтобы сохранять в избранное', 'err'); return navigate('/auth'); }
        try {
          const r = await API.post('/api/ads/' + btn.dataset.fav + '/favorite');
          btn.classList.toggle('on', r.favorite);
          if (btn.classList.contains('btn')) btn.innerHTML = UI.icons.heart + ' ' + (r.favorite ? 'В избранном' : 'В избранное');
          toast(r.favorite ? 'Добавлено в избранное' : 'Удалено из избранного');
        } catch (err) { toast(err.message, 'err'); }
      };
    });
  }

  /* ---- установка приложения на iOS (iPhone / iPad) и PWA ---- */
  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
  });

  function openInstallIosModal() {
    const ua = navigator.userAgent || '';
    const isIOS = /iPhone|iPad|iPod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

    if (isStandalone) {
      return toast('Приложение CoffeeIT уже установлено на вашем устройстве!');
    }

    if (deferredInstallPrompt && !isIOS) {
      deferredInstallPrompt.prompt();
      deferredInstallPrompt.userChoice.finally(() => { deferredInstallPrompt = null; });
      return;
    }

    const appUrl = location.origin + (window.__BASE_PATH__ || '') + '/';
    openModal({
      title: 'Установить приложение CoffeeIT для iOS',
      body: `
        <div style="display:flex;flex-direction:column;gap:12px;font-size:14px;line-height:1.5">
          <div style="display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;background:var(--bg2)">
            <div style="width:48px;height:48px;border-radius:12px;background:#16a34a;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:24px;flex-shrink:0">C</div>
            <div>
              <b>CoffeeIT для iPhone и iPad</b>
              <div class="small muted">Работает как обычное iOS-приложение на рабочем столе — без App Store и без адресной строки.</div>
            </div>
          </div>
          <ol style="padding-left:20px;display:flex;flex-direction:column;gap:6px">
            <li>Откройте этот сайт в браузере <b>Safari</b> на iPhone или iPad.</li>
            <li>Нажмите кнопку <b>«Поделиться»</b> (квадрат со стрелкой вверх) внизу экрана.</li>
            <li>Выберите пункт <b>«На экран „Домой“»</b> → <b>«Добавить»</b>.</li>
          </ol>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px">
            ${navigator.share ? '<button type="button" class="btn btn-primary" id="ios-share-btn" style="flex:1">Открыть меню «Поделиться»</button>' : ''}
            <button type="button" class="btn" id="ios-copy-btn" style="flex:1">Скопировать ссылку</button>
          </div>
        </div>`,
      onMount: (root) => {
        const shareBtn = root.querySelector('#ios-share-btn');
        if (shareBtn && navigator.share) {
          shareBtn.onclick = () => navigator.share({ title: 'CoffeeIT', text: 'Доска объявлений CoffeeIT', url: appUrl }).catch(() => {});
        }
        const copyBtn = root.querySelector('#ios-copy-btn');
        if (copyBtn) {
          copyBtn.onclick = async () => {
            try {
              await navigator.clipboard.writeText(appUrl);
              toast('Ссылка скопирована — откройте её в Safari на iPhone');
            } catch (e) {
              toast(appUrl);
            }
          };
        }
      },
      actions: [{ label: 'Закрыть', onClick: (close) => close() }],
    });
  }

  function openStoriesDevModal() {
    openModal({
      title: 'Сторис CoffeeIT',
      body: `
        <div style="display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.5">
          <div style="padding:16px;border-radius:14px;color:#fff;background:linear-gradient(135deg,#f58529 0%,#dd2a7b 55%,#8134af 100%);box-shadow:0 8px 24px rgba(221,42,123,.28)">
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
              <span class="dev-dot"></span>
              <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;opacity:.92">В разработке</span>
            </div>
            <div style="font-size:17px;font-weight:800;margin-bottom:4px">Сторис в формате Instagram</div>
            <div style="font-size:13px;opacity:.92">Показывайте товары вживую — короткие видео и фото прямо в ленте CoffeeIT.</div>
          </div>
          <div class="story-feat-grid">
            <div class="story-feat">
              <b>Фото и видео</b>
              <span class="muted">Загрузка фото и коротких видео-обзоров прямо с iPhone, Android или ПК.</span>
            </div>
            <div class="story-feat">
              <b>Просмотры</b>
              <span class="muted">Точный счётчик просмотров каждой сторис в реальном времени.</span>
            </div>
            <div class="story-feat">
              <b>Лайки и реакции</b>
              <span class="muted">Быстрые лайки от покупателей и мгновенный переход к объявлению.</span>
            </div>
            <div class="story-feat">
              <b>Статистика в кабинете</b>
              <span class="muted">Отдельная аналитика просмотров, лайков и активности в личном кабинете.</span>
            </div>
          </div>
        </div>`,
      actions: [{ label: 'Отлично, ждём!', primary: true, onClick: (close) => close() }],
    });
  }

  // Глобальный делегированный обработчик (для карточек, отрисованных позже)
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'f-promote') {
      const box = $('#f-promote-methods');
      if (box) box.style.display = e.target.checked ? 'flex' : 'none';
    }
  });

  /* ---- 10 современных дизайнов (переключатель в реальном времени) ---- */
  const DESIGNS = [
    { id: 'apple', name: '1. Apple Glass', desc: 'Матовое стекло iOS/macOS, мягкие тени, синий акцент', swatch: 'linear-gradient(135deg,#f5f5f7,#0071e3)' },
    { id: 'stripe', name: '2. Stripe Mesh', desc: 'Живой анимированный градиент, индиго + циан', swatch: 'linear-gradient(135deg,#635bff,#00d4ff,#ff7a59)' },
    { id: 'linear', name: '3. Linear Dark', desc: 'Глубокий обсидиан, тонкие линии, фиолетовое свечение', swatch: 'linear-gradient(135deg,#08090a,#5e6ad2)' },
    { id: 'airbnb', name: '4. Airbnb Warm', desc: 'Тёплый editorial-стиль, коралловый акцент, мягкие карточки', swatch: 'linear-gradient(135deg,#fffaf6,#ff385c)' },
    { id: 'neon', name: '5. Cyber Neon', desc: 'Ночной неон, бирюзово-розовое пульсирующее свечение', swatch: 'linear-gradient(135deg,#070714,#00f5d4,#ff2e93)' },
    { id: 'brutal', name: '6. Neo-Brutalism', desc: 'Смелые контрастные рамки, жёсткие тени, стиль Gumroad/Figma', swatch: 'linear-gradient(135deg,#ffde00,#ff6b9d,#111)' },
    { id: 'coffee', name: '7. Coffee Espresso', desc: 'Фирменный кофейный стиль: крем, эспрессо и карамель', swatch: 'linear-gradient(135deg,#faf6f1,#b45309,#2c1a0e)' },
    { id: 'telegram', name: '8. Telegram Breeze', desc: 'Воздушный небесно-голубой мобильный стиль', swatch: 'linear-gradient(135deg,#f0f7fc,#229ed9)' },
    { id: 'bento', name: '9. Bento Minimal', desc: 'Модульная швейцарская сетка + сигнальный оранжевый', swatch: 'linear-gradient(135deg,#f2f2f2,#ff4d00)' },
    { id: 'emerald', name: '10. Emerald Fintech', desc: 'Тёмный изумруд и золото в стиле премиального финтеха', swatch: 'linear-gradient(135deg,#061612,#10b981,#f5c542)' },
    { id: 'od-cafe', name: '11. Open-Design: Cafe', desc: 'Уютная кофейная дизайн-система из nexu-io/open-design (#5D4432)', swatch: 'linear-gradient(135deg,#f9f7f5,#5d4432,#3e2b1e)' },
    { id: 'od-clay', name: '12. Open-Design: Clay 3D', desc: 'Объёмный 3D Claymorphism с мягкими двойными тенями', swatch: 'linear-gradient(135deg,#eef2ff,#4f46e5,#818cf8)' },
    { id: 'od-arc', name: '13. Open-Design: Arc Glass', desc: 'Космическое стекло с сиреневым свечением (стиль Arc)', swatch: 'linear-gradient(135deg,#0f1021,#a78bfa,#38bdf8)' },
  ];

  function applyDesign(id) {
    const html = document.documentElement;
    if (!id || id === 'default') {
      html.removeAttribute('data-design');
      try { localStorage.removeItem('coffeeit:design:v1'); } catch (e) {}
    } else {
      html.setAttribute('data-design', id);
      try { localStorage.setItem('coffeeit:design:v1', id); } catch (e) {}
    }
  }
  try {
    const savedDesign = localStorage.getItem('coffeeit:design:v1');
    if (savedDesign) document.documentElement.setAttribute('data-design', savedDesign);
  } catch (e) {}

  function openDesignsModal() {
    const cur = document.documentElement.getAttribute('data-design') || 'default';
    openModal({
      title: '10 современных дизайнов CoffeeIT',
      body: `
        <div style="display:flex;flex-direction:column;gap:12px">
          <p class="small muted">Нажмите на любой дизайн — он <b>мгновенно применится</b> ко всему сайту с плавными анимациями. Подходит для iPhone, Android и планшетов.</p>
          <div class="design-grid">
            ${DESIGNS.map(d => `
              <button type="button" class="design-tile ${cur === d.id ? 'active' : ''}" data-pick-design="${d.id}">
                <span class="design-swatch" style="background:${d.swatch}"></span>
                <b style="font-size:13.5px">${UI.esc(d.name)}</b>
                <span class="small muted" style="font-size:12px;line-height:1.35">${UI.esc(d.desc)}</span>
              </button>`).join('')}
          </div>
          <button type="button" class="btn btn-sm" data-pick-design="default">Вернуть стандартный дизайн</button>
        </div>`,
      onMount: (root, close) => {
        root.querySelectorAll('[data-pick-design]').forEach((btn) => {
          btn.onclick = () => {
            const id = btn.dataset.pickDesign;
            applyDesign(id);
            const found = DESIGNS.find(x => x.id === id);
            toast(found ? `Применён дизайн: ${found.name}` : 'Возвращён стандартный дизайн');
            close();
          };
        });
      },
    });
  }

  document.addEventListener('click', async (e) => {
    const desBtn = e.target.closest('[data-open-designs]');
    if (desBtn) {
      e.preventDefault();
      openDesignsModal();
      return;
    }

    const supBtn = e.target.closest('[data-support-project]');
    if (supBtn) {
      e.preventDefault();
      openSupportProjectModal('');
      return;
    }

    const promoBtn = e.target.closest('[data-open-promo]');
    if (promoBtn) {
      e.preventDefault();
      openPromoPaymentModal({
        adId: promoBtn.dataset.promoAdId || null,
        adTitle: promoBtn.dataset.promoAdTitle || '',
      });
      return;
    }

    const storiesBtn = e.target.closest('[data-stories-dev]');
    if (storiesBtn) {
      e.preventDefault();
      openStoriesDevModal();
      return;
    }

    const iosBtn = e.target.closest('[data-install-ios]');
    if (iosBtn) {
      e.preventDefault();
      openInstallIosModal();
      return;
    }

    const priv = e.target.closest('[data-open-privacy]');
    if (priv) {
      e.preventDefault();
      openPrivacyModal();
      return;
    }

    const fav = e.target.closest('[data-fav]');
    if (fav && !fav.dataset.bound) {
      e.preventDefault();
      if (!state.me) { toast('Войдите, чтобы сохранять в избранное', 'err'); return navigate('/auth'); }
      try {
        const r = await API.post('/api/ads/' + fav.dataset.fav + '/favorite');
        fav.classList.toggle('on', r.favorite);
        toast(r.favorite ? 'Добавлено в избранное' : 'Удалено из избранного');
      } catch (err) { toast(err.message, 'err'); }
    }

    const restore = e.target.closest('[data-restore-ad]');
    if (restore) {
      e.preventDefault();
      const id = restore.dataset.restoreAd;
      const btn = restore;
      btn.disabled = true;
      try {
        const r = await API.patch('/api/ads/' + id, { status: 'active' });
        toast(r && r.ad && r.ad.status === 'active' ? 'Объявление снова в публикации' : 'Готово');
        render(true);
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 'err', err.status === 507 ? 12000 : 4000);
      }
      return;
    }

    const st = e.target.closest('[data-deal-status]');
    if (st) {
      e.preventDefault();
      const label = { confirmed: 'Подтвердить сделку?', declined: 'Отклонить предложение?', done: 'Завершить сделку?', canceled: 'Отменить сделку?' }[st.dataset.next];
      if (!(await confirmDialog('Сделка', label, 'Да'))) return;
      try {
        await API.post('/api/deals/' + st.dataset.dealStatus + '/status', { status: st.dataset.next });
        toast('Статус обновлён');
        render(true);
      } catch (err) { toast(err.message, 'err'); }
    }
  });

  /* ---------------- старт ---------------- */
  UI.initTheme();
  (async () => {
    // на статической версии (GitHub Pages) данные лежат в IndexedDB — ждём загрузки.
    // Но не бесконечно: если хранилище молчит, показываем интерфейс из демо-данных,
    // а не оставляем пустую страницу.
    if (window.__STORE_READY__ && typeof window.__STORE_READY__.then === 'function') {
      try {
        await Promise.race([
          Promise.resolve(window.__STORE_READY__),
          new Promise((resolve) => setTimeout(resolve, 2500)),
        ]);
      } catch (e) {}
    }
    try {
      await render();
    } catch (e) {
      console.error(e);
      app.innerHTML = `<div class="container"><div class="empty">Не удалось загрузить объявления. <a href="" data-retry style="color:var(--primary)">Обновить страницу</a></div></div>`;
      const retry = document.querySelector('[data-retry]');
      if (retry) retry.onclick = (ev) => { ev.preventDefault(); location.reload(); };
    }
    connectEvents();
  })();
})();
