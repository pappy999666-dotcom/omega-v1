import assert from 'node:assert/strict';
import test from 'node:test';
import { GameManager } from '../src/whatsapp/games/engine.js';

const scope = { sessionId: 'session-a', chatJid: '123@g.us' };
const p1 = '1111111111@s.whatsapp.net';
const p2 = '2222222222@s.whatsapp.net';
const p3 = '3333333333@s.whatsapp.net';

async function setupWcg(randomLetter = 'C', onEvent?: (event: { text: string }) => void): Promise<GameManager> {
  // randomNumber close to 1 makes the one-time lobby shuffle an identity, so the
  // queue keeps join order and turn assertions stay deterministic.
  const manager = new GameManager({
    joiningMs: 100_000,
    turnMs: 100_000,
    randomLetter: () => randomLetter,
    randomNumber: () => 0.9999,
    onEvent,
  });
  await manager.handle({ scope, playerJid: p1, kind: 'wcg', canStart: true });
  await manager.handle({ scope, playerJid: p1, kind: 'join' });
  await manager.handle({ scope, playerJid: p2, kind: 'join' });
  return manager;
}

test('WCG lobby is scoped, rejects duplicate joins, and starts at the timer boundary', async () => {
  const events: string[] = [];
  const manager = new GameManager({
    joiningMs: 15,
    turnMs: 1000,
    randomLetter: () => 'C',
    onEvent: (event) => events.push(event.text),
  });

  const lobby = await manager.handle({ scope, playerJid: p1, kind: 'wcg', canStart: true });
  assert.ok(lobby);
  assert.match(lobby.text, /Players: 0/);
  assert.match(lobby.text, /𝗢𝗠𝗘𝗚𝗔 • 𝗩𝟭/);
  assert.equal((await manager.handle({ scope, playerJid: p1, kind: 'join' }))?.text.includes('already'), false);
  assert.equal((await manager.handle({ scope, playerJid: p2, kind: 'join' }))?.mentions.length, 2);
  assert.match((await manager.handle({ scope, playerJid: p2, kind: 'join' }))?.text ?? '', /already/);

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(events.some((text) => text.includes('Next Turn')), true);
  manager.dispose();
});

test('WCG hard mode requires the full set of words and rejects invalid, duplicate and reused words', async () => {
  const events: string[] = [];
  const manager = await setupWcg('C', (event) => events.push(event.text));
  await manager.startNow(scope);

  // Wrong player is ignored completely.
  assert.equal(await manager.handle({ scope, playerJid: p2, kind: 'text', text: 'cat code car' }), undefined);

  // Partial set: incomplete, turn stays with the same player.
  const partial = await manager.handle({ scope, playerJid: p1, kind: 'text', text: 'cat' });
  assert.match(partial?.text ?? '', /Words accepted this turn: 1\/3/);

  // A duplicate word inside the same submission is rejected and cannot complete
  // the requirement by itself (only one of the three 'code' entries counts).
  const dupInTurn = await manager.handle({ scope, playerJid: p1, kind: 'text', text: 'code code code' });
  assert.match(dupInTurn?.text ?? '', /Rejected: code/);
  assert.match(dupInTurn?.text ?? '', /Words accepted this turn: 2\/3/);

  // Invalid words (wrong letter, non-word) never count and never advance.
  const invalid = await manager.handle({ scope, playerJid: p1, kind: 'text', text: 'apple zzzzz' });
  assert.match(invalid?.text ?? '', /Rejected: apple, zzzzz/);
  assert.match(invalid?.text ?? '', /Words accepted this turn: 2\/3/);

  // Completing the turn advances deterministically to player 2. The score
  // confirmation is delivered as an event, then the next turn is announced.
  const success = await manager.handle({ scope, playerJid: p1, kind: 'text', text: 'car' });
  assert.equal(success, undefined);
  assert.equal(events.some((text) => text.includes('scored 3 points')), true);

  // A word used by player 1 cannot be reused by player 2.
  const reused = await manager.handle({ scope, playerJid: p2, kind: 'text', text: 'cow cat car' });
  assert.match(reused?.text ?? '', /Rejected: cat, car/);
  assert.match(reused?.text ?? '', /Words accepted this turn: 1\/3/);

  assert.equal(manager.activeCount(), 1);
  manager.dispose();
});

test('WCG eliminates on timeout, uses the stable queue, and announces the winner', async () => {
  const events: string[] = [];
  const manager = new GameManager({
    joiningMs: 100_000,
    turnMs: 100_000,
    randomLetter: () => 'C',
    randomNumber: () => 0.9999,
    onEvent: (event) => events.push(event.text),
  });
  await manager.handle({ scope, playerJid: p1, kind: 'wcg', canStart: true });
  await manager.handle({ scope, playerJid: p1, kind: 'join' });
  await manager.handle({ scope, playerJid: p2, kind: 'join' });
  await manager.startNow(scope);

  // Player 1 times out → eliminated → player 2 wins immediately.
  manager.expireNow(scope);
  assert.equal(events.some((text) => text.includes('Player eliminated')), true);
  assert.equal(events.some((text) => text.includes('Victorious')), true);
  assert.equal(manager.activeCount(), 0);
  manager.dispose();
});

