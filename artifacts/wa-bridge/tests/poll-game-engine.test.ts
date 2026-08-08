// ============================================================
// Poll Game Engine — Tests
//
// Covers: WYR + Quiz flows, native timed-poll events, vote
// decryption (using the fork's real decryptPollVote against
// cryptographically-valid encrypted votes), vote security
// (unknown / expired / cross-group / ambiguous votes), per-group
// isolation, cleanup and snapshot restore.
// ============================================================

import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createPollGameEngine, PollGameEngine, GameAI, type PollEvent } from '../src/whatsapp/games/poll-engine/index.js';
import { hmacSign, aesEncryptGCM } from '@crysnovax/baileys/lib/Utils/crypto.js';

const scopeA = { sessionId: 'session-a', chatJid: '111@g.us' };
const scopeB = { sessionId: 'session-a', chatJid: '222@g.us' };
const meId = '9999999999@s.whatsapp.net';
const p1 = '1111111111@s.whatsapp.net';
const p2 = '2222222222@s.whatsapp.net';

/**
 * Fake AI with canned JSON (exercises GameAI's real JSON parsing).
 * The mock is prompt-aware: WYR prompts get WYR content, quiz prompts
 * get quiz content — so any number of repeated calls stay correct.
 */
function makeAi(wyrContent: unknown, quizContent: unknown): GameAI {
  return new GameAI({
    getConfig: () => ({ apiKey: 'test-key', model: 'grok-2-latest' }),
    fetchImpl: (async (_url, init) => {
      const bodyText = String((init as { body?: unknown } | undefined)?.body ?? '');
      const isQuiz = bodyText.includes('quiz master');
      const content = isQuiz ? quizContent : wyrContent;
      const body = JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] });
      return {
        ok: true,
        status: 200,
        text: async () => body,
        json: async () => JSON.parse(body),
      } as unknown as Response;
    }) as typeof fetch,
  });
}

/** Collect emitted events from a started game. */
function collect(events: PollEvent[]): { polls: PollEvent[]; texts: string[] } {
  return {
    polls: events.filter((e) => e.poll),
    texts: events.filter((e) => e.text).map((e) => e.text!),
  };
}

/**
 * Build a cryptographically-valid encrypted vote for the given option
 * name — mirrors the fork's decryptPollVote inputs exactly.
 */
async function makeVote(
  pollMsgId: string,
  pollEncKey: Buffer,
  voterJid: string,
  optionName: string,
  creatorJid: string = meId
): Promise<{ encPayload: Buffer; encIv: Buffer }> {
  const sign = Buffer.concat([
    Buffer.from(pollMsgId),
    Buffer.from(creatorJid),
    Buffer.from(voterJid),
    Buffer.from('Poll Vote'),
    new Uint8Array([1]),
  ]);
  const key0 = hmacSign(pollEncKey, new Uint8Array(32), 'sha256');
  const decKey = hmacSign(sign, key0, 'sha256');
  const aad = Buffer.from(`${pollMsgId}\u0000${voterJid}`);
  const digest = crypto.createHash('sha256').update(Buffer.from(optionName, 'utf8')).digest();
  const { WAProto } = await import('@crysnovax/baileys');
  const plaintext = WAProto.Message.PollVoteMessage.encode({ selectedOptions: [digest] }).finish();
  const encIv = crypto.randomBytes(12);
  const encPayload = aesEncryptGCM(plaintext, decKey, encIv, aad);
  return { encPayload, encIv };
}

/** Start a WYR and return [engine, pollEvent, gameId]. */
async function startWyr(): Promise<{ engine: PollGameEngine; poll: PollEvent; gameId: string }> {
  const engine = createPollGameEngine({
    ai: makeAi(
      { question: 'Would you rather fly or teleport?', optionA: 'Fly', optionB: 'Teleport' },
      { questions: [] }
    ),
  });
  const events = await engine.start(scopeA, 'wyr', [], {
    onEvent: async () => undefined,
  });
  const { polls } = collect(events);
  assert.equal(polls.length, 1);
  const poll = polls[0]!;
  return { engine, poll, gameId: poll.gameId };
}

