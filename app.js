const DEFAULT_CHURCH_LOGO = 'https://placehold.co/120x120/1C2541/D4AF37?text=لوجو+الكنيسة';
const THEME_LABELS = {
  'theme-navy-gold': 'الملكي الأزرق والذهبي', 'theme-burgundy-gold': 'العنابي والذهبي',
  'theme-emerald-gold': 'الزمردي الملكي', 'theme-wood-parchment': 'الخشبي الروحي',
  'theme-clean-white': 'الأبيض الاقتصادي', 'theme-neon-dark': 'الداكن الحديث',
  'theme-royal-purple': 'البنفسجي الملكي', 'theme-ocean-blue': 'الأزرق البحري',
  'theme-rose-gold': 'الوردي والذهبي', 'theme-ivory-green': 'العاجي والأخضر',
  'theme-silver-black': 'الأسود والفضي', 'theme-sky-white': 'السماوي والأبيض',
  'theme-sunset': 'الغروب', 'theme-lavender': 'اللافندر',
  'theme-christmas': 'الأخضر الاحتفالي', 'theme-minimal-gold': 'الذهبي البسيط'
};
const appState = {
  currentUser: null,
  admins: [],
  churchLogo: DEFAULT_CHURCH_LOGO,
  events: [],
  tickets: [],
  attendance: [],
  eventCounts: {},
  counter: 1000,
  selectedTheme: 'theme-navy-gold',
  availableThemes: Object.keys(THEME_LABELS)
};

let html5QrcodeScanner = null;
let editingEventId = null;

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const request = { ...options, headers, credentials: 'same-origin' };
  if (options.body && typeof options.body !== 'string') {
    headers.set('Content-Type', 'application/json');
    request.body = JSON.stringify(options.body);
  }
  const response = await fetch(url, request);
  let data = {};
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(data.error || `تعذر تنفيذ الطلب (${response.status}).`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' }).format(date);
}

function getActiveEvent() {
  return appState.events.find((event) => event.active) || appState.events[0] || null;
}

function showLoginModal() {
  document.getElementById('loginModal').classList.remove('hidden');
  document.getElementById('loginError').classList.add('hidden');
  setTimeout(() => document.getElementById('loginUsername').focus(), 50);
}

function closeLoginModal() {
  document.getElementById('loginModal').classList.add('hidden');
  document.getElementById('loginForm').reset();
  document.getElementById('loginError').classList.add('hidden');
}

function setSignedInUser(username) {
  appState.currentUser = username || null;
  const button = document.getElementById('authBtn');
  document.getElementById('authBtnText').innerText = username ? `مرحباً ${username} (خروج)` : 'دخول الأدمن';
  button.className = username
    ? 'px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 transition flex items-center gap-1'
    : 'px-3 py-1.5 rounded-lg text-xs font-bold bg-crimson-600 text-white hover:bg-crimson-700 transition flex items-center gap-1';
  document.getElementById('currentAdminNewUsername').value = username || '';
  document.getElementById('bookingsToolbar').classList.toggle('hidden', !username);
  document.getElementById('bookingsLoginHint').classList.toggle('hidden', Boolean(username));
}

async function initializeApp() {
  try {
    const state = await api('/api/bootstrap');
    Object.assign(appState, state, { tickets: [], attendance: [], admins: [] });
    document.getElementById('churchLogo').src = appState.churchLogo;
    document.getElementById('previewChurchLogo').src = appState.churchLogo;
    const auth = await api('/api/auth/me');
    setSignedInUser(auth.username);
    renderNewEventThemes();
    refreshThemeSelector();
    setupBatchRows();
    updateQRCodeDisplay('SERV-1001');
    renderEventsList();
    updateStats();
    updateRegisteredCount();
    if (auth.username) await refreshAdminData();
  } catch (error) {
    console.error(error);
    const alert = document.getElementById('appError');
    alert.textContent = `تعذر الاتصال بالخادم أو بقاعدة البيانات: ${error.message}`;
    alert.classList.remove('hidden');
  }
}

window.addEventListener('DOMContentLoaded', initializeApp);

function switchTab(tab) {
  const protectedTabs = ['scan', 'bookings', 'events', 'admins'];
  if (protectedTabs.includes(tab) && !appState.currentUser) {
    alert('هذه الصفحة للأدمن فقط. سجّل الدخول أولاً.');
    showLoginModal();
    return;
  }
  const tabs = ['register', 'batch', 'scan', 'bookings', 'events', 'admins'];
  for (const name of tabs) {
    document.getElementById(`section-${name}`).classList.toggle('hidden', name !== tab);
    const button = document.getElementById(`tab-${name}`);
    button.className = name === tab
      ? 'px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 bg-gold-500 text-navy-900'
      : 'px-3 py-1.5 rounded-lg text-xs font-bold text-slate-300 hover:text-white transition flex items-center gap-1.5';
  }
  if (tab === 'scan') initScanner();
  if (tab === 'bookings') renderAdminBookings();
}

