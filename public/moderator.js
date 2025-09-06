const token = localStorage.getItem('moderatorToken');
const modName = localStorage.getItem('moderatorName') || 'Модератор';
const queueEl = document.getElementById('queue');
const refreshBtn = document.getElementById('refresh');
const activeTicketEl = document.getElementById('activeTicket');
const statusEl = document.getElementById('status');
const log = document.getElementById('log');
const input = document.getElementById('input');
const form = document.getElementById('form');
const closeBtn = document.getElementById('closeTicket');
const sendBtn = document.getElementById('send');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');

document.getElementById('modName').textContent = modName;

if (!token) {
  alert('Нет токена модератора. Войдите заново.');
  location.href = '/';
}

// Notification sound (same as user)
let supportAudio = null;
function setupCustomSound() {
  const url = localStorage.getItem('supportCustomSound');
  if (!url) { supportAudio = null; return; }
  try {
    supportAudio = new Audio(url);
    supportAudio.volume = 0.85;
    const unlock = () => {
      supportAudio.play().then(() => supportAudio.pause()).catch(() => {});
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  } catch {}
}
setupCustomSound();
function playBeep() {
  try {
    if (supportAudio) { supportAudio.currentTime = 0; supportAudio.play().catch(() => {}); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain(); master.gain.value = 0.08; master.connect(ctx.destination);
    const tones = [523.25, 659.25, 783.99];
    const now = ctx.currentTime;
    tones.forEach((f, i) => {
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.3 / tones.length, now + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
      o.connect(g); g.connect(master); o.start(now + i * 0.005); o.stop(now + 0.92);
    });
  } catch {}
}

let socket;
let activeTicketId = null;

function ticketItem(t) {
  const el = document.createElement('div');
  el.className = 'tile';
  el.innerHTML = `<div><div style="font-weight:700">#${t.id}</div><div class="meta">${new Date(t.createdAt).toLocaleTimeString()}</div></div>`;
  const btn = document.createElement('button');
  btn.className = 'btn btn-accent';
  btn.textContent = t.status === 'assigned' ? 'Открыть' : 'Принять';
  btn.onclick = async () => {
    if (t.status !== 'assigned') {
      const res = await fetch('/api/tickets/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ticketId: t.id })
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Не удалось принять тикет');
        return;
      }
      t.status = 'assigned';
    }
    joinTicket(t.id);
  };
  el.appendChild(btn);
  return el;
}

async function loadQueue() {
  queueEl.innerHTML = '<div class="meta" style="padding:8px;">Загрузка…</div>';
  const res = await fetch('/api/tickets', { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await res.json();
  queueEl.innerHTML = '';
  if (!data.tickets || data.tickets.length === 0) {
    queueEl.innerHTML = '<div class="empty">Нет открытых тикетов</div>';
    return;
  }
  data.tickets.forEach(t => queueEl.appendChild(ticketItem(t)));
}

refreshBtn.addEventListener('click', loadQueue);

function ensureSocket() {
  if (socket) return;
  socket = io('/', { query: { role: 'moderator', token } });
  socket.on('moderator:ready', () => console.log('connected as moderator'));
  socket.on('ticket:new', (t) => {
    // prepend new ticket
    queueEl.prepend(ticketItem({ ...t, status: 'open' }));
    try { playBeep(); } catch {}
  });
  socket.on('ticket:updated', (t) => {
    // Update queue button text without reload
    const items = Array.from(queueEl.querySelectorAll('.tile'));
    const tile = items.find(el => el.textContent && el.textContent.includes(`#${t.id}`));
    if (!tile) return;
    const btn = tile.querySelector('button');
    if (btn) {
      if (t.status === 'assigned') btn.textContent = 'Открыть';
      if (t.status === 'closed') { btn.textContent = 'Закрыт'; btn.disabled = true; }
    }
  });
  socket.on('ticket:history', ({ messages }) => {
    log.classList.remove('empty');
    log.innerHTML = '';
    messages.forEach(addMessage);
  });
  socket.on('message', addMessage);
  socket.on('ticket:closed', () => {
    statusEl.textContent = 'Тикет закрыт';
    input.disabled = true;
    sendBtn.disabled = true;
    closeBtn.disabled = true;
  });
}

function addMessage({ sender, text, ts, by, attachment }) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${sender === 'moderator' ? 'me' : ''} msg-enter`;
  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = `<div>${escapeHtml(text || '')}</div>`;
  if (attachment && attachment.url) {
    const a = document.createElement('div');
    a.className = 'attach';
    if (attachment.isImage) {
      const img = document.createElement('img');
      img.src = attachment.url; img.alt = attachment.name || '';
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', () => openImageLightbox(img.src));
      a.appendChild(img);
    } else if (attachment.isText) {
      const link = document.createElement('a');
      link.href = attachment.url; link.target = '_blank'; link.rel = 'noreferrer';
      link.textContent = attachment.name || 'Текстовый файл';
      link.style.cursor = 'zoom-in';
      const open = (e) => { e?.preventDefault?.(); openTextLightbox(attachment.url, attachment.name); };
      link.addEventListener('click', open);
      a.addEventListener('click', open);
      a.appendChild(link);
    } else {
      const link = document.createElement('a');
      link.href = attachment.url; link.target = '_blank'; link.rel = 'noreferrer';
      link.textContent = attachment.name || 'Файл';
      a.appendChild(link);
    }
    bubble.appendChild(a);
  }
  const meta = document.createElement('div');
  meta.className = 'meta';
  const from = sender === 'moderator' ? (by || modName) : (sender === 'system' ? 'Система' : 'Игрок');
  meta.textContent = `${from} • ${new Date(ts).toLocaleTimeString()}`;
  bubble.appendChild(meta);
  wrapper.appendChild(bubble);
  log.appendChild(wrapper);
  log.scrollTop = log.scrollHeight;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function joinTicket(id) {
  ensureSocket();
  activeTicketId = id;
  activeTicketEl.textContent = `#${id}`;
  statusEl.textContent = 'Соединение…';
  input.disabled = false;
  sendBtn.disabled = false;
  closeBtn.disabled = false;
  log.innerHTML = '';
  socket.emit('mod:join', { ticketId: id });
  statusEl.textContent = 'В чате';
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (!activeTicketId) return;
  const text = input.value.trim();
  if (!text) return;
  sendBtn.classList.add('pulse');
  setTimeout(() => sendBtn.classList.remove('pulse'), 340);
  socket.emit('message', { ticketId: activeTicketId, text });
  input.value = '';
});

closeBtn.addEventListener('click', async () => {
  if (!activeTicketId) return;
  const res = await fetch('/api/tickets/close', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ ticketId: activeTicketId })
  });
  if (res.ok) {
    activeTicketId = null;
    input.disabled = true; sendBtn.disabled = true; closeBtn.disabled = true;
    statusEl.textContent = 'Тикет закрыт';
  }
});

