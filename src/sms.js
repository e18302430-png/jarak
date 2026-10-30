// رسائل SMS لرموز الدخول. اختر مزوّد سعودي واحد وحط بياناته في متغيرات السيرفر:
//   taqnyat  : TAQNYAT_TOKEN, TAQNYAT_SENDER
//   unifonic : UNIFONIC_APPSID, UNIFONIC_SENDER
//   msegat   : MSEGAT_USER, MSEGAT_APIKEY, MSEGAT_SENDER
// «dev» للتطوير على جهازك بس: يكتب الرمز في سجل السيرفر وما يرسل شي.
export const smsProvider = () => process.env.SMS_PROVIDER || 'dev';
const intl = (phone) => String(phone).replace(/^\+/, '');

export async function sendSms(phone, body) {
  const provider = smsProvider();
  if (provider === 'dev') { console.log(`[sms:dev] ${phone}: ${body}`); return { dev: true }; }
  let r;
  if (provider === 'taqnyat') {
    r = await fetch('https://api.taqnyat.sa/v1/messages', {
      method: 'POST', headers: { Authorization: 'Bearer ' + process.env.TAQNYAT_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipients: [intl(phone)], body, sender: process.env.TAQNYAT_SENDER })
    });
  } else if (provider === 'unifonic') {
    r = await fetch('https://el.cloud.unifonic.com/rest/SMS/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ AppSid: process.env.UNIFONIC_APPSID || '', SenderID: process.env.UNIFONIC_SENDER || '', Body: body, Recipient: intl(phone) })
    });
  } else if (provider === 'msegat') {
    r = await fetch('https://www.msegat.com/gw/sendsms.php', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userName: process.env.MSEGAT_USER, apiKey: process.env.MSEGAT_APIKEY, userSender: process.env.MSEGAT_SENDER, numbers: intl(phone), msg: body, msgEncoding: 'UTF8' })
    });
  } else throw new Error('SMS_PROVIDER غير معروف: ' + provider);
  if (!r.ok) throw new Error('SMS ' + provider + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json().catch(() => ({ ok: true }));
}
