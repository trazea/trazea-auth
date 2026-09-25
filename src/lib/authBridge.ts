import type { Session, SupabaseClient } from '@supabase/supabase-js';

// Lógica del puente sin React: qué enlace ha llegado y qué se hace con él.
// Los tokens que llegan en la URL son secretos: aquí no se registran, no se
// guardan fuera de memoria y no aparecen en ningún mensaje de error.

export const ACTIVATION_CHECKOUT_URL = 'https://api.trazea.es/v1/billing/activation-checkout';
const STRIPE_CHECKOUT_HOST = 'checkout.stripe.com';
const API_TIMEOUT_MS = 20_000;
const SIGN_OUT_TIMEOUT_MS = 3_000;

export type Interval = 'month' | 'year';
export type PasswordFlow = 'invite' | 'recovery';

// Lo que trae el enlace para abrir la sesión: la plantilla actual de Supabase
// ({{ .ConfirmationURL }}) redirige con la sesión ya emitida en el hash; una
// plantilla con {{ .TokenHash }} la trae sin verificar en la query.
export type Credentials =
  | { kind: 'session'; access_token: string; refresh_token: string }
  | { kind: 'token_hash'; token_hash: string };

export type Landing =
  | { flow: PasswordFlow; access_token: string; refresh_token: string }
  | { flow: 'signup'; credentials: Credentials }
  | { flow: 'activate'; interval: Interval; credentials: Credentials }
  // Supabase redirige con #error=… cuando el enlace ya se usó o caducó, sin
  // decir de qué tipo era. Solo `next=activate` en la query lo identifica.
  | { flow: 'link-error'; activation: boolean }
  | { flow: 'invalid'; activation: boolean };

export function parseHash(hash: string): Record<string, string> {
  return Object.fromEntries(
    hash
      .split('&')
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), decodeURIComponent(p.slice(i + 1))];
      })
  );
}

function single(query: URLSearchParams, key: string): string | null {
  const values = query.getAll(key);
  return values.length === 1 ? values[0] : null;
}

export function parseLanding(href: string): Landing {
  let url: URL;
  let hash: Record<string, string>;
  try {
    url = new URL(href);
    hash = parseHash(url.hash.slice(1));
  } catch {
    return { flow: 'invalid', activation: false };
  }
  const query = url.searchParams;
  // `next` es una etiqueta, nunca un destino: solo se compara con un literal.
  const wantsActivation = single(query, 'next') === 'activate';

  if (hash.error || hash.error_code || hash.error_description) {
    return { flow: 'link-error', activation: wantsActivation };
  }

  let type: string | undefined;
  let credentials: Credentials | undefined;
  if (hash.access_token && hash.refresh_token) {
    type = hash.type;
    credentials = {
      kind: 'session',
      access_token: hash.access_token,
      refresh_token: hash.refresh_token,
    };
  } else {
    const tokenHash = single(query, 'token_hash');
    if (tokenHash) {
      type = single(query, 'type') ?? undefined;
      credentials = { kind: 'token_hash', token_hash: tokenHash };
    }
  }

  if (!credentials) return { flow: 'invalid', activation: wantsActivation };

  if ((type === 'invite' || type === 'recovery') && credentials.kind === 'session') {
    return {
      flow: type,
      access_token: credentials.access_token,
      refresh_token: credentials.refresh_token,
    };
  }

  if (type === 'signup') return { flow: 'signup', credentials };

  if (type === 'magiclink') {
    // Un magiclink solo se acepta para activar, y con un intervalo conocido.
    if (!wantsActivation) return { flow: 'invalid', activation: false };
    const interval = single(query, 'interval');
    if (interval !== 'month' && interval !== 'year') {
      return { flow: 'invalid', activation: true };
    }
    return { flow: 'activate', interval, credentials };
  }

  return { flow: 'invalid', activation: wantsActivation };
}

// ---------------------------------------------------------------------------
// Sesión temporal (signup y activación)

export type BridgeAuth = Pick<SupabaseClient['auth'], 'setSession' | 'verifyOtp' | 'signOut'>;

async function openSession(
  auth: BridgeAuth,
  credentials: Credentials,
  type: 'signup' | 'magiclink'
): Promise<Session | null> {
  try {
    const { data, error } =
      credentials.kind === 'session'
        ? // setSession valida el access token contra /user antes de aceptarlo.
          await auth.setSession({
            access_token: credentials.access_token,
            refresh_token: credentials.refresh_token,
          })
        : await auth.verifyOtp({ token_hash: credentials.token_hash, type });
    if (error || !data.session) return null;
    return data.session;
  } catch {
    return null;
  }
}

// Cierra solo esta sesión (scope local): `global` también cerraría la del móvil.
// Nunca bloquea: si Supabase no responde, se sigue adelante.
export async function closeSession(auth: BridgeAuth): Promise<void> {
  try {
    await Promise.race([
      auth.signOut({ scope: 'local' }),
      new Promise((resolve) => setTimeout(resolve, SIGN_OUT_TIMEOUT_MS)),
    ]);
  } catch {
    // La sesión solo vivía en memoria; no hay nada más que limpiar.
  }
}