test('WCG stable queue keeps order across eliminations with three players', async () => {
  const events: string[] = [];
  const manager = new GameManager({
    joiningMs: 100_000,
    turnMs: 100_000,
    randomLetter: () => 'C',
    randomNumber: () => 0.9999,
    onEvent: (event) => events.push(event.text),
  });
  await manager.handle({ scope, playerJid: p1, kind: 'wcg', canStart: true });
  for (const player of [p1, p2, p3]) await manager.handle({ scope, playerJid: player, kind: 'join' });
  await manager.startNow(scope);

  // p1 answers fully → p2 (queue order) is next.
  await manager.handle({ scope, playerJid: p1, kind: 'text', text: 'cat code car' });
  const nextAfterP1 = events.filter((text) => text.includes('Next Turn')).at(-1);
  assert.match(nextAfterP1 ?? '', /@2222222222/);

  // p2 times out → eliminated → p3 is next (skipping p2).
  manager.expireNow(scope);
  const nextAfterP2 = events.filter((text) => text.includes('Next Turn')).at(-1);
  assert.match(nextAfterP2 ?? '', /@3333333333/);

  manager.dispose();
});

test('games in different chats remain isolated', async () => {
  const manager = new GameManager({ joiningMs: 100000 });
  const otherScope = { sessionId: scope.sessionId, chatJid: '456@g.us' };
  const first = await manager.handle({ scope, playerJid: p1, kind: 'wcg', canStart: true });
  const second = await manager.handle({ scope: otherScope, playerJid: p1, kind: 'wcg', canStart: true });
  assert.ok(first && second);
  assert.notEqual(first.gameId, second.gameId);
  manager.dispose();
});

test('TTT enforces challenge acceptance, turns, occupied cells, win, and cleanup', async () => {
  const manager = new GameManager({ challengeMs: 1000, turnMs: 1000 });
  const challenge = await manager.handle({ scope, playerJid: p1, kind: 'ttt', targetJid: p2, canStart: true });
  assert.ok(challenge);
  assert.match(challenge.text, /challenged/);
  assert.equal(await manager.handle({ scope, playerJid: p3, kind: 'ttt', args: ['accept'] }), undefined);
  assert.match((await manager.handle({ scope, playerJid: p2, kind: 'ttt', args: ['accept'] }))?.text ?? '', /Turn/);
  assert.match((await manager.handle({ scope, playerJid: p1, kind: 'ttt', args: ['A1'] }))?.text ?? '', /Turn/);
  assert.match((await manager.handle({ scope, playerJid: p2, kind: 'ttt', args: ['A1'] }))?.text ?? '', /occupied/);
  await manager.handle({ scope, playerJid: p2, kind: 'ttt', args: ['B1'] });
  await manager.handle({ scope, playerJid: p1, kind: 'ttt', args: ['A2'] });
  await manager.handle({ scope, playerJid: p2, kind: 'ttt', args: ['B2'] });
  const win = await manager.handle({ scope, playerJid: p1, kind: 'ttt', args: ['A3'] });
  assert.match(win?.text ?? '', /Winner/);
  assert.equal(manager.activeCount(), 0);
});

test('TTT decline, give-up, draw and timeout clean up sessions', async () => {
  const declineManager = new GameManager({ challengeMs: 1000 });
  await declineManager.handle({ scope, playerJid: p1, kind: 'ttt', targetJid: p2, canStart: true });
  assert.match((await declineManager.handle({ scope, playerJid: p2, kind: 'ttt', args: ['decline'] }))?.text ?? '', /declined/);
  assert.equal(declineManager.activeCount(), 0);

  const giveUpManager = new GameManager({ challengeMs: 1000, turnMs: 1000 });
  await giveUpManager.handle({ scope, playerJid: p1, kind: 'ttt', targetJid: p2, canStart: true });
  await giveUpManager.handle({ scope, playerJid: p2, kind: 'ttt', args: ['accept'] });
  assert.match((await giveUpManager.handle({ scope, playerJid: p1, kind: 'ttt', args: ['giveup'] }))?.text ?? '', /Winner/);
  assert.equal(giveUpManager.activeCount(), 0);

  const timeoutEvents: string[] = [];
  const timeoutManager = new GameManager({ challengeMs: 1000, turnMs: 1000, onEvent: (event) => timeoutEvents.push(event.text) });
  await timeoutManager.handle({ scope, playerJid: p1, kind: 'ttt', targetJid: p2, canStart: true });
  await timeoutManager.handle({ scope, playerJid: p2, kind: 'ttt', args: ['accept'] });
  timeoutManager.expireNow(scope);
  assert.equal(timeoutEvents.some((text) => text.includes('Time expired')), true);
  assert.equal(timeoutManager.activeCount(), 0);

  const drawManager = new GameManager({ challengeMs: 1000, turnMs: 1000 });
  await drawManager.handle({ scope, playerJid: p1, kind: 'ttt', targetJid: p2, canStart: true });
  await drawManager.handle({ scope, playerJid: p2, kind: 'ttt', args: ['accept'] });
  for (const [player, move] of [[p1, 'A1'], [p2, 'A2'], [p1, 'A3'], [p2, 'B2'], [p1, 'B1'], [p2, 'B3'], [p1, 'C2'], [p2, 'C1'], [p1, 'C3']] as const) {
    await drawManager.handle({ scope, playerJid: player, kind: 'ttt', args: [move] });
  }
  assert.equal(drawManager.activeCount(), 0);
});