async function handleAuthAction() {
  if (appState.currentUser) {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); }
    catch (error) { console.error(error); }
    appState.tickets = [];
    appState.attendance = [];
    appState.admins = [];
    setSignedInUser(null);
    switchTab('register');
    updateStats();
    return;
  }
  showLoginModal();
}

async function submitLogin(event) {
  event.preventDefault();
  const errorBox = document.getElementById('loginError');
  errorBox.classList.add('hidden');
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: {
        username: document.getElementById('loginUsername').value.trim(),
        password: document.getElementById('loginPassword').value
      }
    });
    setSignedInUser(result.username);
    closeLoginModal();
    await refreshAdminData();
    alert('تم تسجيل الدخول بنجاح.');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
    document.getElementById('loginPassword').value = '';
  }
}

async function refreshBootstrap() {
  const state = await api('/api/bootstrap');
  appState.events = state.events;
  appState.churchLogo = state.churchLogo;
  appState.eventCounts = state.eventCounts;
  appState.counter = state.counter;
  appState.availableThemes = state.availableThemes;
  document.getElementById('churchLogo').src = appState.churchLogo;
  document.getElementById('previewChurchLogo').src = appState.churchLogo;
  renderEventsList();
  refreshThemeSelector();
  updateRegisteredCount();
  updateStats();
}

async function refreshAdminData() {
  if (!appState.currentUser) return;
  const data = await api('/api/admin/data');
  Object.assign(appState, data);
  document.getElementById('churchLogo').src = appState.churchLogo;
  document.getElementById('previewChurchLogo').src = appState.churchLogo;
  renderEventsList();
  renderAdminsList();
  renderAttendanceTable();
  renderBookingFilters();
  renderAdminBookings();
  updateStats();
  updateRegisteredCount();
}

function updateRegisteredCount() {
  const active = getActiveEvent();
  document.getElementById('registeredCount').textContent = active ? (appState.eventCounts[active.id] || 0) : 0;
}

function renderNewEventThemes(containerId = 'newEventThemes', selectedThemes = null) {
  const holder = document.getElementById(containerId);
  if (!holder) return;
  const selected = selectedThemes || appState.availableThemes.slice(0, 6);
  holder.innerHTML = appState.availableThemes.map((theme) => `
    <label class="flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950/60 p-2 cursor-pointer">
      <input type="checkbox" name="${containerId}-theme" value="${theme}" ${selected.includes(theme) ? 'checked' : ''} class="accent-amber-400">
      <span>${escapeHtml(THEME_LABELS[theme] || theme)}</span>
    </label>`).join('');
}

function refreshThemeSelector(selected = '') {
  const selector = document.getElementById('themeSelector');
  const active = getActiveEvent();
  const themes = active?.themes?.length ? active.themes : appState.availableThemes;
  selector.innerHTML = themes.map((theme) => `<option value="${escapeHtml(theme)}">${escapeHtml(THEME_LABELS[theme] || theme)}</option>`).join('');
  const choice = themes.includes(selected) ? selected : (themes.includes(appState.selectedTheme) ? appState.selectedTheme : themes[0]);
  selector.value = choice || 'theme-navy-gold';
  changeTheme(selector.value);
}

function changeTheme(themeClass) {
  if (!THEME_LABELS[themeClass]) return;
  appState.selectedTheme = themeClass;
  const card = document.getElementById('ticketCard');
  const pdfCard = document.getElementById('pdfTemplateCard');
  card.className = `w-full max-w-md ${themeClass} rounded-2xl p-6 relative shadow-2xl transition-all invitation-card`;
  pdfCard.className = `${themeClass} rounded-2xl invitation-card`;
}

function setupBatchRows() {
  const holder = document.getElementById('batchRowsContainer');
  holder.innerHTML = '';
  for (let index = 0; index < 3; index += 1) addBatchRow();
}

function addBatchRow() {
  const holder = document.getElementById('batchRowsContainer');
  const row = document.createElement('div');
  row.className = 'grid grid-cols-1 sm:grid-cols-3 gap-2 bg-navy-900/60 p-3 rounded-xl border border-navy-700 items-center';
  row.innerHTML = `
    <input type="text" placeholder="اسم الخادم كاملاً *" class="batch-name bg-navy-800 border border-navy-700 text-white text-xs rounded-lg px-3 py-2">
    <input type="text" placeholder="القطاع / الخدمة" class="batch-stage bg-navy-800 border border-navy-700 text-white text-xs rounded-lg px-3 py-2">
    <input type="tel" placeholder="الموبايل" class="batch-phone bg-navy-800 border border-navy-700 text-white text-xs rounded-lg px-3 py-2">`;
  holder.appendChild(row);
}

