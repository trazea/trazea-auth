import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// auth-js hace console.error del error de un fetch rechazado tal cual. Con el
// SDK real, ese registro no debe llevar lo que traiga el mensaje del error.
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const AT = `${b64({ alg: 'HS256' })}.${b64({ sub: 'u1', exp: 4102444800 })}.c2lnLVNFQ1JFVA`;

let errorSpy: ReturnType<typeof vi.spyOn>;

function logged() {
  return errorSpy.mock.calls
    .flat()
    .map((arg) =>
      arg instanceof Error
        ? [arg.name, arg.message, arg.stack, String((arg as { cause?: unknown }).cause)].join('\n')
        : String(arg)
    )
    .join('\n');
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://proyecto.supabase.co');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-key');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new TypeError(`fetch failed: Authorization: Bearer ${AT}`, { cause: new Error(AT) });
    })
  );
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('clientes de Supabase: fetch rechazado con un token en el mensaje', () => {
  it.each([
    ['persistente (invite/recovery)', 'getSupabase'],
    ['efímero (signup/activación)', 'createEphemeralSupabase'],
  ] as const)('%s: el log interno del SDK no lleva el token', async (_, factory) => {
    const mod = await import('./supabase');
    const { error } = await mod[factory]().auth.getUser(AT);

    expect(fetch).toHaveBeenCalled();
    // Sigue siendo un fallo de red reintentable…
    expect(error?.name).toBe('AuthRetryableFetchError');
    expect(error?.message).not.toContain(AT);
    // …y el SDK lo registró, pero sin el secreto.
    expect(errorSpy).toHaveBeenCalled();
    expect(logged()).not.toContain(AT);
  });
});
