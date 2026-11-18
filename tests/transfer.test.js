import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { TransferEngine } from '../public/transfer.js';
import { MEMORY_LIMIT } from '../public/protocol.js';
import { TransferHistory } from '../public/history.js';

async function until(predicate, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for transfer');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function pair({ accept = true, memory = MEMORY_LIMIT, directory = null } = {}) {
  const sent = new Map();
  const received = new Map();
  let incoming;
  let peakInFlight = 0;
  const noop = () => {};
  const sender = new TransferEngine({ signal: noop, onTransfer: record => sent.set(record.id, record), onOffer: noop, onPeerState: noop, onError: noop, memoryAvailable: () => MEMORY_LIMIT });
  const receiver = new TransferEngine({ signal: noop, onTransfer: record => received.set(record.id, record), onOffer: offer => {
    incoming = offer;
    if (accept) queueMicrotask(() => receiver.accept(offer.id, directory).catch(noop));
  }, onPeerState: noop, onError: noop, memoryAvailable: () => memory });
  sender.id = 'sender';
  receiver.id = 'receiver';
  sender.peers.add('receiver');
  receiver.peers.add('sender');
  const first = { readyState: 'open', bufferedAmount: 0 };
  const second = { readyState: 'open', bufferedAmount: 0 };
  first.send = data => {
    if (first.readyState !== 'open') throw new Error('Closed');
    if (data instanceof ArrayBuffer) peakInFlight = Math.max(peakInFlight, sender.active.transferred - sender.active.acknowledged + data.byteLength);
    const copy = data instanceof ArrayBuffer ? data.slice(0) : data;
    setImmediate(() => { if (second.readyState === 'open') second.onmessage({ data: copy }); });
  };
  second.send = data => setImmediate(() => { if (first.readyState === 'open') first.onmessage({ data }); });
  first.close = () => {
    first.readyState = 'closed';
    second.readyState = 'closed';
    second.onclose?.();
  };
  second.close = () => {
    second.readyState = 'closed';
    first.readyState = 'closed';
    first.onclose?.();
  };
  function attach(engine, peerId, channel) {
    const link = { peerId, connection: { close: noop }, closed: false, dataTail: Promise.resolve(), open: { reject: noop, resolve: noop } };
    link.open.promise = Promise.resolve(link);
    engine.links.set(peerId, link);
    engine.bindChannel(link, channel);
    engine.ensure = () => link;
    return link;
  }
  const senderLink = attach(sender, 'receiver', first);
  const receiverLink = attach(receiver, 'sender', second);
  return { sender, receiver, sent, received, senderLink, receiverLink, incoming: () => incoming, peak: () => peakInFlight, cleanup() { sender.closeAll(); receiver.closeAll(); } };
}

test('multi-file transfer preserves bytes, handles empty files and waits for receipt', async context => {
  const fixture = pair();
  context.after(() => fixture.cleanup());
  const payload = new Uint8Array(900000).map((value, index) => index % 251);
  await fixture.sender.sendFiles('receiver', [new File([payload], '照片.bin'), new File([], 'empty.txt')]);
  await until(() => [...fixture.sent.values()][0]?.status === 'completed');
  const received = [...fixture.received.values()][0];
  assert.equal(received.status, 'completed');
  assert.equal(received.downloads.length, 2);
  assert.deepEqual(new Uint8Array(await received.downloads[0].blob.arrayBuffer()), payload);
  assert.equal(received.downloads[1].blob.size, 0);
  assert.ok(fixture.peak() <= 256 * 1024);
  assert.equal(fixture.sender.active, null);
  assert.equal(fixture.receiver.active, null);
});

test('a file is not sent until the receiving device accepts', async context => {
  const fixture = pair({ accept: false });
  context.after(() => fixture.cleanup());
  await fixture.sender.sendFiles('receiver', [new File(['hello'], 'hello.txt')]);
  await until(() => fixture.incoming());
  assert.equal(fixture.sender.active.transferred, 0);
  assert.equal(fixture.receiver.active.transferred, 0);
  fixture.receiver.decline(fixture.incoming().id);
  await until(() => [...fixture.sent.values()][0]?.status === 'rejected');
  assert.equal(fixture.receiver.active, null);
});

test('insufficient receiver memory refuses acceptance without receiving bytes', async context => {
  const fixture = pair({ accept: false, memory: 2 });
  context.after(() => fixture.cleanup());
  await fixture.sender.sendFiles('receiver', [new File(['hello'], 'hello.txt')]);
  await until(() => fixture.incoming());
  await assert.rejects(fixture.receiver.accept(fixture.incoming().id), /空间不足/);
  assert.equal(fixture.sender.active.transferred, 0);
  fixture.receiver.decline(fixture.incoming().id);
});

