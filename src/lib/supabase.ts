import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

let client: SupabaseClient | null = null;

// Cliente de invite/recovery, con la configuración de siempre. Se crea al usarlo
// y no al importar el módulo: así no captura (ni guarda) las sesiones de los
// enlaces de signup y activación, que usan el cliente efímero.
export function getSupabase(): SupabaseClient {
  return (client ??= createClient(supabaseUrl, supabaseAnonKey));
}

// Sesión solo en memoria, sin autorefresco ni lectura automática de la URL.
export function createEphemeralSupabase(): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
