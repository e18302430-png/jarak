// فلوس الطلب: نرجّع للعميل أي فرق تلقائياً (ضمان السعر، منتج ناقص، بديل أرخص، شكوى، تأخير)
import { q, one } from './db.js';
import { refund } from './payments.js';
import { emit } from './events.js';
import { round2, money } from './util.js';

// what the customer should end up paying for this order
export async function targetTotal(order) {
  const parts = await q(`select * from order_parts where order_id=$1 and status <> 'cancelled'`, [order.id]);
  let sub = 0;
  for (const p of parts) for (const it of p.items) {
    if (it.status === 'ok') sub += it.customer_price * it.qty;
    else if (it.status === 'sub') sub += it.sub.customer_price * it.qty;
  }
  sub = round2(sub);
  const fee = sub > 0 ? Number(order.delivery_fee) : 0;
  const discount = Math.min(Number(order.discount), sub + fee);
  return { subtotal: sub, fee, discount, total: round2(sub + fee - discount) };
}

// refund whatever was paid above the target; idempotent
export async function settleRefunds(orderId, reason) {
  const order = await one('select * from orders where id=$1', [orderId]);
  if (!order || order.payment_status !== 'paid') return 0;
  const t = await targetTotal(order);
  const due = round2(Number(order.paid_amount) - Number(order.refunded_amount) - t.total);
  if (due < 0.01) { await q('update orders set final_total=$2 where id=$1', [orderId, t.total]); return 0; }
  await refund(order, due);
  await q('update orders set refunded_amount = refunded_amount + $2, final_total = $3 where id=$1', [orderId, due, t.total]);
  await q(`insert into ledger (kind, order_id, amount, note) values ('refund', $1, $2, $3)`, [orderId, -due, reason || null]);
  const txt = order.payment_method === 'tab' ? `نقصنا ${money(due)} ريال من دفترك${reason ? ' (' + reason + ')' : ''}` : order.payment_method === 'cod' ? `نقصنا ${money(due)} ريال من المبلغ اللي تدفعه للمندوب${reason ? ' (' + reason + ')' : ''}` : `رجعنا لك ${money(due)} ريال${reason ? ' (' + reason + ')' : ''}`;
  emit('order:' + orderId, { type: 'refund', amount: due, reason, text: txt });
  return due;
}
