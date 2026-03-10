const nodemailer = require('nodemailer');

const lastSentTimes = new Map();
const RATE_LIMIT_MS = 30 * 60 * 1000; // 30 minutes per recipient

function createTransporter() {
  const host = process.env.SMTP_HOST || 'smtp.gmail.com';
  const port = parseInt(process.env.SMTP_PORT) || 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function isRateLimited(email) {
  const lastSent = lastSentTimes.get(email);
  if (!lastSent) return false;
  return Date.now() - lastSent < RATE_LIMIT_MS;
}

function recordSent(email) {
  lastSentTimes.set(email, Date.now());
}

function buildEmailHtml(matches) {
  const rows = matches
    .map((m) => {
      const scoreColor = m.score >= 80 ? '#10B981' : m.score >= 60 ? '#F59E0B' : '#EF4444';
      const matchedSkills = (m.matchedSkills || []).join(', ') || 'N/A';
      const missingSkills = (m.missingSkills || []).join(', ') || 'N/A';

      return `
        <tr>
          <td style="padding:12px;border-bottom:1px solid #eee">
            <a href="${escapeHtml(m.url || '#')}" style="color:#6366F1;text-decoration:none;font-weight:600">
              ${escapeHtml(m.title || 'Untitled')}
            </a>
            <br><span style="color:#666;font-size:13px">${escapeHtml(m.company || '')}</span>
          </td>
          <td style="padding:12px;border-bottom:1px solid #eee;text-align:center">
            <span style="background:${scoreColor};color:white;padding:3px 10px;border-radius:12px;font-weight:700;font-size:13px">
              ${m.score}%
            </span>
          </td>
          <td style="padding:12px;border-bottom:1px solid #eee;font-size:12px;color:#059669">${escapeHtml(matchedSkills)}</td>
          <td style="padding:12px;border-bottom:1px solid #eee;font-size:12px;color:#999">${escapeHtml(missingSkills)}</td>
        </tr>`;
    })
    .join('');

  return `
    <!DOCTYPE html>
    <html>
    <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;padding:20px">
      <div style="max-width:640px;margin:0 auto;background:white;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <div style="background:#6366F1;padding:20px 24px">
          <h1 style="color:white;margin:0;font-size:20px">Job Matcher</h1>
          <p style="color:rgba(255,255,255,0.8);margin:4px 0 0;font-size:14px">${matches.length} new match${matches.length !== 1 ? 'es' : ''} found</p>
        </div>
        <div style="padding:0 24px 24px">
          <table style="width:100%;border-collapse:collapse;margin-top:16px">
            <thead>
              <tr style="border-bottom:2px solid #eee">
                <th style="text-align:left;padding:8px 12px;font-size:12px;color:#666;text-transform:uppercase">Job</th>
                <th style="text-align:center;padding:8px 12px;font-size:12px;color:#666;text-transform:uppercase">Score</th>
                <th style="text-align:left;padding:8px 12px;font-size:12px;color:#666;text-transform:uppercase">Matched</th>
                <th style="text-align:left;padding:8px 12px;font-size:12px;color:#666;text-transform:uppercase">Missing</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
          <p style="margin-top:20px;font-size:12px;color:#999;text-align:center">
            Sent by Job Matcher Chrome Extension
          </p>
        </div>
      </div>
    </body>
    </html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendMatchNotification(email, matches) {
  if (isRateLimited(email)) {
    return {
      sent: false,
      reason: 'rate_limited',
      retryAfter: RATE_LIMIT_MS - (Date.now() - lastSentTimes.get(email)),
    };
  }

  const transporter = createTransporter();
  if (!transporter) {
    return {
      sent: false,
      reason: 'smtp_not_configured',
      hint: 'Set SMTP_HOST, SMTP_USER, and SMTP_PASS environment variables',
    };
  }

  const topScore = Math.max(...matches.map((m) => m.score));
  const subject = `Job Matcher: ${matches.length} new match${matches.length !== 1 ? 'es' : ''} (top: ${topScore}%)`;

  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: email,
      subject,
      html: buildEmailHtml(matches),
    });

    recordSent(email);
    return { sent: true };
  } catch (err) {
    console.error('Email send error:', err.message);
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

module.exports = { sendMatchNotification };