test('WYR start produces a native timed-poll event with decryption secret', async () => {
  const { engine, poll } = await startWyr();
  assert.equal(poll.poll?.name, 'Would you rather fly or teleport?');
  assert.deepEqual(poll.poll?.values, ['Fly', 'Teleport']);
  assert.equal(poll.poll?.selectableCount, 1);
  // Native timed poll: endDate must be set (fork maps to poll endTime).
  assert.ok(poll.poll?.endDate instanceof Date);
  assert.ok(poll.poll?.endDate!.getTime() > Date.now());
  assert.ok(poll.poll?.messageSecret && poll.poll.messageSecret.length === 32);
  assert.match(poll.text ?? '', /𝗪𝗢𝗨𝗟𝗗 𝗬𝗢𝗨 𝗥𝗔𝗧𝗛𝗘𝗥|𝗪 𝗢 𝗨 𝗟 𝗗/);
  assert.match(poll.text ?? '', /𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭/);
  engine.dispose();
});

test('WYR duration and interval are separate: default 5min game, one poll per 60s', async () => {
  const engine = createPollGameEngine({ ai: makeAi({ question: 'q', optionA: 'a', optionB: 'b' }, { questions: [] }) });
  const start = async (args: string[]) => {
    const events = await engine.start(scopeA, 'wyr', args, { onEvent: async () => undefined });
    const { polls, texts } = collect(events);
    return { polls, texts };
  };

  const def = await start([]);
  const defMs = def.polls[0]?.poll?.endDate!.getTime()! - Date.now();
  assert.ok(defMs >= 55_000 && defMs <= 65_000, `default should be ~60s, got ${defMs}ms`);
  await engine.expireNow(scopeA); // first poll closes; the default game continues
  assert.ok(engine.hasActive(scopeA, 'wyr'));
  engine.dispose();

  const min = await start(['1min']);
  const minMs = min.polls[0]?.poll?.endDate!.getTime()! - Date.now();
  assert.ok(minMs >= 55_000 && minMs <= 65_000, `1min game should use 60s interval, got ${minMs}ms`);
  engine.getGame(scopeA, 'wyr')!.endsAt = Date.now() - 1;
  await engine.expireNow(scopeA); // total duration reached: game finishes
  assert.ok(!engine.hasActive(scopeA, 'wyr'));

  const twoMin = await start(['2min']);
  const twoMs = twoMin.polls[0]?.poll?.endDate!.getTime()! - Date.now();
  assert.ok(twoMs >= 55_000 && twoMs <= 65_000, `2min game should still use 60s interval, got ${twoMs}ms`);
  await engine.expireNow(scopeA);
  assert.ok(engine.hasActive(scopeA, 'wyr'), '2min game continues for its second interval');
  engine.dispose();

  // Below minimum → usage event, no poll.
  const bad = await start(['30s']);
  assert.equal(bad.polls.length, 0);
  assert.match(bad.texts.join('\n'), /Usage: .wyr/);

  // Garbage → usage event.
  const garbage = await start(['abc']);
  assert.equal(garbage.polls.length, 0);
  assert.match(garbage.texts.join('\n'), /Usage: .wyr/);

  engine.dispose();
});

