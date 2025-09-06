const modal = document.getElementById('modal');
const btnModerator = document.getElementById('btnModerator');
const btnCreateTicket = document.getElementById('btnCreateTicket');

btnModerator?.addEventListener('click', () => {
  modal.style.display = 'flex';
  document.getElementById('code').focus();
});

document.getElementById('cancelModal')?.addEventListener('click', () => {
  modal.style.display = 'none';
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') modal.style.display = 'none';
});

async function registerModerator() {
  const code = document.getElementById('code').value.trim();
  const displayName = document.getElementById('displayName').value.trim();
  const error = document.getElementById('modalError');
  error.style.display = 'none';
  try {
    const res = await fetch('/api/moderator/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, displayName })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    localStorage.setItem('moderatorToken', data.token);
    localStorage.setItem('moderatorName', data.displayName);
    window.location.href = '/moderator.html';
  } catch (e) {
    error.textContent = e.message;
    error.style.display = 'block';
  }
}

document.getElementById('submitCode')?.addEventListener('click', registerModerator);

btnCreateTicket?.addEventListener('click', async () => {
  const res = await fetch('/api/tickets/new', { method: 'POST' });
  const data = await res.json();
  if (data.ticketId) {
    window.location.href = `/ticket.html?id=${encodeURIComponent(data.ticketId)}`;
  }
}); 