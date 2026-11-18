import test from 'node:test';
import assert from 'node:assert/strict';
import { TransferHistory } from '../public/history.js';

test('duplicate remote transfer IDs cannot overwrite history, memory accounting or download contents', async context => {
  const history = new TransferHistory(100);
  context.after(() => history.clear());
  const first = { id: 'remote-reused-id', key: 'local-first', downloads: [{ blob: new Blob(['FIRST']), name: 'first.txt' }] };
  const second = { id: 'remote-reused-id', key: 'local-second', downloads: [{ blob: new Blob(['SECOND']), name: 'second.txt' }] };
  history.set(first.key, first);
  const firstUrl = history.downloadUrl(first.key, 0);
  history.set(second.key, { ...second, downloads: [] });
  assert.equal(history.remaining(), 95);
  history.set(second.key, second);
  const secondUrl = history.downloadUrl(second.key, 0);
  assert.notEqual(firstUrl, secondUrl);
  assert.equal(history.size, 2);
  assert.equal(history.remaining(), 89);
  assert.equal(await (await fetch(firstUrl)).text(), 'FIRST');
  assert.equal(await (await fetch(secondUrl)).text(), 'SECOND');
  assert.throws(() => history.set(second.id, second), /local transfer key/);
  history.delete(first.key);
  await assert.rejects(fetch(firstUrl));
  assert.equal(history.remaining(), 94);
});

test('replaced blobs and deleted records release object URLs immediately', async context => {
  const history = new TransferHistory(100);
  context.after(() => history.clear());
  const record = { key: 'local-key', downloads: [{ blob: new Blob(['OLD']) }] };
  history.set(record.key, record);
  const oldUrl = history.downloadUrl(record.key, 0);
  record.downloads = [{ blob: new Blob(['NEW']) }];
  history.set(record.key, record);
  await assert.rejects(fetch(oldUrl));
  const newUrl = history.downloadUrl(record.key, 0);
  assert.equal(await (await fetch(newUrl)).text(), 'NEW');
  assert.equal(history.downloadUrl(record.key, 0), newUrl);
  history.clear();
  await assert.rejects(fetch(newUrl));
  assert.equal(history.downloads.size, 0);
  assert.equal(history.remaining(), 100);
});