test('WYR: votes are decrypted, attributed, and a native-table result is emitted on expiry', async () => {
  const engine = createPollGameEngine({
    ai: makeAi({ question: 'Would you rather be rich or famous?', optionA: 'Rich', optionB: 'Famous' }, { questions: [] }),
  });
  const events: PollEvent[] = [];
  await engine.start(scopeA, 'wyr', ['1min'], { onEvent: async (e) => { events.push(e); } });
  const poll = events.find((e) => e.poll)!;
  // Bind the poll key (this is what the send layer reports back).
  engine.attachPollKey(scopeA, poll.gameId, poll.questionId!, { id: 'poll-wyr-1' });

  const secret = poll.poll!.messageSecret!;
  const v1 = await makeVote('poll-wyr-1', secret, p1, 'Rich');
  const v2 = await makeVote('poll-wyr-1', secret, p2, 'Famous');
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-wyr-1', voterJid: p1, vote: v1, meId });
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-wyr-1', voterJid: p2, vote: v2, meId });

  const game = engine.getGame(scopeA, 'wyr')!;
  assert.deepEqual(game.questions[0]!.votes, {
    [p1.toLowerCase()]: 0,
    [p2.toLowerCase()]: 1,
  });

  game.endsAt = Date.now() - 1;
  await engine.expireNow(scopeA);
  const resultTexts = events.filter((e) => !e.poll).map((e) => e.text ?? '');
  assert.ok(resultTexts.some((t) => t.includes('RESULTS')), 'result emitted');
  assert.ok(resultTexts.some((t) => /Rich.*1 vote|1 vote.*Rich/.test(t)), 'Rich has 1 vote');
  assert.ok(resultTexts.some((t) => /Famous.*1 vote|1 vote.*Famous/.test(t)), 'Famous has 1 vote');
  const tableEvents = events.filter((e) => e.nativeTable);
  assert.ok(tableEvents.some((e) => e.nativeTable?.title === '🏆 WYR RESULTS'), 'native choice table emitted');
  assert.ok(tableEvents.some((e) => e.nativeTable?.title === '🏆 WYR FINAL PARTICIPATION'), 'native participation table emitted');
  assert.ok(!engine.hasActive(scopeA, 'wyr'), 'game cleaned up after expiry');
  engine.dispose();
});

test('votes encrypted with the RAW device-suffixed creator JID still decrypt (permutation fallback)', async () => {
  // Multi-device accounts: creds.me.id carries a :N device suffix (e.g.
  // "2250508934077:3@s.whatsapp.net") and the voter's client encrypts with
  // THAT exact JID. The decrypt layer must fall back from the device-stripped
  // form to the raw form (and @lid variants) — GCM auth picks the right one.
  const engine = createPollGameEngine({
    ai: makeAi({ question: 'q', optionA: 'Fly', optionB: 'Swim' }, { questions: [] }),
  });
  const events: PollEvent[] = [];
  await engine.start(scopeA, 'wyr', ['1min'], { onEvent: async (e) => { events.push(e); } });
  const poll = events.find((e) => e.poll)!;
  engine.attachPollKey(scopeA, poll.gameId, poll.questionId!, { id: 'poll-dev-suffix' });
  const secret = poll.poll!.messageSecret!;
  const rawMeId = `${meId.split('@')[0]}:3@s.whatsapp.net`;
  const vote = await makeVote('poll-dev-suffix', secret, p1, 'Fly', rawMeId);
  await engine.handleVote({
    scope: scopeA,
    pollMsgId: 'poll-dev-suffix',
    voterJid: p1,
    vote,
    meId: rawMeId,
    meLid: '130808262201350:3@lid',
  });
  const game = engine.getGame(scopeA, 'wyr')!;
  assert.deepEqual(game.questions[0]!.votes, { [p1.toLowerCase()]: 0 }, 'raw-meId vote decrypts via fallback');
  engine.dispose();
});

test('vote security: unknown poll, expired poll, and malformed votes are ignored', async () => {
  const engine = createPollGameEngine({
    ai: makeAi({ question: 'q1', optionA: 'a', optionB: 'b' }, { questions: [] }),
  });
  await engine.start(scopeA, 'wyr', [], { onEvent: async () => undefined });
  const game = engine.getGame(scopeA, 'wyr')!;
  const poll = game.questions[0]!;
  const secret = Buffer.from(poll.messageSecret!, 'base64');

  // 1. Unknown poll id → ignored.
  const unknownVote = await makeVote('poll-unknown', secret, p1, 'a');
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-unknown', voterJid: p1, vote: unknownVote, meId });
  assert.deepEqual(poll.votes, {}, 'unknown poll vote must not be counted');

  // 2. Missing poll binding (no attachPollKey) → still ignored (secret registry empty).
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-wyr-2', voterJid: p1, vote: await makeVote('poll-wyr-2', secret, p1, 'a'), meId });
  assert.deepEqual(poll.votes, {}, 'unbound poll vote must not be counted');

  // 3. Bind, then feed a valid vote; then expire; then a late vote must be ignored.
  engine.attachPollKey(scopeA, game.id, 'q0', { id: 'poll-wyr-3' });
  const valid = await makeVote('poll-wyr-3', secret, p1, 'a');
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-wyr-3', voterJid: p1, vote: valid, meId });
  assert.equal(Object.keys(poll.votes).length, 1, 'bound valid vote counts');

  await engine.expireNow(scopeA);
  const late = await makeVote('poll-wyr-3', secret, p2, 'b');
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-wyr-3', voterJid: p2, vote: late, meId });
  assert.equal(poll.votes[p2.toLowerCase()], undefined, 'late vote after expiry must be ignored');
  engine.dispose();
});