loadQueue();
ensureSocket();

// upload flow
uploadBtn?.addEventListener('click', () => fileInput?.click());
fileInput?.addEventListener('change', async () => {
  if (!activeTicketId) return;
  if (!fileInput.files || fileInput.files.length === 0) return;
  const file = fileInput.files[0];
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload error');
    socket.emit('message', { ticketId: activeTicketId, attachment: { url: data.url, name: data.name, isImage: !!data.isImage, isText: !!data.isText } });
  } catch (e) {
    alert(e.message);
  } finally {
    fileInput.value = '';
  }
});

// drag & drop
(function setupDnd(){
  const dz = document.getElementById('dropzone');
  let counter = 0;
  function open() { dz?.classList.add('open'); }
  function close() { dz?.classList.remove('open'); }
  window.addEventListener('dragenter', (e) => { e.preventDefault(); counter++; open(); });
  window.addEventListener('dragleave', (e) => { e.preventDefault(); counter = Math.max(0, counter - 1); if (counter === 0) close(); });
  window.addEventListener('dragover', (e) => { e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    e.preventDefault(); counter = 0; close();
    if (!activeTicketId) return;
    const files = Array.from(e.dataTransfer?.files || []);
    for (const file of files) {
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload error');
        socket.emit('message', { ticketId: activeTicketId, attachment: { url: data.url, name: data.name, isImage: !!data.isImage, isText: !!data.isText } });
      } catch (err) { console.error(err); }
    }
  });
})();

// lightbox helpers
function openImageLightbox(src) {
  const lb = document.getElementById('lightbox');
  const img = lb.querySelector('img');
  img.style.display = 'block';
  const pre = lb.querySelector('pre');
  if (pre) pre.remove();
  img.src = src;
  lb.classList.add('open');
}
async function openTextLightbox(url, name) {
  const lb = document.getElementById('lightbox');
  const img = lb.querySelector('img');
  img.style.display = 'none';
  let pre = lb.querySelector('pre');
  if (!pre) { pre = document.createElement('pre'); lb.appendChild(pre); }
  pre.textContent = 'Загрузка…';
  lb.classList.add('open');
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const text = await res.text();
    pre.textContent = text;
  } catch (e) {
    pre.textContent = 'Не удалось загрузить файл';
  }
}
function closeLightbox() {
  const lb = document.getElementById('lightbox');
  lb.classList.remove('open');
}
(function setupLightbox(){
  const lb = document.getElementById('lightbox');
  lb?.addEventListener('click', (e) => {
    if (e.target.tagName !== 'IMG' && e.target.tagName !== 'PRE') closeLightbox();
  });
  lb?.querySelector('.lightbox-close')?.addEventListener('click', closeLightbox);
})(); 