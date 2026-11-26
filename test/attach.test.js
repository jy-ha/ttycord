import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  contentTypeFor,
  isPathLike,
  looksLikeFileDrop,
  parseAttachmentText,
  pendingAttachmentLabel,
  sniffImageType,
  tokenizeLine,
} from '../src/tui/attach.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ttycord-attach-'));
  const image = join(root, 'shot.png');
  const spaced = join(root, 'my file.txt');
  const nested = join(root, 'notes.md');
  await writeFile(image, Buffer.alloc(1234, 1));
  await writeFile(spaced, 'hello');
  await writeFile(nested, '# notes');
  await mkdir(join(root, 'folder'));
  return { root, image, spaced, nested };
}

test('tokenizeLine honours quotes and backslash escapes', () => {
  assert.deepEqual(tokenizeLine(`'/tmp/a b' "/tmp/c d" /tmp/e`), [
    '/tmp/a b',
    '/tmp/c d',
    '/tmp/e',
  ]);
  assert.deepEqual(tokenizeLine('/tmp/a\\ b.txt'), ['/tmp/a b.txt']);
});

test('parseAttachmentText accepts an absolute file path', async (t) => {
  const { root, image } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const parsed = parseAttachmentText(image);
  assert.equal(parsed.rejected.length, 0);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].path, image);
  assert.equal(parsed.files[0].name, 'shot.png');
  assert.equal(parsed.files[0].size, 1234);
  assert.equal(parsed.files[0].contentType, 'image/png');
});

test('parseAttachmentText accepts file:// URIs and quoted paths with spaces', async (t) => {
  const { root, image, spaced } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  const uri = pathToFileURL(image).href;
  assert.equal(parseAttachmentText(uri).files[0].path, image);

  const quoted = parseAttachmentText(`'${spaced}'`);
  assert.equal(quoted.files.length, 1);
  assert.equal(quoted.files[0].path, spaced);

  // Terminals that do not quote a path still paste it as one line.
  const raw = parseAttachmentText(spaced);
  assert.equal(raw.files[0].path, spaced);
});

test('parseAttachmentText accepts newline-separated lists and expands ~', async (t) => {
  const { root, image, nested } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const parsed = parseAttachmentText(`${image}\n${nested}`);
  assert.deepEqual(
    parsed.files.map((file) => file.name),
    ['shot.png', 'notes.md'],
  );

  const home = parseAttachmentText('~/shot.png', { home: root });
  assert.equal(home.files.length, 1);
  assert.equal(home.files[0].path, image);
});

test('parseAttachmentText rejects missing paths and directories', async (t) => {
  const { root } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  const parsed = parseAttachmentText(`${join(root, 'gone.png')}\n${join(root, 'folder')}`);
  assert.equal(parsed.files.length, 0);
  assert.deepEqual(
    parsed.rejected.map((item) => item.reason),
    ['missing', 'directory'],
  );
});

test('parseAttachmentText leaves ordinary text alone', () => {
  const parsed = parseAttachmentText('안녕하세요, 오늘 뭐 해요?\n두 번째 줄');
  assert.deepEqual(parsed, { files: [], rejected: [] });
  assert.equal(isPathLike('hello'), false);
  assert.equal(isPathLike('/tmp/x'), true);
  assert.equal(isPathLike('file:///tmp/x'), true);
});

test('looksLikeFileDrop accepts path-only pastes', async (t) => {
  const { root, image, nested } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(looksLikeFileDrop(image), true);
  assert.equal(looksLikeFileDrop(`${image}\n${nested}`), true);
  assert.equal(looksLikeFileDrop(`${pathToFileURL(image).href}\n${nested}`), true);
  // Trailing newlines from file managers are ignored.
  assert.equal(looksLikeFileDrop(`${image}\n`), true);
  // A single missing path is still a drop attempt (so it gets a toast).
  assert.equal(looksLikeFileDrop(join(root, 'gone.png')), true);
});

test('looksLikeFileDrop leaves prose and logs alone', async (t) => {
  const { root, image } = await fixture();
  t.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(looksLikeFileDrop('안녕하세요, 오늘 뭐 해요?\n두 번째 줄'), false);
  // A stack trace mentions paths but is not a drop.
  assert.equal(
    looksLikeFileDrop(`에러 로그:\n  at ${join(root, 'app.js')}:12:5`),
    false,
  );
  assert.equal(looksLikeFileDrop('경로는 /usr/bin 입니다'), false);
  // Path plus prose on the same paste: keep it as text.
  assert.equal(looksLikeFileDrop(`첨부할게\n${image}`), false);
  // A multi-line list that resolves to nothing is text, not a broken drop.
  assert.equal(
    looksLikeFileDrop(`${join(root, 'a.png')}\n${join(root, 'b.png')}`),
    false,
  );
});

test('contentTypeFor maps common extensions', () => {
  assert.equal(contentTypeFor('a.PNG'), 'image/png');
  assert.equal(contentTypeFor('a.jfif'), 'image/jpeg');
  assert.equal(contentTypeFor('a.txt'), 'text/plain');
  assert.equal(contentTypeFor('a.bin'), 'application/octet-stream');
});

test('sniffImageType detects screenshots with no useful extension', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ttycord-sniff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const png = join(root, 'screenshot');
  const jpeg = join(root, 'photo.tmp');
  await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]));
  await writeFile(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));

  assert.equal(sniffImageType(png), 'image/png');
  assert.equal(sniffImageType(jpeg), 'image/jpeg');
  assert.equal(sniffImageType(join(root, 'missing')), null);

  const parsed = parseAttachmentText(png);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].contentType, 'image/png');
});

test('pendingAttachmentLabel marks images and files', () => {
  assert.equal(
    pendingAttachmentLabel({ name: 'a.png', size: 2048, contentType: 'image/png' }),
    '[img] a.png (2.0KB)',
  );
  assert.equal(
    pendingAttachmentLabel({ name: 'a.pdf', size: 0, contentType: 'application/pdf' }),
    '[file] a.pdf',
  );
});