export async function confirmSignup(auth: BridgeAuth, credentials: Credentials): Promise<boolean> {
  const session = await openSession(auth, credentials, 'signup');
  if (!session) return false;
  const confirmed = Boolean(session.user?.email_confirmed_at);
  await closeSession(auth);
  return confirmed;
}

// ---------------------------------------------------------------------------
// Activación

export type ActivationError =
  | 'link'
  | 'forbidden'
  | 'pending-deletion'
  | 'not-trial'
  | 'rate-limited'
  | 'unavailable';

export function stripeCheckoutUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== STRIPE_CHECKOUT_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    return null;
  }
  return url.href;
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function describeApiFailure(status: number, errorCode: unknown): ActivationError {
  if (status === 403 && errorCode === 'AccountPendingDeletion') return 'pending-deletion';
  if (status === 403) return 'forbidden';
  if (status === 409 && errorCode === 'NotATrial') return 'not-trial';
  if (status === 429) return 'rate-limited';
  return 'unavailable';
}

async function requestCheckout(
  fetchFn: typeof fetch,
  accessToken: string,
  interval: Interval
): Promise<{ url: string } | { error: ActivationError }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const res = await fetchFn(ACTIVATION_CHECKOUT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ interval }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await readJson(res);
    if (!res.ok) return { error: describeApiFailure(res.status, body?.error_code) };
    const url = stripeCheckoutUrl(body?.url);
    return url ? { url } : { error: 'unavailable' };
  } catch {
    return { error: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verifica el enlace, pide el Checkout con el JWT de esa sesión, cierra la
 * sesión y solo entonces navega. El orden importa: el JWT no se revoca hasta
 * que la API ha respondido, y la navegación no espera más de lo necesario.
 */
export async function startActivation(
  auth: BridgeAuth,
  credentials: Credentials,
  interval: Interval,
  fetchFn: typeof fetch,
  navigate: (url: string) => void
): Promise<{ ok: true } | { ok: false; error: ActivationError }> {
  const session = await openSession(auth, credentials, 'magiclink');
  if (!session) return { ok: false, error: 'link' };

  const result = await requestCheckout(fetchFn, session.access_token, interval);
  await closeSession(auth);

  if ('error' in result) return { ok: false, error: result.error };
  navigate(result.url);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Orquestación de una carga de página

export type Outcome =
  | { view: 'form'; flow: PasswordFlow }
  | { view: 'password-link-expired'; flow: PasswordFlow }
  | { view: 'invalid'; activation: boolean }
  | { view: 'link-error'; activation: boolean }
  | { view: 'signup-confirmed' }
  | { view: 'signup-failed' }
  | { view: 'redirecting' }
  | { view: 'activation-failed'; error: ActivationError };

export interface BridgeEnv {
  href: string;
  // Quita de la barra de direcciones los datos del enlace.
  clearUrl: () => void;
  // Cliente persistente de invite/recovery (updateUser necesita la sesión).
  passwordAuth: () => Pick<SupabaseClient['auth'], 'setSession'>;
  // Cliente en memoria, sin persistencia ni autorefresco, para signup/activación.
  ephemeralAuth: () => BridgeAuth;
  fetch: typeof fetch;
  navigate: (url: string) => void;
}

async function run(env: BridgeEnv): Promise<Outcome> {
  const landing = parseLanding(env.href);

  switch (landing.flow) {
    case 'invite':
    case 'recovery': {
      const { error } = await env.passwordAuth().setSession({
        access_token: landing.access_token,
        refresh_token: landing.refresh_token,
      });
      return error
        ? { view: 'password-link-expired', flow: landing.flow }
        : { view: 'form', flow: landing.flow };
    }
    case 'signup': {
      env.clearUrl();
      const ok = await confirmSignup(env.ephemeralAuth(), landing.credentials);
      return { view: ok ? 'signup-confirmed' : 'signup-failed' };
    }
    case 'activate': {
      // Antes de cualquier espera: una recarga o volver atrás ya no traerá el
      // enlace y no podrá abrir un segundo Checkout.
      env.clearUrl();
      const result = await startActivation(
        env.ephemeralAuth(),
        landing.credentials,
        landing.interval,
        env.fetch,
        env.navigate
      );
      return result.ok ? { view: 'redirecting' } : { view: 'activation-failed', error: result.error };
    }
    case 'link-error':
      return { view: 'link-error', activation: landing.activation };
    case 'invalid':
      // Un enlace rechazado puede traer una sesión válida (p. ej. un magiclink
      // sin next=activate): no se usa, pero tampoco se deja en la URL.
      env.clearUrl();
      return { view: 'invalid', activation: landing.activation };
  }
}

/**
 * Una sola ejecución por carga de página, aunque el efecto se monte dos veces
 * (Strict Mode) o el componente se vuelva a montar: todas las llamadas
 * comparten el mismo resultado.
 */
export function createBridgeRunner(): (env: () => BridgeEnv) => Promise<Outcome> {
  let pending: Promise<Outcome> | null = null;
  return (env) => (pending ??= run(env()));
}