async function generateTicket(event) {
  event.preventDefault();
  const name = document.getElementById('servantName').value.trim();
  if (!name) return;
  const payload = {
    name,
    stage: document.getElementById('servantStage').value.trim() || 'خدمة عامة',
    phone: document.getElementById('servantPhone').value.trim(),
    theme: document.getElementById('themeSelector').value || appState.selectedTheme
  };
  try {
    const result = await api('/api/bookings', { method: 'POST', body: payload });
    appState.counter = result.counter;
    appState.eventCounts[result.event.id] = (appState.eventCounts[result.event.id] || 0) + 1;
    appState.tickets.unshift(result.ticket);
    updateTicketDisplays(result.ticket, result.event);
    document.getElementById('actionButtons').classList.remove('hidden');
    document.getElementById('servantName').value = '';
    document.getElementById('servantPhone').value = '';
    updateRegisteredCount();
    if (appState.currentUser) await refreshAdminData();
  } catch (error) {
    alert(`تعذر إتمام الحجز: ${error.message}`);
  }
}

function updateTicketDisplays(ticket, event) {
  if (!ticket || !event) return;
  const safeText = (id, value) => { document.getElementById(id).textContent = value ?? ''; };
  safeText('previewServantName', ticket.name);
  safeText('previewServantStage', ticket.stage || 'خدمة عامة');
  safeText('previewTicketCode', `#${ticket.code}`);
  safeText('previewChurchName', 'كنيسة الأنبا شنودة رئيس المتوحدين بالزرابي');
  safeText('previewEventTitle', event.title);
  safeText('previewBibleVerse', `«${event.verse}»`);
  safeText('previewEventDate', `📅 ${event.date}`);
  safeText('previewEventTime', `⏰ ${event.time}`);
  safeText('pdfServantName', ticket.name);
  safeText('pdfServantStage', ticket.stage || 'خدمة عامة');
  safeText('pdfTicketCode', `#${ticket.code}`);
  safeText('pdfEventTitle', event.title);
  safeText('pdfChurchName', 'كنيسة الأنبا شنودة رئيس المتوحدين بالزرابي');
  safeText('pdfBibleVerse', `«${event.verse}»`);
  safeText('pdfEventDate', `📅 ${event.date}`);
  safeText('pdfEventTime', `⏰ ${event.time}`);
  safeText('pdfRewardText', document.getElementById('previewRewardText').innerText);
  document.getElementById('previewChurchLogo').src = appState.churchLogo;
  document.getElementById('previewEventLogo').src = event.logo || appState.churchLogo;
  document.getElementById('pdfChurchLogo').src = appState.churchLogo;
  document.getElementById('pdfEventLogo').src = event.logo || appState.churchLogo;
  const theme = ticket.theme || appState.selectedTheme;
  document.getElementById('ticketCard').className = `w-full max-w-md ${theme} rounded-2xl p-6 relative shadow-2xl transition-all invitation-card`;
  document.getElementById('pdfTemplateCard').className = `${theme} rounded-2xl invitation-card`;
  updateQRCodeDisplay(ticket.code);
}

function updateQRCodeDisplay(code) {
  if (!window.QRCode) return;
  const preview = document.getElementById('qrcode');
  const pdf = document.getElementById('pdfQrcode');
  preview.innerHTML = '';
  pdf.innerHTML = '';
  new QRCode(preview, { text: String(code), width: 90, height: 90, correctLevel: QRCode.CorrectLevel.M });
  new QRCode(pdf, { text: String(code), width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M });
}

function printSingleTicket() {
  if (document.getElementById('actionButtons').classList.contains('hidden')) {
    alert('أنشئ الدعوة أولاً قبل الطباعة.');
    return;
  }
  window.print();
}

async function waitForImages(element) {
  const images = [...element.querySelectorAll('img')];
  await Promise.all(images.map((image) => {
    if (image.complete && image.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
      setTimeout(resolve, 5000);
    });
  }));
}

