// Small browser helpers for passkeys (Face ID / fingerprint), so the app needs no outside script.
const b64u = {
  toBuf: s => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)).buffer; },
  from: buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
};

export const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials);

export async function createPasskey(o) {
  const cred = await navigator.credentials.create({ publicKey: {
    ...o, challenge: b64u.toBuf(o.challenge), user: { ...o.user, id: b64u.toBuf(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map(c => ({ ...c, id: b64u.toBuf(c.id) })),
  } });
  const r = cred.response;
  return { id: cred.id, rawId: b64u.from(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: b64u.from(r.clientDataJSON), attestationObject: b64u.from(r.attestationObject),
      transports: r.getTransports ? r.getTransports() : [] } };
}

export async function usePasskey(o) {
  const cred = await navigator.credentials.get({ publicKey: {
    ...o, challenge: b64u.toBuf(o.challenge),
    allowCredentials: (o.allowCredentials || []).map(c => ({ ...c, id: b64u.toBuf(c.id) })),
  } });
  const r = cred.response;
  return { id: cred.id, rawId: b64u.from(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults(),
    authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: b64u.from(r.clientDataJSON), authenticatorData: b64u.from(r.authenticatorData),
      signature: b64u.from(r.signature), userHandle: r.userHandle ? b64u.from(r.userHandle) : undefined } };
}

export function urlB64ToUint8(s) { return new Uint8Array(b64u.toBuf(s)); }
