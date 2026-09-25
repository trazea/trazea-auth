# trazea-auth

Puente web entre los emails de Supabase Auth y la app Trazea. Acepta cuatro tipos de enlace y rechaza todo lo demás:

| Enlace | Qué hace |
|---|---|
| `type=invite` / `type=recovery` | Formulario para crear o cambiar la contraseña y botón a `trazea://` |
| `type=signup` | Comprueba el enlace y muestra "Email confirmado, vuelve a la app" con un botón a `trazea://login`. No pide contraseña ni crea negocio |
| `type=magiclink` **solo** con `?next=activate&interval=month\|year` | Pide el Checkout de activación a la API con el JWT de esa sesión y redirige a `https://checkout.stripe.com/…` |

**URL de producción:** `https://auth.trazea.es`

---

## Configuración

Copia `.env.example` a `.env.local` y rellena las variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://XXXXXX.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_xxx
NEXT_PUBLIC_APP_SCHEME=trazea
```

> `NEXT_PUBLIC_SUPABASE_ANON_KEY` es la clave **pública** (anon/publishable). Es seguro incluirla en el frontend.  
> **Nunca** uses `SUPABASE_SERVICE_KEY` aquí.

---

## Desarrollo local

```bash
npm install
npm run dev
npm test      # Vitest: parseo, guardas y flujos con Supabase y fetch simulados
```

---

## Despliegue en Vercel

### 1. Subir a GitHub

```bash
git add .
git commit -m "Convert to Next.js"
git push
```

### 2. Crear/actualizar proyecto en Vercel

1. Ve a [vercel.com](https://vercel.com) → **Add New Project** (o actualiza el existente)
2. Importa el repositorio `trazea-auth`
3. Framework Preset: **Next.js** (auto-detectado)
4. **Variables de entorno**: Añade en Vercel:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_APP_SCHEME`
5. Haz clic en **Deploy**

### 3. Añadir dominio personalizado

1. En Vercel → Settings → Domains → añade `auth.trazea.es`
2. En tu DNS (donde gestiones `trazea.es`) añade:
   ```
   CNAME  auth  cname.vercel-dns.com
   ```
3. Vercel provisionará el certificado TLS automáticamente

---

## Configuración en Supabase

Una vez desplegado en `https://auth.trazea.es`:

**Authentication → URL Configuration:**

| Campo | Valor |
|-------|-------|
| Site URL | `https://auth.trazea.es` |
| Redirect URLs | `trazea://**`, `https://auth.trazea.es/**` |

La activación usa `emailRedirectTo: https://auth.trazea.es/?next=activate&interval=…`. Si Supabase no acepta esa URL, redirige al Site URL sin la query y el puente rechaza el enlace.

**Plantillas de email.** El puente acepta los dos formatos:

- `{{ .ConfirmationURL }}` (el de siempre): Supabase verifica el enlace y redirige con la sesión en el hash (`#access_token=…&refresh_token=…&type=…`). En signup, el email ya queda confirmado **antes** de llegar a esta página.
- Solo para *Confirm signup*, opcionalmente: `{{ .SiteURL }}/?token_hash={{ .TokenHash }}&type=signup`. La página lo verifica con `verifyOtp` y un escáner de enlaces del correo no puede consumirlo solo con abrir la URL.

Si el enlace ya se usó o caducó, Supabase redirige con `#error=…&error_code=otp_expired` y la página lo dice sin mostrar un éxito falso.

## Configuración en trazea-api

El navegador llama a `POST https://api.trazea.es/v1/billing/activation-checkout`: `CORS_ORIGINS` (Render) tiene que incluir `"https://auth.trazea.es"`.

---

## Estructura del proyecto

```
trazea-auth/
├── src/
│   ├── app/           # Next.js App Router
│   │   ├── layout.tsx
│   │   ├── page.tsx   # Página principal
│   │   └── globals.css
│   └── lib/
│       ├── authBridge.ts       # Parseo del enlace, guardas y flujos (sin React)
│       ├── authBridge.test.ts  # npm test
│       └── supabase.ts
├── public/
│   └── logo.svg
├── next.config.ts
├── package.json
└── vercel.json
```

## Flujo de usuario

1. Admin invita a un usuario desde la app → Supabase envía email
2. Usuario hace clic en el enlace → llega a `https://auth.trazea.es/#access_token=...&type=invite`
3. La página establece la sesión con Supabase y muestra el formulario
4. Usuario introduce su contraseña y la guarda
5. Pantalla de éxito con botón **Abrir Trazea** (`trazea://`)

### Activación (trial → pago)

1. En la app, pantalla **Activar** → `signInWithOtp` con `emailRedirectTo: https://auth.trazea.es/?next=activate&interval=month`
2. El enlace del email llega aquí con la sesión en el hash. La página borra la URL antes de nada, así que recargar o volver atrás no abre un segundo Checkout
3. Valida la sesión, llama a `activation-checkout` con `Authorization: Bearer <JWT>` y comprueba que la respuesta es una URL `https://checkout.stripe.com/…`
4. Cierra solo esa sesión web (`signOut({ scope: 'local' })`, nunca `global`, que cerraría también la del móvil) y redirige con `location.replace`
5. Volver de Stripe no demuestra nada: la app consulta `GET /v1/billing/status` (trazea-api `docs/TRIALS.md` §5)