test('vote security: a vote from another group never counts', async () => {
  const engine = createPollGameEngine({
    ai: makeAi({ question: 'q1', optionA: 'a', optionB: 'b' }, { questions: [] }),
  });
  await engine.start(scopeA, 'wyr', [], { onEvent: async () => undefined });
  const game = engine.getGame(scopeA, 'wyr')!;
  const poll = game.questions[0]!;
  const secret = Buffer.from(poll.messageSecret!, 'base64');

  // Attach the poll key in group A, then attempt the vote from scope B.
  engine.attachPollKey(scopeA, game.id, 'q0', { id: 'poll-wyr-4' });
  const vote = await makeVote('poll-wyr-4', secret, p1, 'a');
  await engine.handleVote({ scope: scopeB, pollMsgId: 'poll-wyr-4', voterJid: p1, vote, meId });
  assert.deepEqual(poll.votes, {}, 'cross-group vote must be ignored');
  engine.dispose();
});

test('games in different groups run independently (isolation)', async () => {
  const engine = createPollGameEngine({
    ai: makeAi({ question: 'qA', optionA: 'a', optionB: 'b' }, { questions: [] }),
  });
  const eventsA: PollEvent[] = [];
  const eventsB: PollEvent[] = [];
  const a = await engine.start(scopeA, 'wyr', [], { onEvent: async (e) => eventsA.push(e) });
  const b = await engine.start(scopeB, 'wyr', [], { onEvent: async (e) => eventsB.push(e) });
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0]!.gameId, b[0]!.gameId);
  assert.ok(engine.hasActive(scopeA, 'wyr'));
  assert.ok(engine.hasActive(scopeB, 'wyr'));

  // Vote in A must not affect B.
  const pollA = eventsA.find((e) => e.poll)!;
  const pollB = eventsB.find((e) => e.poll)!;
  engine.attachPollKey(scopeA, pollA.gameId, pollA.questionId!, { id: 'poll-a' });
  engine.attachPollKey(scopeB, pollB.gameId, pollB.questionId!, { id: 'poll-b' });
  const secretA = pollA.poll!.messageSecret!;
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-a', voterJid: p1, vote: await makeVote('poll-a', secretA, p1, 'a'), meId });
  assert.equal(Object.keys(engine.getGame(scopeA, 'wyr')!.questions[0]!.votes).length, 1);
  assert.deepEqual(engine.getGame(scopeB, 'wyr')!.questions[0]!.votes, {}, 'group B unaffected');

  // Expire the total game window, not merely the current 60-second poll.
  // The centralized scheduler should advance A while its game is still live;
  // forcing endsAt past now makes this assertion exercise final cleanup while
  // proving group B remains independent.
  engine.getGame(scopeA, 'wyr')!.endsAt = Date.now() - 1;
  await engine.expireNow(scopeA);
  assert.ok(!engine.hasActive(scopeA, 'wyr'));
  assert.ok(engine.hasActive(scopeB, 'wyr'), 'group B game survives A cleanup');
  engine.dispose();
});

