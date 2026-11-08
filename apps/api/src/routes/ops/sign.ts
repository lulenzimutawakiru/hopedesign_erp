import { Router } from 'express';
import pg from 'pg';
import { tx, Ctx } from '../../db.js';
import { requirePermission } from '../../middleware/authorize.js';
import { asyncHandler } from '../../utils.js';
import { sendEmail } from '../../services/bird.js';
import * as sign from '../../services/signRequests.js';

export const signOpsRouter = Router();

type OpFn = (
  client: pg.PoolClient,
  ctx: Ctx,
  body: Record<string, unknown>,
  params: Record<string, string>
) => Promise<unknown>;

const run = (permission: string, fn: OpFn) => [
  requirePermission(permission),
  asyncHandler(async (req, res) => {
    const out = await tx(
      (client) => fn(client, req.ctx, req.body ?? {}, req.params as Record<string, string>),
      req.ctx
    );
    res.json({ data: out });
  }),
];

const reasonOf = (b: Record<string, unknown>): string | null =>
  b.reason != null && String(b.reason).trim().length > 0 ? String(b.reason) : null;

interface ExternalDelivery {
  email: string;
  name: string;
  signUrl: string;
  title: string;
  code: string;
}

/** Best-effort email delivery, run after the transaction commits. */
async function deliverExternal(deliveries: (ExternalDelivery | null | undefined)[]): Promise<void> {
  for (const d of deliveries) {
    if (!d) continue;
    await sendEmail({
      to: [d.email],
      subject: 'Signing requested: ' + d.title,
      text:
        'Hello ' + d.name + ',\n\n' +
        'You have been asked to sign "' + d.title + '" (' + d.code + ').\n\n' +
        'Open the link to review and sign the document:\n' + d.signUrl + '\n\n' +
        'This link is personal and should not be shared.',
      button: { label: 'Review & sign', url: d.signUrl },
    });
  }
}

signOpsRouter.get('/dashboard', requirePermission('sign.sign_requests.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => sign.signRequestDashboard(client, req.ctx), req.ctx);
  res.json({ data: out });
}));

signOpsRouter.get('/', requirePermission('sign.sign_requests.view'), asyncHandler(async (req, res) => {
  const out = await tx((client) => sign.listSignRequests(client, req.ctx, {
    status: req.query.status != null && String(req.query.status).length > 0 ? String(req.query.status) : null,
  }), req.ctx);
  res.json({ data: out });
}));

signOpsRouter.post('/', ...run('sign.sign_requests.create', (c, ctx, b) => sign.createSignRequest(c, ctx, b)));
signOpsRouter.get('/:id/detail', ...run('sign.sign_requests.view', (c, ctx, _b, p) => sign.getSignRequestDetail(c, ctx, Number(p.id))));
signOpsRouter.patch('/:id', ...run('sign.sign_requests.update', (c, ctx, b, p) => sign.updateSignRequest(c, ctx, Number(p.id), b)));
signOpsRouter.delete('/:id', ...run('sign.sign_requests.delete', (c, ctx, _b, p) => sign.deleteSignRequest(c, ctx, Number(p.id))));

// Send: token issuance + status change commit first, then external emails are
// dispatched after COMMIT so the transaction is never held open on the provider.
signOpsRouter.post('/:id/send', requirePermission('sign.sign_requests.send'), asyncHandler(async (req, res) => {
  const out = await tx((client) => sign.sendSignRequest(client, req.ctx, Number(req.params.id)), req.ctx);
  const result = out as { externalDeliveries?: ExternalDelivery[] };
  await deliverExternal(result.externalDeliveries ?? []);
  res.json({ data: out });
}));

signOpsRouter.post('/:id/revoke', ...run('sign.sign_requests.revoke', (c, ctx, b, p) => sign.revokeSignRequest(c, ctx, Number(p.id), reasonOf(b))));
signOpsRouter.post('/:id/sign', ...run('sign.sign_requests.sign', (c, ctx, b, p) => sign.signInternally(c, ctx, Number(p.id), b)));

signOpsRouter.post('/signers/:signerId/resend', requirePermission('sign.sign_requests.send'), asyncHandler(async (req, res) => {
  const out = await tx((client) => sign.resendSigner(client, req.ctx, Number(req.params.signerId)), req.ctx);
  const result = out as { externalDelivery?: ExternalDelivery | null };
  await deliverExternal([result.externalDelivery ?? null]);
  res.json({ data: out });
}));
