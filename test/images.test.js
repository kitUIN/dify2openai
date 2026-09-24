import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fetch, { Response } from 'node-fetch';

const imagePart = (url) => ({ type: 'image_url', image_url: { url } });
const textPart = (text) => ({ type: 'text', text });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const dataUrl = `data:image/png;base64,${png.toString('base64')}`;

async function fixture(t, env = {}) {
  const requests = [];
  const uploads = [];
  const state = { uploadStatus: 201, chatStatus: 200, uploadBody: { id: 'uploaded-image' } };
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (req.url === '/v1/files/upload') {
      const form = await new Response(bytes, { headers: req.headers }).formData();
      uploads.push({ user: form.get('user'), file: form.get('file'), authorization: req.headers.authorization });
      res.writeHead(state.uploadStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state.uploadBody));
      return;
    }
    requests.push({ path: req.url, body: JSON.parse(bytes), authorization: req.headers.authorization });
    if (state.chatStatus !== 200) {
      res.writeHead(state.chatStatus, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'File rejected' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('data: {"event":"message","answer":"image received","created_at":1}\n\n' +
      'data: {"event":"message_end","created_at":1,"metadata":{"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}}\n\n');
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    "import http from 'node:http'; const listen = http.Server.prototype.listen; http.Server.prototype.listen = function (...args) { this.once('listening', () => process.send({ port: this.address().port })); return listen.apply(this, args); }; await import('./app.js');"], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, DIFY_API_URL: `http://127.0.0.1:${upstream.address().port}/v1/`, PORT: '0', BOT_TYPE: 'Chat', INPUT_VARIABLE: '', OUTPUT_VARIABLE: '', MAX_REQUEST_SIZE: '50mb', ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  const { port } = await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`App exited (${code}): ${stderr}`)));
  });
  const send = (messages, extra = {}) => fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
    body: JSON.stringify({ model: 'dify', messages, ...extra }),
    signal: AbortSignal.timeout(5000),
  });
  return { requests, uploads, state, send };
}

test('text and remote images are separated, including replayed history', async t => {
  const f = await fixture(t);
  const response = await f.send([
    { role: 'user', content: [textPart('previous'), imagePart('https://example.com/old.png')] },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: [textPart('Compare'), imagePart('https://example.com/new.png'), textPart('these')] },
  ]);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'image received');
  assert.equal(f.requests[0].body.query, "here is our talk history:\n'''\nuser: previous\nassistant: Earlier answer\n'''\n\nhere is my question:\nCompare\nthese");
  assert.deepEqual(f.requests[0].body.files, ['old', 'new'].map(name => ({
    type: 'image', transfer_method: 'remote_url', url: `https://example.com/${name}.png`,
  })));
  assert.equal(f.uploads.length, 0);
});

test('Base64 uploads preserve bytes, MIME, authorization and end user; streaming works', async t => {
  const f = await fixture(t);
  const response = await f.send([{ role: 'user', content: [imagePart(dataUrl)] }], { stream: true, user: 'image-user' });
  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /image received/);
  assert.match(stream, /data: \[DONE\]/);
  const upload = f.uploads[0];
  assert.equal(upload.user, 'image-user');
  assert.equal(upload.authorization, 'Bearer test-key');
  assert.equal(upload.file.type, 'image/png');
  assert.equal(upload.file.name, 'image.png');
  assert.deepEqual(Buffer.from(await upload.file.arrayBuffer()), png);
  assert.equal(f.requests[0].body.user, upload.user);
  assert.deepEqual(f.requests[0].body.files, [{ type: 'image', transfer_method: 'local_file', upload_file_id: 'uploaded-image' }]);
  assert.doesNotMatch(f.requests[0].body.query, /object Object|base64/);
});

test('mixed multiple images and payloads larger than 100 KB reach Dify', async t => {
  const f = await fixture(t);
  const large = Buffer.alloc(150 * 1024, 42);
  const response = await f.send([{ role: 'user', content: [
    textPart('Inspect'), imagePart(dataUrl), imagePart('https://example.com/image.jpg'),
    imagePart(`data:image/png;base64,${large.toString('base64')}`),
  ] }]);
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(f.uploads.length, 2);
  assert.equal(f.uploads[1].file.size, large.length);
  assert.equal(f.requests[0].body.files.length, 3);
});

test('plain text and configured inputs remain compatible', async t => {
  const f = await fixture(t, { INPUT_VARIABLE: 'prompt' });
  const response = await f.send([{ role: 'user', content: 'Hello' }]);
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(f.requests[0].body.inputs.prompt, f.requests[0].body.query);
  assert.equal(f.requests[0].body.files, undefined);
  assert.equal(f.requests[0].body.user, 'apiuser');
});

for (const botType of ['Completion', 'Workflow']) {
  test(`${botType} converts the final message and its files`, async t => {
    const f = await fixture(t, { BOT_TYPE: botType, INPUT_VARIABLE: 'prompt' });
    const response = await f.send([
      { role: 'user', content: [imagePart('https://example.com/old.png')] },
      { role: 'user', content: [textPart('Describe'), imagePart('https://example.com/current.png')] },
    ]);
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(f.requests[0].path, botType === 'Workflow' ? '/v1/workflows/run' : '/v1/completion-messages');
    assert.equal(f.requests[0].body.inputs.prompt, 'Describe');
    assert.equal(f.requests[0].body.files.length, 1);
    assert.equal(f.requests[0].body.files[0].url, 'https://example.com/current.png');
  });
}

test('invalid input returns 400 without contacting Dify', async t => {
  const f = await fixture(t);
  for (const messages of [[], [{ role: 'user', content: {} }],
    [{ role: 'user', content: [imagePart('file:///image.png')] }],
    [{ role: 'user', content: [imagePart('data:image/png;base64,!!!')] }],
    [{ role: 'user', content: [imagePart('data:image/png;base64,A')] }],
    [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }],
  ]) {
    const response = await f.send(messages);
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.message);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(f.uploads.length, 0);
});

test('upload and upstream failures return errors instead of hanging', async t => {
  const f = await fixture(t);
  f.state.uploadStatus = 413;
  let response = await f.send([{ role: 'user', content: [imagePart(dataUrl)] }]);
  assert.equal(response.status, 413);
  assert.match((await response.json()).error.message, /upload failed/);
  assert.equal(f.requests.length, 0);
  f.state.uploadStatus = 201;
  f.state.uploadBody = {};
  response = await f.send([{ role: 'user', content: [imagePart(dataUrl)] }]);
  assert.equal(response.status, 502);
  await response.json();
  assert.equal(f.requests.length, 0);
  f.state.chatStatus = 400;
  response = await f.send([{ role: 'user', content: [imagePart('https://example.com/image.png')] }], { stream: true });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /Dify request failed/);
});
