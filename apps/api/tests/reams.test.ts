 import { describe, it, expect } from 'vitest';
 import { api, auth, loginAs, db } from './helpers.js';
 
 interface ReamGenerated {
   id: number;
   reamNo: string;
   qrId: number;
   code: string;
   secret: string;
   payload: string;
 }
 
 interface CartonMember {
   reamId: number;
   reamNo: string;
   qrId: number;
   code: string;
 }
 
 interface SealedCarton {
   cartonId: number;
   cartonNo: string;
   qrId: number;
   code: string;
   secret: string;
   payload: string;
   reams: CartonMember[];
 }
 
 const scalar = async (sql: string, params: unknown[] = []) => {
   const res = await db(sql, params);
   return Number(res.rows[0]?.value ?? 0);
 };
 
 describe('Ream authenticity, carton sealing and Niimbot label spool', () => {
  it('generates unique ream QRs, posts to inventory, packs 5 into one carton and verifies publicly', async () => {
    const { token } = await loginAs('admin');

    // Clear label-spool leftovers from prior runs: fetchSpool returns the oldest
    // GENERATED labels, so stale rows would crowd out the label created below.
    await db(`DELETE FROM qr_labels`);
    await db(`DELETE FROM label_print_jobs`);

    // 0. Create a fresh production batch so every assertion is scoped and repeatable.
     const batch = await api
       .post('/api/qr/batches')
       .set(auth(token))
       .send({ productId: 3, quantity: 5, lotNo: 'REAM-TEST' });
     expect(batch.status).toBe(201);
     const batchId = Number(batch.body.data.id);
     expect(batchId).toBeGreaterThan(0);
 
     // 1. Generate exactly 5 unique ream QRs for the A4-80 REAM product (id 3).
     const gen = await api
       .post('/api/qr/reams/generate')
       .set(auth(token))
       .send({ productId: 3, batchId, count: 5 });
     expect(gen.status).toBe(200);
     const reams: ReamGenerated[] = gen.body.data;
     expect(reams).toHaveLength(5);
     const codes = new Set(reams.map((r) => r.code));
     expect(codes.size).toBe(5);
     for (const r of reams) {
       expect(r.reamNo).toBeTruthy();
       expect(typeof r.qrId).toBe('number');
       expect(r.payload).toBe(`${r.code}|${r.secret}`);
     }
 
     // 2. Inventory: every generated ream lands in stock as a PRODUCTION_OUTPUT move.
     const stock = await scalar(
       `SELECT COALESCE(SUM(quantity), 0) AS value FROM inventory WHERE product_id = 3 AND batch_id = $1`,
       [batchId]
     );
     expect(stock).toBe(5);
     const prodMoves = await scalar(
       `SELECT count(*) AS value FROM inventory_movements
        WHERE product_id = 3 AND batch_id = $1 AND movement_type = 'PRODUCTION_OUTPUT' AND reference_type = 'reams'`,
       [batchId]
     );
     expect(prodMoves).toBe(5);
     // The ream QR's own ledger trace includes the production move.
     const trace = await api.get(`/api/qr/traceability/${reams[0].code}`).set(auth(token));
     expect(trace.status).toBe(200);
    expect(
      trace.body.data.movements.some(
        (m: { movementType?: string; referenceType?: string }) =>
          m.movementType === 'PRODUCTION_OUTPUT' && m.referenceType === 'reams'
      )
    ).toBe(true);
 
     // 3. Scan each ream on the packing line - must come back AUTHENTIC.
     for (const r of reams) {
       const scan = await api.post('/api/qr/packing/scan').set(auth(token)).send({ code: r.code });
       expect(scan.status).toBe(200);
       expect(scan.body.data.result).toBe('AUTHENTIC');
       expect(typeof scan.body.data.scanId).toBe('number');
       expect(scan.body.data.ream.reamNo).toBe(r.reamNo);
     }
 
     // 4. Seal the 5 reams into one carton; a unique carton QR is minted.
     const seal = await api
       .post('/api/qr/packing/seal')
       .set(auth(token))
       .send({ productId: 3, batchId, reamCodes: reams.map((r) => r.code) });
     expect(seal.status).toBe(200);
     const carton: SealedCarton = seal.body.data;
     expect(carton.cartonId).toBeGreaterThan(0);
     expect(carton.cartonNo).toBeTruthy();
     expect(carton.code).toBeTruthy();
     expect(carton.payload).toBe(`${carton.code}|${carton.secret}`);
     expect(carton.reams).toHaveLength(5);
     expect(new Set(carton.reams.map((r) => r.code))).toEqual(codes);
 
     // 5. Inventory: sealing is a net-zero serialized conversion - ISSUE 5, RECEIPT 5.
     const stockAfter = await scalar(
       `SELECT COALESCE(SUM(quantity), 0) AS value FROM inventory WHERE product_id = 3 AND batch_id = $1`,
       [batchId]
     );
     expect(stockAfter).toBe(5);
     const cartonMoves = await db(
       `SELECT movement_type, quantity FROM inventory_movements
        WHERE product_id = 3 AND batch_id = $1 AND reference_type = 'cartons' ORDER BY id`,
       [batchId]
     );
     expect(cartonMoves.rows).toHaveLength(2);
     expect(cartonMoves.rows.map((r) => r.movement_type).sort()).toEqual(['ISSUE', 'RECEIPT']);
     for (const row of cartonMoves.rows) expect(Number(row.quantity)).toBe(5);
     const sealedCartons = await scalar(
       `SELECT count(*) AS value FROM cartons WHERE batch_id = $1 AND status = 'SEALED'`,
       [batchId]
     );
     expect(sealedCartons).toBe(1);
 
     // 6. Packing summary reflects the live stock picture for the batch.
     const summary = await api.get(`/api/qr/packing/summary?productId=3&batchId=${batchId}`).set(auth(token));
     expect(summary.status).toBe(200);
     expect(summary.body.data).toMatchObject({
       productId: 3,
       batchId,
       onHand: 5,
       looseReams: 0,
       packedReams: 5,
       cartonsSealed: 1,
     });
 
     // 7. Public portal: ream -> AUTHENTIC + carton link; carton -> AUTHENTIC + 5 members.
     const reamVerify = await api.post('/api/public/verify').send({ payload: reams[0].payload });
     expect(reamVerify.status).toBe(200);
     expect(reamVerify.body.data.result).toBe('AUTHENTIC');
     expect(reamVerify.body.data.ream.ream_no).toBe(reams[0].reamNo);
     expect(reamVerify.body.data.ream.carton_no).toBe(carton.cartonNo);
 
     const cartonVerify = await api.post('/api/public/verify').send({ payload: carton.payload });
     expect(cartonVerify.status).toBe(200);
     expect(cartonVerify.body.data.result).toBe('AUTHENTIC');
     expect(cartonVerify.body.data.carton.carton_no).toBe(carton.cartonNo);
     expect(cartonVerify.body.data.carton.members).toHaveLength(5);
     // The ream we verified just above is flagged as verified inside the carton.
     expect(cartonVerify.body.data.carton.members[0].verified).toBe(true);
     // Public portal must never leak secrets.
     expect(cartonVerify.body.data).not.toHaveProperty('secret');
     expect(reamVerify.body.data).not.toHaveProperty('secret_hash');
 
     // 8. Reams already packed cannot be sealed again -> 409 conflict.
     const dup = await api
       .post('/api/qr/packing/seal')
       .set(auth(token))
       .send({ productId: 3, batchId, reamCodes: reams.map((r) => r.code) });
     expect(dup.status).toBe(409);
 
     // 9. Spool the carton label for the Niimbot bridge.
     const spool = await api
       .post('/api/qr/labels/spool')
       .set(auth(token))
       .send({ items: [{ qrId: carton.qrId, payload: carton.payload }] });
     expect(spool.status).toBe(200);
     const job = spool.body.data;
     expect(job.jobNo).toBeTruthy();
     expect(job.labels).toHaveLength(1);
     const label = job.labels[0];
     expect(label.id).toBeGreaterThan(0);
     expect(label.code).toBe(carton.code);
     expect(label.imageDataUrl.startsWith('data:image/png;base64,')).toBe(true);
 
     // 10. Bridge polling sees the queued label and can acknowledge it as printed.
     const poll = await api.get('/api/qr/labels/spool?limit=10').set(auth(token));
     expect(poll.status).toBe(200);
     const queued = poll.body.data.find((l: { id: number }) => Number(l.id) === Number(label.id));
     expect(queued).toBeTruthy();
     expect(queued.label_status).toBe('GENERATED');
     // First poll reports the pre-claim status; claiming advances the job to PRINTING.
     expect(queued.job_status).toBe('QUEUED');
 
     const claim = await api.get('/api/qr/labels/spool?limit=10').set(auth(token));
     const claimed = claim.body.data.find((l: { id: number }) => Number(l.id) === Number(label.id));
     expect(claimed?.job_status).toBe('PRINTING');
 
     const printed = await api.post(`/api/qr/labels/${label.id}/printed`).set(auth(token));
     expect(printed.status).toBe(200);
     expect(printed.body.data.label_no).toBe(label.labelNo);
   });
 });
