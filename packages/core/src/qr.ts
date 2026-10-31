import QRCode from 'qrcode';
import type { Retrofit } from './engine.ts';

/**
 * A QR code for a PayPal invoice, for paper invoices, job sheets and printed statements: scanning it opens
 * PayPal's pay page on the customer's phone. Uses PayPal's own QR endpoint; if that is unavailable, the same
 * pay link is encoded locally.
 */
export async function invoiceQr(
  rf: Retrofit,
  legacyPk: string,
  size = 300,
): Promise<{ png: Buffer; source: 'paypal' | 'local'; payLink: string | null }> {
  const link = rf.state.getLink('invoice', legacyPk);
  if (!link) throw new Error('This invoice is not in PayPal yet.');
  try {
    return {
      png: await rf.paypal.invoiceQrCode(link.paypalId, { size }),
      source: 'paypal',
      payLink: link.payLink,
    };
  } catch (e) {
    if (!link.payLink) throw e;
    return {
      png: await QRCode.toBuffer(link.payLink, { width: size, margin: 1 }),
      source: 'local',
      payLink: link.payLink,
    };
  }
}
