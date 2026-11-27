export function emailConfigured() {
  return Boolean(process.env.EMAIL_API_KEY && process.env.EMAIL_FROM);
}

export async function sendEmail({ to, subject, html, text }) {
  if (!emailConfigured()) return { sent: false, reason: 'not_configured' };
  const providerUrl = process.env.EMAIL_PROVIDER_URL || 'https://api.resend.com/emails';
  const response = await fetch(providerUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.EMAIL_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, html, text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Email provider returned ${response.status}: ${detail.slice(0, 300)}`);
  }
  return { sent: true };
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}
