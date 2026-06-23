import { config, isWhatsAppConfigured } from '../config.js';

export { isWhatsAppConfigured };

function toWaNumber(mobile: string): string {
  const d = mobile.replace(/\D/g, '');
  return d.length === 10 ? `91${d}` : d;
}

export interface SendOutcome {
  ok: boolean;
  id?: string;
  error?: string;
}

/**
 * Sends a WhatsApp text via the Meta Cloud API. Returns ok:false (never throws)
 * when unconfigured or on failure, so callers can fall back to manual sending.
 */
export async function sendWhatsAppMessage(mobile: string, message: string): Promise<SendOutcome> {
  if (!isWhatsAppConfigured()) return { ok: false, error: 'WhatsApp API not configured.' };

  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.whatsapp.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: toWaNumber(mobile),
        type: 'text',
        text: { body: message },
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `WhatsApp send failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ''}` };
    }
    const data = (await res.json().catch(() => ({}))) as { messages?: { id?: string }[] };
    return { ok: true, id: data.messages?.[0]?.id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
