function qs(name) { return new URLSearchParams(location.search).get(name); }
const ticketId = qs('id');
const log = document.getElementById('log');
const input = document.getElementById('input');
const form = document.getElementById('form');
const sendBtn = document.getElementById('sendBtn');
const uploadBtn = document.getElementById('uploadBtn');
const fileInput = document.getElementById('fileInput');
const statusEl = document.getElementById('status');
const ticketIdView = document.getElementById('ticketIdView');

ticketIdView.textContent = `#${ticketId}`;

let lastStatus = 'open';
let lastClaimName = null;

// Custom audio preloading and unlock
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

window.addEventListener('support:setCustomSound', (e) => {
  const url = String(e.detail || '');
  if (url) { localStorage.setItem('supportCustomSound', url); setupCustomSound(); }
});

// Notification sound player
function playBeep() {
  try {
    if (supportAudio) {
      supportAudio.currentTime = 0;
      supportAudio.play().catch(() => {});
      return;
    }
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

function addMessage({ sender, text, ts, by, attachment }) {
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${sender === 'user' ? 'me' : ''} msg-enter`;
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
  const from = sender === 'user' ? 'Вы' : (sender === 'system' ? 'Система' : (by || 'Модератор'));
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

if (!ticketId) {
  (async () => {
    const res = await fetch('/api/tickets/new', { method: 'POST' });
    const data = await res.json();
    if (data.ticketId) location.replace(`/ticket.html?id=${encodeURIComponent(data.ticketId)}`);
  })();
}

const socket = io('/', { query: { role: 'user', ticketId } });

socket.on('ticket:history', ({ messages, status, claimedByName }) => {
  log.innerHTML = '';
  messages.forEach(addMessage);
  updateStatus(status, claimedByName);
});

socket.on('ticket:claimed', ({ by }) => {
  updateStatus('assigned', by);
});

socket.on('message', (msg) => {
  // Play sound for incoming messages (like Telegram)
  if (msg.sender !== 'user') {
    playBeep();
  }
  addMessage(msg);
});

socket.on('ticket:closed', () => {
  updateStatus('closed');
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  document.getElementById('sendBtn')?.classList.add('pulse');
  setTimeout(() => document.getElementById('sendBtn')?.classList.remove('pulse'), 340);
  socket.emit('message', { text });
  input.value = '';
});

function setEnabled(enabled) {
  input.disabled = !enabled;
  sendBtn.disabled = !enabled;
}

function updateStatus(status, claimedByName) {
  const name = claimedByName || lastClaimName || 'Модератор';
  if (status === 'assigned') {
    statusEl.textContent = name ? `Модератор ${name} подключился` : 'Модератор подключился';
    setEnabled(true);
    if (lastStatus !== 'assigned') playBeep();
  } else if (status === 'closed') {
    statusEl.textContent = 'Тикет закрыт';
    setEnabled(false);
    if (lastStatus !== 'closed') playBeep();
  } else {
    statusEl.textContent = 'Ожидание модератора…';
    setEnabled(false);
  }
  if (claimedByName) lastClaimName = claimedByName;
  lastStatus = status;
}

// Poll status periodically as a fallback to ensure auto-refresh without reload
async function poll() {
  try {
    const res = await fetch(`/api/tickets/status?id=${encodeURIComponent(ticketId)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      updateStatus(data.status, data.claimedByName);
    }
  } catch {}
}
setInterval(poll, 3000);

// upload flow
uploadBtn?.addEventListener('click', () => fileInput?.click());
fileInput?.addEventListener('change', async () => {
  if (!fileInput.files || fileInput.files.length === 0) return;
  const file = fileInput.files[0];
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload error');
    // If uploaded audio, set as custom sound
    if (data.isAudio) {
      window.dispatchEvent(new CustomEvent('support:setCustomSound', { detail: data.url }));
    } else {
      socket.emit('message', { attachment: { url: data.url, name: data.name, isImage: !!data.isImage, isText: !!data.isText } });
    }
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
    const files = Array.from(e.dataTransfer?.files || []);
    for (const file of files) {
      const fd = new FormData(); fd.append('file', file);
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload error');
        if (data.isAudio) {
          window.dispatchEvent(new CustomEvent('support:setCustomSound', { detail: data.url }));
        } else {
          socket.emit('message', { attachment: { url: data.url, name: data.name, isImage: !!data.isImage, isText: !!data.isText } });
        }
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

 
