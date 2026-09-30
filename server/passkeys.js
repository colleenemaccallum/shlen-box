// Passkeys: Face ID / fingerprint sign-in and the app lock. Only public keys are stored on the server.
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const CHALLENGE_TTL = 5 * 60e3;

export function createPasskeys({ db, rpID, origin, now }) {
  const q = sql => db.prepare(sql);
  const challenges = new Map(); // key -> { challenge, at }

  // Kept small so strangers can't fill memory by asking for sign-in challenges.
  function remember(key, challenge) {
    const t = now().getTime();
    for (const [k, c] of challenges) if (t - c.at >= CHALLENGE_TTL) challenges.delete(k);
    while (challenges.size >= 50) challenges.delete(challenges.keys().next().value);
    challenges.set(key, { challenge, at: t });
  }
  function take(key) {
    const c = challenges.get(key); challenges.delete(key);
    return c && now().getTime() - c.at < CHALLENGE_TTL ? c.challenge : null;
  }

  return {
    hasPasskey: personId => !!q('SELECT 1 FROM credentials WHERE person_id = ?').get(personId),

    async registrationOptions(person) {
      const existing = q('SELECT id, transports FROM credentials WHERE person_id = ?').all(person.id);
      const options = await generateRegistrationOptions({
        rpName: 'Shlen Box', rpID, userName: person.name, userDisplayName: person.name,
        userID: new TextEncoder().encode(`shlen-${person.id}`),
        attestationType: 'none',
        excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      });
      remember(`reg:${person.id}`, options.challenge);
      return options;
    },

    async register(person, response) {
      const expectedChallenge = take(`reg:${person.id}`);
      if (!expectedChallenge) return false;
      const v = await verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true });
      if (!v.verified) return false;
      const c = v.registrationInfo.credential;
      q('INSERT INTO credentials (id, person_id, public_key, counter, transports, created) VALUES (?, ?, ?, ?, ?, ?)')
        .run(c.id, person.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports || []), now().toISOString());
      return true;
    },

    // key identifies the waiting browser (a random id kept in memory on the phone).
    async authenticationOptions(key) {
      const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
      remember(`auth:${key}`, options.challenge);
      return options;
    },

    // Returns the person id on success, or null.
    async authenticate(key, response, onlyPersonId) {
      const expectedChallenge = take(`auth:${key}`);
      if (!expectedChallenge || typeof response?.id !== 'string') return null;
      const cred = q('SELECT * FROM credentials WHERE id = ?').get(response.id);
      if (!cred || (onlyPersonId && cred.person_id !== onlyPersonId)) return null;
      const v = await verifyAuthenticationResponse({
        response, expectedChallenge, expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: JSON.parse(cred.transports || '[]') },
      });
      if (!v.verified) return null;
      q('UPDATE credentials SET counter = ? WHERE id = ?').run(v.authenticationInfo.newCounter, cred.id);
      return cred.person_id;
    },
  };
}
