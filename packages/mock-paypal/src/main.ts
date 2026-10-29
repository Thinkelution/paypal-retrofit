import path from 'node:path';
import { createMockPayPal } from './index.ts';

const port = Number(process.env.MOCK_PAYPAL_PORT ?? 8788);
const publicUrl = process.env.MOCK_PAYPAL_PUBLIC_URL ?? `http://localhost:${port}`;
const dataFile = process.env.MOCK_PAYPAL_DATA ?? path.resolve('.retrofit', 'mock-paypal.json');
const { app } = createMockPayPal({ publicUrl, dataFile });
app.listen(port, () => console.log(`mock-paypal listening on ${publicUrl} (state: ${dataFile})`));
