import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let client: SupabaseClient | null = null;

// auth-js hace console.error del error de un fetch rechazado tal cual, y su
// mensaje o su causa pueden llevar datos de la petición (tokens incluidos).
// Se sustituye por uno genérico: el SDK lo sigue tratando como fallo de red.
const safeFetch: typeof fetch = async (input, init) => {
  try {
    return await globalThis.fetch(input, init);
  } catch {
    throw new TypeError('Failed to fetch');
  }
};

// Cliente de invite/recovery, con la configuración de siempre salvo safeFetch. Se crea al usarlo
// y no al importar el módulo: así no captura (ni guarda) las sesiones de los
// enlaces de signup y activación, que usan el cliente efímero.
export function getSupabase(): SupabaseClient {
  return (client ??= createClient(supabaseUrl, supabaseAnonKey, { global: { fetch: safeFetch } }));
}

// Sesión solo en memoria, sin autorefresco ni lectura automática de la URL.
export function createEphemeralSupabase(): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: safeFetch },
  });
}