async function renderPdf(element, filename, saveFile = true) {
  if (!window.html2canvas || !window.jspdf?.jsPDF) {
    throw new Error('مكتبات PDF غير متاحة. تحقق من الاتصال بالإنترنت.');
  }
  const overlay = document.getElementById('pdf-export-overlay');
  document.getElementById('pdf-export-message').textContent = 'جاري تجهيز الدعوات للطباعة…';
  const container = element.id === 'pdfTemplateCard' ? element.parentElement : element;
  const originalInline = {
    position: container.style.position, left: container.style.left, top: container.style.top,
    right: container.style.right, bottom: container.style.bottom, zIndex: container.style.zIndex,
    width: container.style.width, visibility: container.style.visibility
  };
  const isWrapper = container.id !== 'pdfTemplateCard';
  const pages = element.id === 'pdfTemplateCard' ? [element] : [...element.children];
  if (!pages.length) throw new Error('لا توجد دعوات جاهزة للتصدير.');
  const { jsPDF } = window.jspdf;
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  let renderedPages = 0;
  overlay.classList.remove('hidden');
  document.body.classList.add('pdf-exporting');
  if (isWrapper) {
    container.style.position = 'fixed';
    container.style.left = '0';
    container.style.top = '0';
    container.style.right = 'auto';
    container.style.bottom = 'auto';
    container.style.zIndex = '10001';
    container.style.width = '210mm';
    container.style.visibility = 'visible';
  }
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    for (const page of pages) {
      await waitForImages(page);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const rect = page.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 100) throw new Error('تعذر تحديد أبعاد صفحة الدعوة.');
      const canvas = await window.html2canvas(page, {
        scale: 1.25,
        useCORS: true,
        allowTaint: false,
        backgroundColor: null,
        logging: false,
        scrollX: 0,
        scrollY: 0,
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
        windowWidth: Math.max(document.documentElement.clientWidth, Math.ceil(rect.width)),
        windowHeight: Math.max(document.documentElement.clientHeight, Math.ceil(rect.height))
      });
      if (!canvas.width || !canvas.height) throw new Error('تعذر رسم محتوى صفحة الدعوة.');
      const pageHeightPx = canvas.width * (297 / 210);
      const sliceCount = page.classList.contains('event-report-page')
        ? Math.max(1, Math.ceil(canvas.height / pageHeightPx)) : 1;
      for (let slice = 0; slice < sliceCount; slice += 1) {
        if (renderedPages > 0) pdf.addPage();
        if (sliceCount === 1) {
          pdf.addImage(canvas.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
        } else {
          const sourceY = Math.round(slice * pageHeightPx);
          const sourceHeight = Math.min(Math.ceil(pageHeightPx), canvas.height - sourceY);
          const cropped = document.createElement('canvas');
          cropped.width = canvas.width;
          cropped.height = sourceHeight;
          cropped.getContext('2d').drawImage(canvas, 0, sourceY, canvas.width, sourceHeight, 0, 0, cropped.width, cropped.height);
          pdf.addImage(cropped.toDataURL('image/jpeg', 0.94), 'JPEG', 0, 0, 210, 297, undefined, 'FAST');
          cropped.width = 0;
          cropped.height = 0;
        }
        renderedPages += 1;
      }
      canvas.width = 0;
      canvas.height = 0;
    }
    if (saveFile) await pdf.save(filename);
    return { pages: pdf.internal.getNumberOfPages(), bytes: pdf.output('arraybuffer').byteLength };
  } finally {
    if (isWrapper) {
      container.style.position = originalInline.position;
      container.style.left = originalInline.left;
      container.style.top = originalInline.top;
      container.style.right = originalInline.right;
      container.style.bottom = originalInline.bottom;
      container.style.zIndex = originalInline.zIndex;
      container.style.width = originalInline.width;
      container.style.visibility = originalInline.visibility;
    }
    document.body.classList.remove('pdf-exporting');
    overlay.classList.add('hidden');
  }
}

async function downloadPDF() {
  const ticket = appState.tickets[0];
  if (!ticket) return alert('أنشئ الدعوة أولاً قبل تحميل PDF.');
  try {
    await renderPdf(document.getElementById('pdfTemplateCard'), `دعوة_حضور_${ticket.code}.pdf`);
  } catch (error) {
    alert(`تعذر إنشاء ملف PDF: ${error.message}`);
  }
}

function buildBulkTicketPage(ticket, event) {
  const page = document.createElement('article');
  page.className = `bulk-ticket-page ${ticket.theme || 'theme-navy-gold'} invitation-card`;
  const header = document.createElement('header');
  header.className = 'bulk-ticket-header';
  const churchLogo = document.createElement('img');
  churchLogo.src = appState.churchLogo;
  churchLogo.alt = 'شعار الكنيسة';
  const heading = document.createElement('div');
  heading.className = 'bulk-ticket-heading';
  const label = document.createElement('span');
  label.className = 'bulk-ticket-label';
  label.textContent = 'دعوة حضور رسمية';
  const title = document.createElement('h1');
  title.textContent = event.title;
  const eventLogo = document.createElement('img');
  eventLogo.src = event.logo || appState.churchLogo;
  eventLogo.alt = 'شعار الفعالية';
  header.append(churchLogo, heading, eventLogo);
  heading.append(label, title);

  const motif = document.createElement('div');
  motif.className = 'bulk-ticket-motif';
  motif.textContent = '✦  ✧  ✦  ✧  ✦';
  const church = document.createElement('p');
  church.className = 'bulk-church-name';
  church.textContent = 'كنيسة الأنبا شنودة رئيس المتوحدين بالزرابي';
  const name = document.createElement('h2');
  name.className = 'bulk-ticket-name';
  name.textContent = ticket.name;
  const stage = document.createElement('p');
  stage.className = 'bulk-ticket-stage';
  stage.textContent = `الخدمة: ${ticket.stage || 'خدمة عامة'}`;
  const invitationText = document.createElement('p');
  invitationText.className = 'bulk-invitation-text';
  invitationText.textContent = 'بفرح ومحبة ندعوك لمشاركتنا هذا اليوم المبارك';
  const verse = document.createElement('blockquote');
  verse.className = 'bulk-ticket-verse';
  verse.textContent = `«${event.verse || ''}»`;
  const qrWrap = document.createElement('div');
  qrWrap.className = 'bulk-ticket-qr';
  const qrNode = document.createElement('div');
  qrWrap.appendChild(qrNode);
  const code = document.createElement('p');
  code.className = 'bulk-ticket-code';
  code.textContent = `كود الدعوة: ${ticket.code}`;
  new QRCode(qrNode, { text: ticket.code, width: 176, height: 176, correctLevel: QRCode.CorrectLevel.M });

  const footer = document.createElement('footer');
  footer.className = 'bulk-ticket-footer';
  const date = document.createElement('span');
  date.textContent = `📅 ${event.date}`;
  const time = document.createElement('span');
  time.textContent = `⏰ ${event.time}`;
  const motto = document.createElement('strong');
  motto.className = 'bulk-ticket-motto';
  motto.textContent = 'محبة • صلاة • شركة';
  page.append(header, motif, church, invitationText, name, stage, verse, qrWrap, code, motto, footer);
  footer.append(date, time);
  return page;
}

