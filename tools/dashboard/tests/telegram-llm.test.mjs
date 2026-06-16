import { test } from 'node:test';
import assert from 'node:assert/strict';
import { explainQuestion, mapReplyToDecision } from '../telegram/llm.mjs';

function haikuResponse(payload) {
  return {
    ok: true,
    json: async () => ({ content: [{ text: JSON.stringify(payload) }] }),
  };
}

function fakeFetch(payload) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return haikuResponse(payload);
  };
  fn.calls = calls;
  return fn;
}

const SAMPLE = {
  prompt: 'Which database should we use?',
  options: [
    { n: 1, label: 'SQLite' },
    { n: 2, label: 'PostgreSQL' },
  ],
};

test('explainQuestion returns summary and options from Haiku JSON', async () => {
  const payload = {
    summary: 'The agent is asking which database backend to use.',
    options: [
      { n: 1, label: 'SQLite', blurb: 'Lightweight file database' },
      { n: 2, label: 'PostgreSQL', blurb: 'Full relational server' },
    ],
  };
  const fetchImpl = fakeFetch(payload);
  const result = await explainQuestion(SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  assert.equal(result.summary, payload.summary);
  assert.equal(result.options.length, 2);
  assert.equal(result.options[1].n, 2);
});

test('explainQuestion request body contains the option labels', async () => {
  const fetchImpl = fakeFetch({ summary: 's', options: [] });
  await explainQuestion(SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  const sentBody = fetchImpl.calls[0].init.body;
  assert.match(sentBody, /SQLite/);
  assert.match(sentBody, /PostgreSQL/);
});

test('explainQuestion returns null with no apiKey and never calls fetch', async () => {
  const fetchImpl = fakeFetch({ summary: 's', options: [] });
  const result = await explainQuestion(SAMPLE, { fetchImpl, apiKey: '' });
  assert.equal(result, null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('explainQuestion returns null when fetch throws', async () => {
  const fetchImpl = async () => { throw new Error('network'); };
  const result = await explainQuestion(SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  assert.equal(result, null);
});

test('explainQuestion returns null when fetch aborts', async () => {
  const fetchImpl = async (_url, init) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const result = await explainQuestion(SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  assert.equal(result, null);
});

test('explainQuestion returns null on unparseable JSON', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ content: [{ text: 'not json' }] }) });
  const result = await explainQuestion(SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  assert.equal(result, null);
});

test('mapReplyToDecision maps bare integer without calling fetch', async () => {
  const fetchImpl = fakeFetch({ type: 'option', index: 1 });
  const result = await mapReplyToDecision('2', SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  assert.deepEqual(result, { type: 'option', index: 2 });
  assert.equal(fetchImpl.calls.length, 0);
});

test('mapReplyToDecision maps exact label without calling fetch', async () => {
  const fetchImpl = fakeFetch({ type: 'text', value: 'x' });
  const result = await mapReplyToDecision('PostgreSQL', SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  assert.deepEqual(result, { type: 'option', index: 2 });
  assert.equal(fetchImpl.calls.length, 0);
});

test('mapReplyToDecision maps ambiguous prose via Haiku', async () => {
  const fetchImpl = fakeFetch({ type: 'option', index: 2 });
  const result = await mapReplyToDecision(
    'I think the bigger relational one is best',
    SAMPLE,
    { fetchImpl, apiKey: 'sk-test' },
  );
  assert.deepEqual(result, { type: 'option', index: 2 });
  assert.equal(fetchImpl.calls.length, 1);
});

test('mapReplyToDecision maps freeform text answer via Haiku', async () => {
  const fetchImpl = fakeFetch({ type: 'text', value: 'use MySQL instead' });
  const result = await mapReplyToDecision(
    'actually use MySQL instead',
    SAMPLE,
    { fetchImpl, apiKey: 'sk-test' },
  );
  assert.deepEqual(result, { type: 'text', value: 'use MySQL instead' });
});

test('mapReplyToDecision returns unclear with no key and no deterministic match', async () => {
  const fetchImpl = fakeFetch({ type: 'option', index: 1 });
  const result = await mapReplyToDecision('something vague', SAMPLE, { fetchImpl, apiKey: '' });
  assert.deepEqual(result, { type: 'unclear' });
  assert.equal(fetchImpl.calls.length, 0);
});

test('mapReplyToDecision returns deterministic match even when fetch errors', async () => {
  const fetchImpl = async () => { throw new Error('network'); };
  const result = await mapReplyToDecision('1', SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  assert.deepEqual(result, { type: 'option', index: 1 });
});

test('mapReplyToDecision returns unclear (never throws) when fetch errors and no deterministic match', async () => {
  const fetchImpl = async () => { throw new Error('network'); };
  const result = await mapReplyToDecision('vague prose', SAMPLE, { fetchImpl, apiKey: 'sk-test' });
  assert.deepEqual(result, { type: 'unclear' });
});
