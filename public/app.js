const NBSP = ' ';

const els = {
  todayDate: document.getElementById('today-date'),
  slotList: document.getElementById('slot-list'),
  bookingForm: document.getElementById('booking-form'),
  bookingName: document.getElementById('booking-name'),
  bookingSubmit: document.getElementById('booking-submit'),
  bookingMessage: document.getElementById('booking-message'),
  feedingWhen: document.getElementById('feeding-when'),
  feedingSep: document.getElementById('feeding-sep'),
  feedingWho: document.getElementById('feeding-who'),
  feedingForm: document.getElementById('feeding-form'),
  feedingName: document.getElementById('feeding-name'),
  feedingSubmit: document.getElementById('feeding-submit'),
  feedingMessage: document.getElementById('feeding-message'),
  footerYear: document.getElementById('footer-year'),
};

let selectedTime = null;

// --- Вспомогательное ---

function parseLocalDate(isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function dayMonth(date) {
  // «22 октября» с неразрывным пробелом между числом и месяцем
  return date
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
    .replace(' ', NBSP);
}

function formatToday(isoDate) {
  const date = parseLocalDate(isoDate);
  const weekday = date.toLocaleDateString('ru-RU', { weekday: 'long' });
  return `${weekday}, ${dayMonth(date)}`;
}

// «Сегодня, 15:09», «Вчера, 15:09» или «21 октября, 15:09»
function formatFeedingTime(iso) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const now = new Date();
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();

  let day;
  if (sameDay(date, now)) day = 'Сегодня';
  else if (sameDay(date, yesterday)) day = 'Вчера';
  else day = dayMonth(date);
  return `${day}, ${time}`;
}

function showMessage(el, text, type) {
  el.textContent = text;
  el.className = `${el.className.replace(/\s*message--\w+/g, '')}${type ? ` message--${type}` : ''}`;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    throw new Error(`Нет связи с${NBSP}сервером. Проверьте, что он запущен`);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(body.error || `Что-то пошло не${NBSP}так, попробуйте ещё раз`);
    error.status = res.status;
    throw error;
  }
  return body;
}

// --- Отрисовка ---

function renderSlots(slots) {
  const freeTimes = slots.filter((s) => !s.bookedBy).map((s) => s.time);
  if (!freeTimes.includes(selectedTime)) selectedTime = null;

  els.slotList.replaceChildren(
    ...slots.map((slot) => {
      const busy = Boolean(slot.bookedBy);
      const id = `slot-${slot.time.replace(':', '')}`;

      const li = document.createElement('li');
      li.className = `slot ${busy ? 'slot--busy' : 'slot--free'}`;

      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'slot';
      input.value = slot.time;
      input.id = id;
      input.className = 'slot__input';
      input.disabled = busy;
      input.checked = slot.time === selectedTime;
      input.addEventListener('change', () => {
        selectedTime = slot.time;
        showMessage(els.bookingMessage, '');
      });

      const label = document.createElement('label');
      label.className = 'slot__label';
      label.htmlFor = id;

      const time = document.createElement('span');
      time.className = 'slot__time';
      time.textContent = slot.time;

      const status = document.createElement('span');
      status.className = 'slot__status';
      status.textContent = busy ? `Гуляет: ${slot.bookedBy}` : 'свободно';

      const marker = document.createElement('span');
      marker.className = 'slot__marker';
      marker.setAttribute('aria-hidden', 'true');

      label.append(time, status, marker);
      li.append(input, label);
      return li;
    })
  );
}

function renderFeeding(lastFeeding) {
  const hasFeeding = Boolean(lastFeeding);
  els.feedingSep.hidden = !hasFeeding;
  els.feedingWho.hidden = !hasFeeding;

  if (!hasFeeding) {
    els.feedingWhen.textContent = 'Пока нет отметок';
    els.feedingWhen.removeAttribute('datetime');
    els.feedingWho.textContent = '';
    return;
  }
  els.feedingWhen.textContent = formatFeedingTime(lastFeeding.fedAt);
  els.feedingWhen.dateTime = lastFeeding.fedAt;
  els.feedingWho.textContent = lastFeeding.name;
}

function render(state) {
  els.todayDate.textContent = formatToday(state.date);
  els.todayDate.dateTime = state.date;
  els.footerYear.textContent = state.date.slice(0, 4);
  renderSlots(state.slots);
  renderFeeding(state.lastFeeding);
}

async function load() {
  try {
    render(await api('/api/state'));
  } catch (err) {
    showMessage(els.bookingMessage, err.message, 'error');
  }
}

// --- Действия ---

function readName(input, messageEl) {
  const name = input.value.trim().replace(/\s+/g, ' ');
  if (!name) {
    input.setAttribute('aria-invalid', 'true');
    input.focus();
    showMessage(messageEl, `Введите имя и${NBSP}фамилию`, 'error');
    return null;
  }
  input.removeAttribute('aria-invalid');
  return name;
}

els.bookingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!selectedTime) {
    showMessage(els.bookingMessage, 'Сначала выберите свободный слот', 'error');
    return;
  }
  const name = readName(els.bookingName, els.bookingMessage);
  if (!name) return;

  const time = selectedTime;
  els.bookingSubmit.disabled = true;
  try {
    const state = await api('/api/slots/book', {
      method: 'POST',
      body: JSON.stringify({ time, name }),
    });
    selectedTime = null;
    els.bookingName.value = '';
    render(state);
    showMessage(els.bookingMessage, `Готово! ${name}, Борис ждёт вас в${NBSP}${time}`, 'success');
  } catch (err) {
    if (err.status === 409) {
      // Слот успели занять: показываем актуальное состояние
      selectedTime = null;
      await load();
    }
    showMessage(els.bookingMessage, err.message, 'error');
  } finally {
    els.bookingSubmit.disabled = false;
  }
});

els.feedingForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = readName(els.feedingName, els.feedingMessage);
  if (!name) return;

  els.feedingSubmit.disabled = true;
  try {
    const state = await api('/api/feedings', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    els.feedingName.value = '';
    render(state);
    showMessage(els.feedingMessage, 'Спасибо! Борис сыт', 'success');
  } catch (err) {
    showMessage(els.feedingMessage, err.message, 'error');
  } finally {
    els.feedingSubmit.disabled = false;
  }
});

[els.bookingName, els.feedingName].forEach((input) => {
  input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
});

// Подтягиваем свежее состояние, когда сотрудник возвращается на вкладку
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') load();
});

load();
