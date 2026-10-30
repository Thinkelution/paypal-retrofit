import { claudeConfigured, writeDigestNote } from '@paypal-retrofit/agents';
import {
  actionLinkSecret,
  buildDigest,
  businessTimezone,
  digestDue,
  nextDigestAt,
  publicBaseUrl,
  renderDigest,
  signActionToken,
  type DigestData,
  type DigestDelivery,
  type RenderedDigest,
  type Retrofit,
} from '@paypal-retrofit/core';
import nodemailer from 'nodemailer';

export interface DigestChannels {
  email: { configured: boolean; to: string[]; from: string | null; reason: string | null };
  slack: { configured: boolean };
}

export function digestChannels(rf: Retrofit): DigestChannels {
  const to = rf.config.digest.to;
  const smtp = Boolean(rf.config.env.smtpUrl);
  return {
    email: {
      configured: smtp && to.length > 0,
      to,
      from: rf.config.env.digestFrom ?? rf.config.business.email ?? null,
      reason: !smtp ? 'Set RETROFIT_SMTP_URL' : to.length ? null : 'Add digest.to in retrofit.config.yaml',
    },
    slack: { configured: Boolean(rf.config.env.slackWebhookUrl) },
  };
}

export interface DigestPreview {
  data: DigestData;
  rendered: RenderedDigest;
  baseUrl: string | null;
}

/** Builds and renders the digest. With Claude configured (and ai not false) the opening note is written by Claude. */
export async function prepareDigest(
  rf: Retrofit,
  opts: { ai?: boolean; baseUrl?: string; now?: Date } = {},
): Promise<DigestPreview> {
  const data = await buildDigest(rf, { now: opts.now });
  if (opts.ai !== false && claudeConfigured()) {
    try {
      data.note = await writeDigestNote(data);
    } catch (e) {
      rf.log.warn(`digest note not written by Claude: ${(e as Error).message}`);
    }
  }
  const baseUrl = (opts.baseUrl ?? publicBaseUrl(rf.config))?.replace(/\/$/, '') ?? null;
  const secret = actionLinkSecret(rf);
  const rendered = renderDigest(data, {
    baseUrl: baseUrl ?? undefined,
    approveUrl: baseUrl ? (id) => `${baseUrl}/a/${signActionToken(secret, id)}` : undefined,
  });
  return { data, rendered, baseUrl };
}

/** Builds the digest, delivers it to every configured channel and records it in the outbox. */
export async function sendDigest(
  rf: Retrofit,
  opts: { trigger?: 'schedule' | 'manual'; ai?: boolean; baseUrl?: string } = {},
) {
  const { rendered, data } = await prepareDigest(rf, opts);
  const ch = digestChannels(rf);
  const deliveries: DigestDelivery[] = [];

  if (ch.email.configured) {
    try {
      const transport = nodemailer.createTransport(rf.config.env.smtpUrl!);
      const info = await transport.sendMail({
        from: ch.email.from ?? `paypal-retrofit <no-reply@localhost>`,
        to: ch.email.to.join(', '),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
      deliveries.push({
        channel: 'email',
        status: 'sent',
        detail: `To ${ch.email.to.join(', ')} (${info.messageId})`,
      });
    } catch (e) {
      deliveries.push({ channel: 'email', status: 'failed', detail: (e as Error).message });
    }
  } else
    deliveries.push({ channel: 'email', status: 'skipped', detail: ch.email.reason ?? 'Not configured' });

  if (ch.slack.configured) {
    try {
      const r = await fetch(rf.config.env.slackWebhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(rendered.slack),
      });
      deliveries.push(
        r.ok
          ? { channel: 'slack', status: 'sent', detail: 'Posted to the Slack webhook' }
          : {
              channel: 'slack',
              status: 'failed',
              detail: `Slack answered ${r.status}: ${(await r.text()).slice(0, 120)}`,
            },
      );
    } catch (e) {
      deliveries.push({ channel: 'slack', status: 'failed', detail: (e as Error).message });
    }
  } else deliveries.push({ channel: 'slack', status: 'skipped', detail: 'Set RETROFIT_SLACK_WEBHOOK_URL' });

  deliveries.push({ channel: 'outbox', status: 'sent', detail: 'Saved in the console outbox' });
  const id = rf.state.addDigest({
    trigger: opts.trigger ?? 'manual',
    subject: rendered.subject,
    deliveries,
    html: rendered.html,
    text: rendered.text,
  });
  rf.state.setMeta('digest.lastSentAt', data.generatedAt);
  rf.emit('digest', { id });
  rf.log.info(`digest ${id}: ${deliveries.map((d) => `${d.channel} ${d.status}`).join(', ')}`);
  return { id, subject: rendered.subject, deliveries };
}

export function digestSchedule(rf: Retrofit) {
  const d = rf.config.digest;
  const tz = businessTimezone(rf);
  const last = rf.state.getMeta('digest.lastSentAt');
  return {
    enabled: d.enabled,
    time: d.time,
    timezone: tz,
    weekdaysOnly: d.weekdaysOnly,
    lastSentAt: last ?? null,
    nextAt: d.enabled ? nextDigestAt(d.time, tz, d.weekdaysOnly, last) : null,
  };
}

/** Called every minute by the server: sends the scheduled digest once per local day. */
export async function runScheduledDigest(rf: Retrofit, now = new Date()) {
  const d = rf.config.digest;
  if (!d.enabled) return null;
  if (!digestDue(d.time, businessTimezone(rf), d.weekdaysOnly, rf.state.getMeta('digest.lastSentAt'), now))
    return null;
  return sendDigest(rf, { trigger: 'schedule' });
}