test('same-type duplicate games are rejected in one group but different types can coexist', async () => {
  const engine = createPollGameEngine({
    ai: makeAi(
      { question: 'wyr-q', optionA: 'a', optionB: 'b' },
      { questions: [{ question: 'Quiz q', options: ['a', 'b', 'c', 'd'], correctIndex: 0, explanation: 'e', category: 'General Knowledge', difficulty: 'easy' }] }
    ),
  });
  const first = await engine.start(scopeA, 'wyr', [], { onEvent: async () => undefined });
  assert.equal(first.length, 1);
  const dup = await engine.start(scopeA, 'wyr', [], { onEvent: async () => undefined });
  assert.match(dup[0]?.text ?? '', /already active/);
  // A quiz can still start alongside the WYR in the same group.
  const quiz = await engine.start(scopeA, 'quiz', ['5min'], { onEvent: async () => undefined });
  assert.equal(quiz[0]?.poll?.name, 'Quiz q');
  assert.ok(engine.hasActive(scopeA, 'wyr'));
  assert.ok(engine.hasActive(scopeA, 'quiz'));
  engine.dispose();
});

test('quiz: centralized schedule keeps a 60-second interval separate from game duration', async () => {
  const { computeQuizSchedule } = await import('../src/whatsapp/games/poll-engine/index.js');
  assert.deepEqual(computeQuizSchedule(15 * 60_000), { questionMs: 60_000, questionCount: 15 });
  assert.deepEqual(computeQuizSchedule(5 * 60_000), { questionMs: 60_000, questionCount: 5 });
  assert.deepEqual(computeQuizSchedule(60 * 60_000), { questionMs: 60_000, questionCount: 60 });
  const engine = createPollGameEngine({ ai: makeAi({ question: 'q', optionA: 'a', optionB: 'b' }, { questions: [] }) });
  const events = await engine.start(scopeA, 'quiz', ['30s'], { onEvent: async () => undefined });
  assert.equal(events.filter((e) => e.poll).length, 0);
  assert.match(events.map((e) => e.text ?? '').join('\n'), /Usage: .quiz/);
  engine.dispose();
});

test('quiz: full flow — questions, reveal, leaderboard, final winner, cleanup', async () => {
  const bank = [
    { question: 'Capital of France?', options: ['London', 'Paris', 'Rome', 'Berlin'], correctIndex: 1, explanation: 'Paris is the capital.', category: 'Geography', difficulty: 'easy' },
    { question: '2 + 2?', options: ['3', '4', '5', '6'], correctIndex: 1, explanation: 'Basic math.', category: 'Mathematics', difficulty: 'easy' },
    { question: 'Largest ocean?', options: ['Atlantic', 'Indian', 'Pacific', 'Arctic'], correctIndex: 2, explanation: 'Pacific.', category: 'Geography', difficulty: 'medium' },
  ];
  const engine = createPollGameEngine({
    ai: makeAi({ question: 'x', optionA: 'a', optionB: 'b' }, { questions: bank }),
  });
  const events: PollEvent[] = [];
  await engine.start(scopeA, 'quiz', ['3min'], { onEvent: async (e) => { events.push(e); } });

  // Question 1 open.
  const game1 = engine.getGame(scopeA, 'quiz')!;
  assert.equal(game1.questions.length, 1);
  const q1 = game1.questions[0]!;
  assert.ok(q1.correctIndex !== undefined);
  // The correct answer (✅ marker / explanation) must not be exposed before
  // expiry. (The option label "Paris" itself is naturally visible in the
  // question — only the ANSWER DESIGNATION must stay hidden.)
  const openTexts = events.filter((e) => e.text && !e.nativeTable).map((e) => e.text!);
  assert.ok(!openTexts.join('\n').includes('✅'), 'correct-answer marker not exposed before expiry');
  assert.ok(!openTexts.join('\n').includes('Paris is the capital.'), 'explanation not exposed before expiry');

  // Vote correctly for Q1 (Paris = index 1).
  const secret1 = Buffer.from(q1.messageSecret!, 'base64');
  engine.attachPollKey(scopeA, game1.id, 'q0', { id: 'poll-q1' });
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-q1', voterJid: p1, vote: await makeVote('poll-q1', secret1, p1, 'Paris'), meId });
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-q1', voterJid: p2, vote: await makeVote('poll-q1', secret1, p2, 'Rome'), meId });

  await engine.expireNow(scopeA);
  const afterQ1 = engine.getGame(scopeA, 'quiz')!;
  assert.equal(afterQ1.players[p1.toLowerCase()]?.score, 1, 'p1 scores on Q1');
  assert.equal(afterQ1.players[p2.toLowerCase()]?.score, 0, 'p2 does not score on Q1');
  // Reveal text contains the answer + explanation.
  assert.ok(events.some((e) => /✅ Correct.*Paris/.test(e.text ?? '')), 'answer revealed after expiry');
  assert.ok(events.some((e) => (e.text ?? '').includes('Paris is the capital.')), 'explanation revealed');
  // Leaderboard table emitted after Q1.
  assert.ok(events.some((e) => e.nativeTable?.title === '🏆 QUIZ LEADERBOARD'), 'leaderboard after Q1');
  // Q2 opens (total question count is 3).
  assert.equal(afterQ1.questions.length, 2, 'Q2 created');

  // Fast-forward through Q2 and Q3 (answer Q3 correctly for p1 → p1 wins).
  await engine.expireNow(scopeA);
  const game3 = engine.getGame(scopeA, 'quiz')!;
  assert.equal(game3.questions.length, 3, 'all three questions created');
  const q3 = game3.questions[2]!;
  const secret3 = Buffer.from(q3.messageSecret!, 'base64');
  engine.attachPollKey(scopeA, game3.id, 'q2', { id: 'poll-q3' });
  await engine.handleVote({ scope: scopeA, pollMsgId: 'poll-q3', voterJid: p1, vote: await makeVote('poll-q3', secret3, p1, 'Pacific'), meId });
  engine.getGame(scopeA, 'quiz')!.endsAt = Date.now() - 1;
  await engine.expireNow(scopeA);

  assert.ok(events.some((e) => e.nativeTable?.title === '🏆 QUIZ FINAL RESULT'), 'final result table');
  const finalTexts = events.map((e) => e.text ?? '').join('\n');
  assert.match(finalTexts, /🏆 Winner/);
  assert.ok(!engine.hasActive(scopeA, 'quiz'), 'quiz cleaned up');
  engine.dispose();
});