test('disk receiving streams data and avoids overwriting existing names', async context => {
  const stored = new Map([['hello.txt', new Uint8Array([99])]]);
  const directory = { async getFileHandle(name, options) {
    if (!stored.has(name) && !options?.create) throw Object.assign(new Error('Missing'), { name: 'NotFoundError' });
    return { async createWritable() {
      const chunks = [];
      return { async write(data) { await new Promise(resolve => setTimeout(resolve, 1)); chunks.push(new Uint8Array(data)); }, async close() {
        const result = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
        stored.set(name, result);
      }, async abort() {} };
    } };
  } };
  const fixture = pair({ memory: 0, directory });
  context.after(() => fixture.cleanup());
  const payload = new Uint8Array(400000).fill(42);
  await fixture.sender.sendFiles('receiver', [new File([payload], 'hello.txt')]);
  await until(() => [...fixture.sent.values()][0]?.status === 'completed');
  assert.deepEqual(stored.get('hello.txt'), new Uint8Array([99]));
  assert.deepEqual(stored.get('hello (1).txt'), payload);
  assert.deepEqual([...fixture.received.values()][0].downloads, [{ name: 'hello (1).txt', saved: true }]);
  assert.ok(fixture.peak() <= 256 * 1024);
});

test('cancelling releases active state and stops the connection', async context => {
  const fixture = pair({ accept: false });
  context.after(() => fixture.cleanup());
  await fixture.sender.sendFiles('receiver', [new File(['hello'], 'hello.txt')]);
  await until(() => fixture.incoming());
  fixture.sender.cancel();
  assert.equal([...fixture.sent.values()][0].status, 'cancelled');
  assert.equal(fixture.sender.active, null);
  assert.equal(fixture.receiver.active, null);
  assert.equal(fixture.senderLink.closed, true);
});

test('unsolicited binary data is rejected', async context => {
  const fixture = pair({ accept: false });
  context.after(() => fixture.cleanup());
  await assert.rejects(fixture.receiver.handleData(fixture.receiverLink, new ArrayBuffer(1)), /未确认/);
});

test('receiver rejects a truncated file instead of marking it completed', async context => {
  const fixture = pair({ accept: false });
  context.after(() => fixture.cleanup());
  const link = fixture.receiverLink;
  const id = 'truncated';
  await fixture.receiver.handleData(link, JSON.stringify({ type: 'offer', id, files: [{ name: 'file', size: 5 }] }));
  await fixture.receiver.accept(id);
  await fixture.receiver.handleData(link, JSON.stringify({ type: 'file-start', id, index: 0 }));
  await fixture.receiver.handleData(link, new ArrayBuffer(2));
  await assert.rejects(fixture.receiver.handleData(link, JSON.stringify({ type: 'file-end', id, index: 0 })), /未完整/);
});

test('a malicious peer cannot queue unlimited unprocessed messages', context => {
  const fixture = pair({ accept: false });
  context.after(() => fixture.cleanup());
  fixture.receiverLink.channel.onmessage({ data: new ArrayBuffer(2 * 1024 * 1024) });
  assert.equal(fixture.receiverLink.closed, true);
});

test('a malicious sender cannot overwrite completed downloads by reusing wire IDs', async context => {
  const fixture = pair({ accept: false });
  const history = new TransferHistory(100);
  context.after(() => { fixture.cleanup(); history.clear(); });
  fixture.receiver.onTransfer = record => history.set(record.key, record);
  fixture.receiver.memoryAvailable = () => history.remaining();
  const id = 'reused-id';
  const keys = [];
  for (const content of ['FIRST', 'SECOND']) {
    const control = message => fixture.receiver.handleData(fixture.receiverLink, JSON.stringify({ id, ...message }));
    await control({ type: 'offer', files: [{ name: `${content}.txt`, size: content.length }] });
    const key = fixture.receiver.active.key;
    keys.push(key);
    await fixture.receiver.accept(id, null, key);
    await control({ type: 'file-start', index: 0 });
    await fixture.receiver.handleData(fixture.receiverLink, new TextEncoder().encode(content).buffer);
    await control({ type: 'file-end', index: 0 });
    await control({ type: 'batch-end' });
    assert.equal(fixture.receiver.active, null);
  }
  assert.notEqual(keys[0], keys[1]);
  assert.equal(history.size, 2);
  assert.equal(history.remaining(), 89);
  assert.equal(await (await fetch(history.downloadUrl(keys[0], 0))).text(), 'FIRST');
  assert.equal(await (await fetch(history.downloadUrl(keys[1], 0))).text(), 'SECOND');
});

test('stale acceptance or rejection cannot apply to a replacement offer with the same wire ID', async context => {
  const fixture = pair({ accept: false });
  context.after(() => fixture.cleanup());
  const id = 'repeated-id';
  const offer = JSON.stringify({ type: 'offer', id, files: [{ name: 'file.txt', size: 1 }] });
  await fixture.receiver.handleData(fixture.receiverLink, offer);
  const oldKey = fixture.receiver.active.key;
  fixture.receiver.decline(id, oldKey);
  await fixture.receiver.handleData(fixture.receiverLink, offer);
  const newKey = fixture.receiver.active.key;
  await fixture.receiver.accept(id, null, oldKey);
  fixture.receiver.decline(id, oldKey);
  assert.equal(fixture.receiver.active.key, newKey);
  assert.equal(fixture.receiver.active.status, 'waiting');
  await fixture.receiver.accept(id, null, newKey);
  assert.equal(fixture.receiver.active.status, 'running');
});
