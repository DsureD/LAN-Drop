import test from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SIZE, MEMORY_LIMIT, MAX_FILES, getMemoryLimit, formatBytes, safeFilename, validateOffer, deviceCode } from '../public/protocol.js';

const offer = files => ({ type: 'offer', id: 'transfer-123', files });

test('metadata accepts empty files and preserves Unicode names', () => {
  assert.deepEqual(validateOffer(offer([{ name: '照片.jpg', size: 0, mime: 'image/jpeg' }])), { id: 'transfer-123', total: 0, files: [{ name: '照片.jpg', size: 0, mime: 'image/jpeg' }] });
});

test('invalid sizes, IDs and oversized queues are rejected', () => {
  for (const size of [-1, 1.5, Infinity, '12', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => validateOffer(offer([{ name: 'file', size }])));
  assert.throws(() => validateOffer({ ...offer([]), id: '<invalid>' }));
  assert.throws(() => validateOffer(offer(Array.from({ length: MAX_FILES + 1 }, () => ({ name: 'file', size: 1 })))));
  assert.throws(() => validateOffer(offer([{ name: 'a', size: Number.MAX_SAFE_INTEGER }, { name: 'b', size: 1 }])));
});

test('filenames cannot escape the selected directory', () => {
  assert.equal(safeFilename('../../secret.txt'), 'secret.txt');
  assert.equal(safeFilename('C:\\Users\\secret.txt'), 'secret.txt');
  assert.equal(safeFilename('a\u0000:b?.txt'), 'a__b_.txt');
  assert.equal(safeFilename('CON.txt'), 'file-CON.txt');
  assert.equal(safeFilename('..'), 'file-unnamed');
});

test('protocol has conservative chunks and an explicit memory cap', () => {
  assert.equal(CHUNK_SIZE, 16384);
  assert.equal(MEMORY_LIMIT, 536870912);
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(NaN), '0 B');
});

test('memory budget uses valid server configuration and defaults to 512 MiB', () => {
  for (const config of [undefined, null, {}, { memoryLimitBytes: 0 }, { memoryLimitBytes: -1 }, { memoryLimitBytes: 1.5 }, { memoryLimitBytes: '1024' }, { memoryLimitBytes: Infinity }, { memoryLimitBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.equal(getMemoryLimit(config), MEMORY_LIMIT);
  }
  for (const limit of [128 * 1024 * 1024, 1024 * 1024 * 1024]) {
    assert.equal(getMemoryLimit({ memoryLimitBytes: limit }), limit);
  }
});

test('filename normalization prevents direction-based extension disguises and trailing dots after truncation', () => {
  for (const control of ['\u061c', '\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069']) {
    assert.equal(safeFilename(`photo${control}gnp.exe`), 'photo_gnp.exe');
  }
  assert.equal(safeFilename('a'.repeat(179) + '.more'), 'a'.repeat(179));
  assert.equal(safeFilename('e\u0301.txt'), 'é.txt');
});

test('device verification codes use server connection identities rather than names', () => {
  assert.equal(deviceCode('12345678-1234-4123-8123-123456789abc'), '1234-5678-1234');
  assert.notEqual(deviceCode('12345678-1234-4123-8123-123456789abc'), deviceCode('12345678-1235-4123-8123-123456789abc'));
  assert.equal(deviceCode('<script>'), '尚未连接');
});
