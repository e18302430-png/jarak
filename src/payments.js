// الدفع: «test» للتجربة، و«moyasar» للدفع الحقيقي (مدى، Apple Pay، البطاقات)
const MOYASAR = 'https://api.moyasar.com/v1';
export const paymentMode = () => (process.env.MOYASAR_SECRET_KEY ? 'moyasar' : 'test');
export const onlineEnabled = () => !!process.env.MOYASAR_SECRET_KEY || process.env.ALLOW_TEST_PAY === '1' || process.env.JARAK_NO_TIMERS === '1';
const auth = () => 'Basic ' + Buffer.from(process.env.MOYASAR_SECRET_KEY + ':').toString('base64');

export async function createCheckout(order, baseUrl) {
  if (paymentMode() === 'test') return { mode: 'test' };
  const r = await fetch(MOYASAR + '/invoices', {
    method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(Number(order.quote_total) * 100), currency: 'SAR',
      description: `جارك - طلب #${order.number}`,
      callback_url: baseUrl + '/api/payments/moyasar/webhook',
      success_url: baseUrl + '/#order/' + order.id,
      back_url: baseUrl + '/#cart',
      metadata: { order_id: order.id }
    })
  });
  if (!r.ok) throw new Error('Moyasar ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const inv = await r.json();
  return { mode: 'moyasar', url: inv.url, ref: inv.id };
}

// يتأكد من الفاتورة مباشرة من Moyasar (ما نعتمد على كلام الـwebhook لحاله)
export async function verifyInvoice(invoiceId) {
  const r = await fetch(MOYASAR + '/invoices/' + encodeURIComponent(invoiceId), { headers: { Authorization: auth() } });
  if (!r.ok) throw new Error('Moyasar ' + r.status);
  const inv = await r.json();
  const paid = (inv.payments || []).find(p => p.status === 'paid');
  return { status: inv.status, amount: inv.amount / 100, paymentId: paid && paid.id, orderId: inv.metadata && inv.metadata.order_id };
}

export async function refund(order, amount) {
  if (amount <= 0) return { skipped: true };
  if (order.payment_method === 'cod' || order.payment_method === 'tab') return { mode: order.payment_method, amount }; // ينقص من المبلغ اللي يندفع
  if (paymentMode() === 'test' || !order.payment_ref) return { mode: 'test', amount };
  const inv = await verifyInvoice(order.payment_ref);
  if (!inv.paymentId) throw new Error('ما لقينا عملية الدفع');
  const r = await fetch(MOYASAR + '/payments/' + inv.paymentId + '/refund', {
    method: 'POST', headers: { Authorization: auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: Math.round(amount * 100) })
  });
  if (!r.ok) throw new Error('Moyasar refund ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}