async function exportTicketsBulkPDF(tickets) {
  if (!tickets.length) return alert('لا توجد حجوزات لتصديرها.');
  const active = getActiveEvent();
  const event = appState.events.find((item) => item.id === tickets[0].eventId) || active;
  if (!event) return alert('تعذر تحديد بيانات الفعالية.');
  const container = document.getElementById('bulk-pdf-render-wrapper');
  container.innerHTML = '';
  for (const ticket of tickets) container.appendChild(buildBulkTicketPage(ticket, event));
  const safeTitle = event.title.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, '_');
  await renderPdf(container, `دعوات_${safeTitle}_${Date.now()}.pdf`);
}

async function exportAllTicketsBulkPDF() {
  if (!appState.currentUser) {
    alert('تصدير جميع الحجوزات متاح للأدمن فقط.');
    showLoginModal();
    return;
  }
  try {
    await refreshAdminData();
    const event = getActiveEvent();
    const tickets = appState.tickets.filter((ticket) => ticket.eventId === event?.id);
    if (!tickets.length) return alert('لا توجد دعوات محجوزة لهذه الفعالية بعد.');
    await exportTicketsBulkPDF(tickets);
  } catch (error) {
    alert(`تعذر تصدير الدعوات: ${error.message}`);
  }
}

async function processBatchBooking() {
  const names = [...document.querySelectorAll('.batch-name')];
  const stages = [...document.querySelectorAll('.batch-stage')];
  const phones = [...document.querySelectorAll('.batch-phone')];
  const entries = names.map((input, index) => ({
    name: input.value.trim(),
    stage: stages[index].value.trim() || 'خدمة عامة',
    phone: phones[index].value.trim(),
    theme: appState.selectedTheme
  })).filter((entry) => entry.name);
  if (!entries.length) return alert('اكتب اسم خادم واحد على الأقل لإتمام الحجز.');
  const button = document.querySelector('#section-batch button[onclick="processBatchBooking()"]');
  button.disabled = true;
  try {
    const result = await api('/api/bookings/batch', { method: 'POST', body: { entries } });
    appState.counter = result.counter;
    appState.eventCounts[result.event.id] = (appState.eventCounts[result.event.id] || 0) + result.tickets.length;
    appState.tickets = [...result.tickets, ...appState.tickets];
    await refreshBootstrap();
    if (appState.currentUser) await refreshAdminData();
    await exportTicketsBulkPDF(result.tickets);
    setupBatchRows();
  } catch (error) {
    alert(`تعذر إكمال الحجز المتعدد: ${error.message}`);
  } finally {
    button.disabled = false;
  }
}

function renderEventsList() {
  const holder = document.getElementById('eventsList');
  if (!holder) return;
  holder.innerHTML = appState.events.map((event) => {
    const count = appState.eventCounts[event.id] || 0;
    const activeBadge = event.active
      ? '<span class="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 px-2 py-1 rounded font-bold">الفعالية النشطة</span>'
      : `<button onclick="setActiveEvent('${escapeHtml(event.id)}')" class="bg-navy-800 text-gold-400 px-3 py-1 rounded border border-gold-500/30">تعيين كنشطة</button>`;
    return `<div class="bg-navy-900 p-3 rounded-xl border ${event.active ? 'border-gold-500' : 'border-navy-700'} flex flex-wrap justify-between items-center gap-3 text-xs">
      <div class="min-w-0"><strong class="text-white text-sm font-black">${escapeHtml(event.title)}</strong>
        <p class="text-slate-400 mt-1">${escapeHtml(event.date)} | ${escapeHtml(event.time)}</p>
        <p class="text-gold-300 mt-1">${count} حجز • ${escapeHtml(event.verse || '')}</p>
      </div>
      <div class="flex items-center gap-2">${activeBadge}
        <button onclick="openEditEvent('${escapeHtml(event.id)}')" class="bg-sky-900/70 text-sky-200 px-3 py-1 rounded border border-sky-500/40"><i class="fa-solid fa-pen"></i> تعديل</button>
      </div>
    </div>`;
  }).join('');
  const active = getActiveEvent();
  if (!active) return;
  document.getElementById('currentActiveEventBadge').innerText = active.title;
  document.getElementById('statActiveEventName').innerText = active.title;
  document.getElementById('headerEventSub').childNodes[0].textContent = 'الفعالية النشطة: ';
  document.getElementById('eventLogo').src = active.logo || appState.churchLogo;
  document.getElementById('previewEventLogo').src = active.logo || appState.churchLogo;
  renderAttendanceTable();
  renderBookingFilters();
}

