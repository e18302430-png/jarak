// In-process event bus feeding Server-Sent Events (dashboard live board + simulator).
import { EventEmitter } from 'node:events';
export const bus = new EventEmitter();
bus.setMaxListeners(1000);
let hook = null;
export const setEmitHook = (fn) => { hook = fn; };
export const emit = (channel, data) => { bus.emit(channel, data); if (hook) { try { hook(channel, data); } catch (e) { /* الإشعار ما يوقف الطلب */ } } };

export function sse(req, res, channel) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 3000\n\n');
  const on = (data) => res.write('data: ' + JSON.stringify(data) + '\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  bus.on(channel, on);
  req.on('close', () => { clearInterval(ping); bus.off(channel, on); });
}
