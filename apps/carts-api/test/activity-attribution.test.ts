import { describe, expect, test } from 'vitest';
import type { PoppySession } from '@auth0/auth0-api-js';
import { attribute } from '../src/activity.js';

const guest: PoppySession = {
  state: 'signed_out',
  source: 'header',
  key: 'verified-session-key',
  sessionId: 'trip-one',
  userId: 'not-an-auth0-user',
  agent: { id: 'https://poppyplayground.dev/agent.json' },
};

describe('audit attribution uses only verified caller data', () => {
  test('agent guest has no account, even with an anonymous browser token', () => {
    const act = { sub: 'agt_playground', client_id: 'tpc_playground' };
    const browser = attribute({
      poppy: { ...guest, source: 'token', agent: { id: act.sub } },
      claims: { sub: 'anon_poppy@guest', act },
      cartKey: guest.key,
      account: null,
    });
    expect(browser).toMatchObject({
      actorType: 'guest_agent', poppySid: guest.sessionId, sessionKey: guest.key,
      actorSub: act.sub, actorClientId: act.client_id,
    });
    expect(browser.account).toBeUndefined();
    const direct = attribute({ poppy: guest, account: null, cartKey: guest.key });
    expect(direct).toMatchObject({ actorType: 'guest_agent', agent: guest.agent.id, poppySid: guest.sessionId });
    expect(direct.actorSub).toBeUndefined();
    expect(direct.actorClientId).toBe(guest.agent.id);
  });

  test('same session becomes a user-agent action after consent; a human stays separate', () => {
    const account = 'auth0|demo';
    expect(attribute({ poppy: { ...guest, state: 'signed_in' }, account, cartKey: guest.key })).toMatchObject({
      actorType: 'user_agent', account, sessionKey: guest.key,
    });
    expect(attribute({ account, cartKey: 'user:demo' })).toEqual({ caller: 'person', actorType: 'user', account });
  });

  test('unverified requests and anonymous people never acquire an account or an agent identity', () => {
    expect(attribute()).toEqual({ caller: 'unverified' });
    expect(attribute({ account: null, cartKey: 'guest:demo', claims: { sub: 'anon@demo' } })).toEqual({ caller: 'guest' });
  });
});