async function setActiveEvent(id) {
  try {
    await api(`/api/admin/events/${encodeURIComponent(id)}`, { method: 'PUT', body: { active: true } });
    await refreshBootstrap();
    if (appState.currentUser) await refreshAdminData();
  } catch (error) { alert(error.message); }
}

function openEditEvent(id) {
  const event = appState.events.find((item) => item.id === id);
  if (!event) return;
  editingEventId = id;
  document.getElementById('editEventTitle').value = event.title;
  document.getElementById('editEventVerse').value = event.verse || '';
  document.getElementById('editEventDate').value = event.date || '';
  document.getElementById('editEventTime').value = event.time || '';
  renderNewEventThemes('editEventThemes', event.themes || []);
  document.getElementById('editEventModal').classList.remove('hidden');
}

function closeEditEvent() {
  editingEventId = null;
  document.getElementById('editEventModal').classList.add('hidden');
}

async function saveEventEdit(event) {
  event.preventDefault();
  if (!editingEventId) return;
  const payload = {
    title: document.getElementById('editEventTitle').value.trim(),
    verse: document.getElementById('editEventVerse').value.trim(),
    date: document.getElementById('editEventDate').value,
    time: document.getElementById('editEventTime').value.trim() || '7:00 ص',
    themes: [...document.querySelectorAll('#editEventThemes input:checked')].map((input) => input.value)
  };
  try {
    await api(`/api/admin/events/${encodeURIComponent(editingEventId)}`, { method: 'PUT', body: payload });
    closeEditEvent();
    await refreshBootstrap();
    if (appState.currentUser) await refreshAdminData();
    alert('تم حفظ تعديلات الفعالية.');
  } catch (error) { alert(`تعذر تعديل الفعالية: ${error.message}`); }
}

async function addNewEvent(event) {
  event.preventDefault();
  const payload = {
    title: document.getElementById('newEventTitle').value.trim(),
    verse: document.getElementById('newEventVerse').value.trim(),
    date: document.getElementById('newEventDate').value,
    time: document.getElementById('newEventTime').value.trim() || '7:00 ص',
    themes: [...document.querySelectorAll('#newEventThemes input:checked')].map((input) => input.value)
  };
  if (!payload.title || !payload.date) return;
  try {
    await api('/api/admin/events', { method: 'POST', body: payload });
    event.target.reset();
    renderNewEventThemes();
    await refreshBootstrap();
    if (appState.currentUser) await refreshAdminData();
    alert('تم إنشاء الفعالية الجديدة وتعيينها نشطة.');
  } catch (error) { alert(`تعذر إنشاء الفعالية: ${error.message}`); }
}

function renderBookingFilters() {
  const select = document.getElementById('bookingsEventFilter');
  if (!select) return;
  const previous = select.value;
  select.innerHTML = appState.events.map((event) =>
    `<option value="${escapeHtml(event.id)}">${escapeHtml(event.title)}${event.active ? ' — نشطة' : ''}</option>`).join('');
  select.value = appState.events.some((event) => event.id === previous) ? previous : (getActiveEvent()?.id || '');
  const summary = document.getElementById('eventBookingSummary');
  if (summary) {
    summary.innerHTML = appState.events.map((event) => `
      <div class="glass-card rounded-xl p-4 border border-gold-500/20">
        <p class="text-[11px] text-slate-400">${escapeHtml(event.title)}</p>
        <p class="text-2xl text-gold-300 font-black mt-1">${appState.eventCounts[event.id] || 0}</p>
        <p class="text-[10px] text-slate-500">اسمًا مسجلاً</p>
      </div>`).join('');
  }
}

function renderAdminBookings() {
  const select = document.getElementById('bookingsEventFilter');
  const eventId = select?.value || getActiveEvent()?.id;
  const event = appState.events.find((item) => item.id === eventId);
  const tickets = appState.tickets.filter((ticket) => ticket.eventId === eventId);
  const attended = new Set(appState.attendance.filter((entry) => entry.eventId === eventId).map((entry) => entry.code));
  document.getElementById('bookingsCount').textContent = String(appState.eventCounts[eventId] ?? tickets.length);
  document.getElementById('bookingsEventName').textContent = event?.title || '—';
  document.getElementById('bookingsTableBody').innerHTML = tickets.map((ticket, index) => `
    <tr class="border-b border-slate-800/80 hover:bg-slate-800/40">
      <td class="p-3 text-slate-400">${index + 1}</td>
      <td class="p-3 font-bold text-white">${escapeHtml(ticket.name)}</td>
      <td class="p-3 text-slate-300">${escapeHtml(ticket.stage || 'خدمة عامة')}</td>
      <td class="p-3 text-slate-300">${escapeHtml(ticket.phone || '—')}</td>
      <td class="p-3 font-mono text-gold-300">${escapeHtml(ticket.code)}</td>
      <td class="p-3 text-slate-400">${escapeHtml(formatDate(ticket.createdAt) || '—')}</td>
      <td class="p-3 ${attended.has(ticket.code) ? 'text-emerald-300' : 'text-slate-500'}">${attended.has(ticket.code) ? 'حاضر' : 'لم يحضر بعد'}</td>
    </tr>`).join('') || '<tr><td colspan="7" class="p-8 text-center text-slate-500">لا توجد أسماء مسجلة لهذه الفعالية حتى الآن.</td></tr>';
}