test('persistence: snapshots survive dispose/restore with re-armed timers and secrets', async () => {
  const ai = makeAi({ question: 'persist-q', optionA: 'a', optionB: 'b' }, { questions: [] });
  const snapshots: Record<string, unknown> = {};
  const engine = createPollGameEngine({
    ai,
    persist: (snap) => { snapshots[`${snap.type}`] = { ...snap, questions: snap.questions.map((q) => ({ ...q, votes: { ...q.votes } })) }; },
  });
  const events = await engine.start(scopeA, 'wyr', [], { onEvent: async () => undefined });
  // The persist hook fires on state changes — in production it is triggered
  // right after the poll send returns its message key (attachPollKey).
  const poll = events.find((e) => e.poll)!;
  engine.attachPollKey(scopeA, poll.gameId, poll.questionId!, { id: 'poll-persist' });
  const snap = snapshots['wyr'] as { id: string; status: string; questions: Array<{ id: string; pollMsgId?: string; messageSecret?: string; expiresAt: number; status: string }> };
  assert.equal(snap.status, 'active');
  assert.equal(snap.questions[0]!.id, 'q0');

  // Dispose clears the runtime but the snapshot was captured.
  engine.dispose();
  assert.equal(engine.activeCount(), 0);

  // Restore into a fresh engine.
  const engine2 = createPollGameEngine({ ai });
  engine2.restore(snap as never);
  assert.ok(engine2.hasActive(scopeA, 'wyr'));
  const restored = engine2.getGame(scopeA, 'wyr')!;
  assert.equal(restored.questions[0]!.id, 'q0');
  // Restored secret registry enables decryption again.
  const pollId = 'poll-restored';
  const secret = Buffer.from(restored.questions[0]!.messageSecret!, 'base64');
  engine2.attachPollKey(scopeA, restored.id, 'q0', { id: pollId });
  await engine2.handleVote({ scope: scopeA, pollMsgId: pollId, voterJid: p1, vote: await makeVote(pollId, secret, p1, 'a'), meId });
  assert.equal(Object.keys(restored.questions[0]!.votes).length, 1, 'restored game accepts votes');
  engine2.dispose();
});
