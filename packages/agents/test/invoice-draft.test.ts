import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen } from '../../core/test/helpers.ts';
import type { IntakeContext } from '../../core/src/index.ts';
import { draftInvoice } from '../src/index.ts';

const ctx: IntakeContext = {
  business: 'Brightside Plumbing',
  currency: 'USD',
  today: '2026-10-30',
  usualTermsDays: 14,
  customers: [{ key: '7', name: 'Elmwood Day School', email: 'g.elmwood@example.com' }],
  products: [],
};

/** A stand-in for the Messages API that reads a "photo" of a job sheet. */
async function fakeClaude() {
  const app = express();
  const requests: any[] = [];
  app.post('/v1/messages', express.json({ limit: '10mb' }), (req, res) => {
    requests.push(req.body);
    res.json({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: req.body.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1200, output_tokens: 90 },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            customer: { knownKey: '7', name: 'Elmwood Day Sch.', email: null },
            lines: [
              { description: 'Unblock staff room sink', qty: 1, unitPrice: 165 },
              { description: 'Labour', qty: 1.5, unitPrice: 95 },
            ],
            dueDate: null,
            dueInDays: 30,
            notes: 'Job 2231, 14 Elm Ave',
            questions: ['The labour hours could read 1.5 or 7.5.'],
          }),
        },
      ],
    });
  });
  const server = await listen(app);
  return { ...server, requests };
}

describe('snap a job sheet', () => {
  let claude: Awaited<ReturnType<typeof fakeClaude>>;
  beforeAll(async () => {
    claude = await fakeClaude();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ANTHROPIC_BASE_URL = claude.url;
  });
  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await claude.close();
  });

  it('sends the photo to Claude with the known customers and returns a draft to check', async () => {
    const draft = await draftInvoice({ image: { data: 'aGVsbG8=', mediaType: 'image/jpeg' } }, ctx);
    expect(draft).toMatchObject({
      engine: 'claude',
      customer: { key: '7', name: 'Elmwood Day School', email: 'g.elmwood@example.com' },
      lines: [
        { description: 'Unblock staff room sink', qty: 1, unitPrice: 165 },
        { description: 'Labour', qty: 1.5, unitPrice: 95 },
      ],
      due: '2026-11-29',
      notes: 'Job 2231, 14 Elm Ave',
    });
    expect(draft.questions[0]).toMatch(/1\.5 or 7\.5/);
    const body = claude.requests[0];
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config.format.type).toBe('json_schema');
    const [image, text] = body.messages[0].content;
    expect(image).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' },
    });
    expect(text.text).toContain('Elmwood Day School');
  });
});