function exportBookingsCSV() {
  const eventId = document.getElementById('bookingsEventFilter').value;
  const event = appState.events.find((item) => item.id === eventId);
  const attendance = new Set(appState.attendance.filter((entry) => entry.eventId === eventId).map((entry) => entry.code));
  const tickets = appState.tickets.filter((ticket) => ticket.eventId === eventId);
  const rows = [['الاسم', 'الخدمة', 'الموبايل', 'كود الدعوة', 'تاريخ الحجز', 'الحضور'], ...tickets.map((ticket) => [
    ticket.name, ticket.stage, ticket.phone, ticket.code, ticket.createdAt, attendance.has(ticket.code) ? 'حاضر' : 'لم يحضر'
  ])];
  const csv = '\ufeff' + rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `حجوزات_${(event?.title || 'فعالية').replace(/[\\/:*?"<>|]/g, '-')}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initScanner() {
  if (!window.Html5QrcodeScanner) {
    const box = document.getElementById('scanResultBox');
    box.classList.remove('hidden');
    box.textContent = 'تعذر تحميل مكتبة الكاميرا. تحقق من الاتصال بالإنترنت.';
    return;
  }
  if (html5QrcodeScanner) return;
  html5QrcodeScanner = new Html5QrcodeScanner('reader', {
    fps: 10,
    qrbox: { width: 230, height: 230 },
    rememberLastUsedCamera: true,
    supportedScanTypes: [Html5QrcodeScanType.SCAN_TYPE_CAMERA]
  }, false);
  html5QrcodeScanner.render(handleScanSuccess, () => {});
}

function handleScanSuccess(decodedText) {
  const code = String(decodedText || '').trim();
  if (code) registerAttendance(code);
}

function handleManualCheckin(event) {
  event.preventDefault();
  const input = document.getElementById('manualCodeInput');
  const code = input.value.trim();
  if (!code) return;
  registerAttendance(code);
  input.value = '';
}

async function registerAttendance(code) {
  const box = document.getElementById('scanResultBox');
  box.classList.remove('hidden');
  try {
    const result = await api('/api/admin/checkins', { method: 'POST', body: { code } });
    appState.attendance.unshift(result.attendance);
    box.className = 'p-3 rounded-xl text-xs font-bold bg-emerald-950 text-emerald-200 border border-emerald-700';
    box.textContent = `تم تسجيل حضور ${result.attendance.name} بنجاح ✓`;
    updateStats();
    renderAttendanceTable();
    renderAdminBookings();
  } catch (error) {
    box.className = `p-3 rounded-xl text-xs font-bold ${error.message.includes('مسبقاً') ? 'bg-amber-950 text-amber-200 border border-amber-700' : 'bg-rose-950 text-rose-200 border border-rose-700'}`;
    box.textContent = error.message;
  }
}

function renderAttendanceTable() {
  const tbody = document.getElementById('attendanceTableBody');
  if (!tbody) return;
  const rows = appState.attendance.filter((entry) => entry.eventId === getActiveEvent()?.id);
  tbody.innerHTML = rows.map((entry, index) => `
    <tr><td class="p-2">${index + 1}</td><td class="p-2">${escapeHtml(entry.name)}</td>
    <td class="p-2">${escapeHtml(entry.stage)}</td><td class="p-2">${escapeHtml(formatDate(entry.time))}</td>
    <td class="p-2 text-emerald-400">حاضر</td></tr>`).join('') || '<tr><td colspan="5" class="p-4 text-center text-slate-500">لم يتم تسجيل حضور بعد.</td></tr>';
}

function exportAttendanceCSV() {
  const event = getActiveEvent();
  const rows = appState.attendance.filter((entry) => entry.eventId === event?.id);
  const csv = '\ufeff' + [['الاسم', 'الخدمة', 'الكود', 'وقت الوصول', 'حضور مبكر'], ...rows.map((entry) => [
    entry.name, entry.stage, entry.code, entry.time, entry.isEarly ? 'نعم' : 'لا'
  ])].map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  downloadText(csv, `سجل_الحضور_${event?.title || 'فعالية'}.csv`, 'text/csv;charset=utf-8;');
}

function downloadText(content, filename, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|]/g, '-');
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function updateStats() {
  const event = getActiveEvent();
  const rows = appState.attendance.filter((entry) => entry.eventId === event?.id);
  document.getElementById('statAttendedCount').textContent = rows.length;
  document.getElementById('statEarlyCount').textContent = `${rows.filter((entry) => entry.isEarly).length} / 40`;
  document.getElementById('statActiveEventName').textContent = event?.title || 'لا توجد فعالية';
  updateRegisteredCount();
}

async function handleLogoUpload(event, type) {
  const file = event.target.files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    alert('حجم الصورة أكبر من 2 ميجابايت. اختر صورة أصغر.');
    event.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      if (type === 'church') {
        const result = await api('/api/admin/church-logo', { method: 'PUT', body: { logo: reader.result } });
        appState.churchLogo = result.churchLogo;
        document.getElementById('churchLogo').src = result.churchLogo;
        document.getElementById('previewChurchLogo').src = result.churchLogo;
      } else {
        const active = getActiveEvent();
        if (!active) return;
        await api(`/api/admin/events/${encodeURIComponent(active.id)}`, { method: 'PUT', body: { logo: reader.result } });
        await refreshBootstrap();
        if (appState.currentUser) await refreshAdminData();
      }
      alert('تم حفظ الشعار.');
    } catch (error) { alert(`تعذر حفظ الشعار: ${error.message}`); }
  };
  reader.readAsDataURL(file);
}

async function addNewAdmin(event) {
  event.preventDefault();
  const username = document.getElementById('newAdminUsername').value.trim();
  const password = document.getElementById('newAdminPassword').value;
  try {
    await api('/api/admin/admins', { method: 'POST', body: { username, password } });
    event.target.reset();
    await refreshAdminData();
    alert('تمت إضافة حساب الأدمن.');
  } catch (error) { alert(`تعذر إضافة الأدمن: ${error.message}`); }
}

async function updateCurrentAdminProfile(event) {
  event.preventDefault();
  const username = document.getElementById('currentAdminNewUsername').value.trim();
  const password = document.getElementById('currentAdminNewPassword').value;
  try {
    const result = await api('/api/admin/profile', { method: 'PUT', body: { username, password } });
    setSignedInUser(result.username);
    document.getElementById('currentAdminNewPassword').value = '';
    await refreshAdminData();
    alert('تم تحديث بيانات الأدمن.');
  } catch (error) { alert(`تعذر تحديث الحساب: ${error.message}`); }
}

function renderAdminsList() {
  const list = document.getElementById('adminsList');
  if (!list) return;
  list.innerHTML = appState.admins.map((admin) => `
    <div class="bg-navy-900 p-2 rounded-lg border border-navy-700 flex justify-between items-center text-xs">
      <span class="text-slate-200 font-bold"><i class="fa-solid fa-user-shield text-gold-500"></i> ${escapeHtml(admin.username)}</span>
      ${appState.admins.length > 1 && admin.username !== appState.currentUser
        ? `<button onclick="removeAdmin('${escapeHtml(admin.username)}')" class="text-crimson-400 font-bold">حذف</button>` : ''}
    </div>`).join('');
}

async function removeAdmin(username) {
  if (!confirm(`هل تريد حذف المشرف ${username}؟`)) return;
  try {
    await api(`/api/admin/admins/${encodeURIComponent(username)}`, { method: 'DELETE' });
    await refreshAdminData();
  } catch (error) { alert(`تعذر حذف المشرف: ${error.message}`); }
}

async function exportFullEventReportPDF() {
  const event = getActiveEvent();
  if (!event) return;
  const attendance = appState.attendance.filter((entry) => entry.eventId === event.id);
  const wrapper = document.getElementById('report-pdf-render-wrapper');
  wrapper.innerHTML = '';
  const report = document.createElement('article');
  report.className = 'event-report-page';
  const heading = document.createElement('header');
  heading.innerHTML = `<h1>تقرير الفعالية الرسمي - كنيسة الأنبا شنودة بالزرابي</h1><h2>${escapeHtml(event.title)}</h2><p>التاريخ: ${escapeHtml(event.date)} | القداس: ${escapeHtml(event.time)}</p>`;
  const stats = document.createElement('p');
  stats.textContent = `إجمالي الحضور: ${attendance.length} | الحضور المبكر: ${attendance.filter((entry) => entry.isEarly).length}`;
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>#</th><th>الاسم</th><th>الخدمة</th><th>وقت الوصول</th></tr></thead>';
  const body = document.createElement('tbody');
  attendance.forEach((entry, index) => {
    const row = document.createElement('tr');
    for (const value of [index + 1, entry.name, entry.stage, formatDate(entry.time)]) {
      const cell = document.createElement('td');
      cell.textContent = String(value ?? '');
      row.appendChild(cell);
    }
    body.appendChild(row);
  });
  table.appendChild(body);
  report.append(heading, stats, table);
  wrapper.appendChild(report);
  try { await renderPdf(wrapper, `تقرير_${event.title.replace(/[\\/:*?"<>|]/g, '-')}.pdf`); }
  catch (error) { alert(`تعذر إنشاء التقرير: ${error.message}`); }
}
